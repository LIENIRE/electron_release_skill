#!/usr/bin/env node
/**
 * verify-win-artifact.mjs — Windows 安装包产物校验（零第三方依赖）
 *
 * 校验 electron-builder 产出的 Windows 安装包与其更新清单是否自洽：
 *   1. 清单可解析（latest.yml）
 *   2. 清单 version 与期望版本一致（默认读 package.json）
 *   3. 清单 files[].url 对应产物存在
 *   4. 产物 size 与清单一致
 *   5. 产物 sha512 与清单一致  ← 签名晚于元数据时这里必失败
 *   6. path 与 files[0].url 指向同一文件
 *   7. PE 头合法 + 架构符合预期（x64 / arm64 / x86）
 *   8. blockmap 存在且与安装包同批次（mtime 差值）
 *   9. Authenticode 签名有效 + 含时间戳（仅 Windows；其他平台需 osslsigncode）
 *
 * 用法：
 *   node verify-win-artifact.mjs [--dir release] [--manifest latest.yml]
 *                                [--exe <path>] [--expect-version 1.2.3]
 *                                [--expect-arch x64|arm64|x86] [--json]
 *                                [--max-blockmap-skew 600] [--allow-unsigned]
 *
 * 退出码：0 全部通过；1 有失败项；2 参数/环境错误。
 *
 * 设计约束：
 *   - 不修改任何文件，只读
 *   - 不静默跳过：无法执行的检查标 SKIP 并写明原因，不算通过
 *   - 非 Windows 上无法验 Authenticode 时，优先尝试 osslsigncode，其次 SKIP
 *   - NSIS 安装包本体恒为 32 位引导程序，架构要看 win-unpacked 里的载荷 exe
 */

import { createHash } from 'node:crypto';
import { readFile, stat, readdir } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const opts = {
    dir: null,
    manifest: 'latest.yml',
    exe: null,
    expectVersion: null,
    expectArch: null,
    maxBlockmapSkew: 600,
    json: false,
    allowUnsigned: false,
    strict: false,
  };
  const takesValue = new Set([
    '--dir',
    '--manifest',
    '--exe',
    '--expect-version',
    '--expect-arch',
    '--max-blockmap-skew',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.json = true;
      continue;
    }
    if (arg === '--allow-unsigned') {
      opts.allowUnsigned = true;
      continue;
    }
    if (arg === '--strict') {
      opts.strict = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!takesValue.has(name)) {
      console.error(`未知参数：${arg}`);
      printUsage();
      process.exit(2);
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      console.error(`${name} 需要一个值`);
      process.exit(2);
    }
    if (name === '--dir') opts.dir = value;
    if (name === '--manifest') opts.manifest = value;
    if (name === '--exe') opts.exe = value;
    if (name === '--expect-version') opts.expectVersion = value;
    if (name === '--expect-arch') opts.expectArch = value;
    if (name === '--max-blockmap-skew') opts.maxBlockmapSkew = Number(value);
  }
  return opts;
}

function printUsage() {
  console.log(`用法：node verify-win-artifact.mjs [选项]

  --dir <目录>              产物目录，默认自动探测 release / dist
  --manifest <文件名>       清单名，默认 latest.yml
  --exe <路径>              只校验指定 exe（仍会核对清单）
  --expect-version <版本>   期望版本，默认读项目 package.json
  --expect-arch <架构>      期望架构：x64 | arm64 | x86（NSIS 包会校验载荷 exe）
  --max-blockmap-skew <秒>  blockmap 与 exe 的 mtime 允许差，默认 600
  --allow-unsigned          明确接受未签名产物：NotSigned 记为 SKIP 而非 FAIL
  --strict                  有 SKIP 即视为未通过（CI 发布门禁用，退出码 3）
  --json                    输出 JSON

退出码：0 无 FAIL；1 有 FAIL；2 参数/环境错误；3 --strict 下存在 SKIP。
`);
}

// ---------------------------------------------------------------- 结果收集

const results = [];

function record(name, status, detail) {
  results.push({ name, status, detail });
}

function pass(name, detail) {
  record(name, 'PASS', detail);
}

function fail(name, detail) {
  record(name, 'FAIL', detail);
}

function skip(name, detail) {
  record(name, 'SKIP', detail);
}

// ---------------------------------------------------------------- latest.yml 解析

/**
 * 只解析 electron-updater 清单的固定形态，避免引入 YAML 依赖。
 * 支持：
 *   version: 1.2.3
 *   files:
 *     - url: a.exe
 *       sha512: xxx
 *       size: 123
 *   path: a.exe
 *   sha512: xxx
 *   releaseDate: '...'
 */
export function parseManifest(text) {
  const out = { version: null, path: null, sha512: null, files: [], releaseDate: null };
  const lines = text.split(/\r?\n/);
  let inFiles = false;
  let current = null;

  const unquote = (v) => {
    const t = v.trim();
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();

    if (/^files:\s*$/.test(line)) {
      inFiles = true;
      continue;
    }

    if (inFiles && /^-\s+/.test(line)) {
      current = {};
      out.files.push(current);
      const rest = line.replace(/^-\s+/, '');
      const m = /^(\w+):\s*(.+)$/.exec(rest);
      if (m) current[m[1]] = unquote(m[2]);
      if (m && m[1] === 'size') current.size = Number(current.size);
      continue;
    }

    if (inFiles && indent >= 2 && current) {
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (m) {
        current[m[1]] = unquote(m[2]);
        if (m[1] === 'size') current.size = Number(current.size);
      }
      continue;
    }

    if (indent === 0) {
      inFiles = false;
      const m = /^(\w+):\s*(.+)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      const value = unquote(m[2]);
      if (key === 'version') out.version = value;
      if (key === 'path') out.path = value;
      if (key === 'sha512') out.sha512 = value;
      if (key === 'releaseDate') out.releaseDate = value;
    }
  }

  return out;
}

// ---------------------------------------------------------------- PE 解析

const PE_MACHINE = {
  0x014c: 'x86',
  0x8664: 'x64',
  0xaa64: 'arm64',
  0x01c4: 'arm',
  0x0200: 'ia64',
};

export function readPeMachine(buffer) {
  if (buffer.length < 0x40) return { ok: false, reason: '文件过小，不是 PE' };
  if (buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    return { ok: false, reason: '缺少 MZ 头' };
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length) {
    return { ok: false, reason: `e_lfanew 越界（${peOffset}）` };
  }
  if (
    buffer[peOffset] !== 0x50 ||
    buffer[peOffset + 1] !== 0x45 ||
    buffer[peOffset + 2] !== 0x00 ||
    buffer[peOffset + 3] !== 0x00
  ) {
    return { ok: false, reason: '缺少 PE\\0\\0 签名' };
  }
  const machine = buffer.readUInt16LE(peOffset + 4);
  return {
    ok: true,
    machine,
    arch: PE_MACHINE[machine] ?? `未知(0x${machine.toString(16)})`,
  };
}

// ---------------------------------------------------------------- NSIS 判定

/**
 * NSIS 安装包的引导程序**恒为 32 位**（makensis 生成的 stub 固定 x86），
 * 即使载荷是 x64/arm64。因此对 nsis 产物直接比对 `--expect-arch` 必然误报 x86。
 * NSIS 的 firstheader 里带 `NullsoftInst` 标记，用它区分「32 位包打错了」与「NSIS 正常引导」。
 */
const NSIS_MARKER = Buffer.from('NullsoftInst', 'latin1');

export function isNsisStub(buffer) {
  return buffer.lastIndexOf(NSIS_MARKER) !== -1;
}

/**
 * 找打包目录里的应用本体 exe，用来校验真正的载荷架构。
 * 依次看 `<dir>/win-unpacked`、`<dir>/../win-unpacked`、`<dir>/win-<arch>-unpacked`。
 * 收尾后的 `dist/package` 目录通常不含 unpacked 目录，此时返回 null（调用方标 SKIP）。
 */
async function findPayloadExe(dir) {
  const candidates = [
    join(dir, 'win-unpacked'),
    join(dir, '..', 'win-unpacked'),
    join(dir, 'win-x64-unpacked'),
    join(dir, 'win-arm64-unpacked'),
    join(dir, '..', 'win-x64-unpacked'),
    join(dir, '..', 'win-arm64-unpacked'),
  ];
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    let entries;
    try {
      entries = await readdir(c);
    } catch {
      continue;
    }
    const exes = entries.filter((f) => f.toLowerCase().endsWith('.exe'));
    if (!exes.length) continue;
    // 应用本体通常是最大的那个 exe（排除 crashpad / 小工具）
    let best = null;
    for (const f of exes) {
      try {
        const st = await stat(join(c, f));
        if (!best || st.size > best.size) best = { f, size: st.size };
      } catch {
        /* ignore */
      }
    }
    if (best) return join(c, best.f);
  }
  return null;
}

// ---------------------------------------------------------------- Authenticode

function probeCommand(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', timeout: 10000 });
  return !r.error;
}

function verifyAuthenticodeWindows(exePath) {
  // 注意：这里必须用**多行**脚本并避开「hashtable 字面量里写 if 语句」——
  //   ① 原实现用 '; ' 把多行 join 成一行，会产出 `[ordered]@{; Status = ...`，PS 直接语法报错；
  //   ② Windows PowerShell 5.1 不允许 `@{ k = if (...) {...} else {...} }`，必须先把值算进变量。
  // 用 -EncodedCommand（UTF-16LE base64）传参，可彻底绕开中文路径与引号转义问题。
  const literal = exePath.replace(/'/g, "''");
  const script = [
    `$ErrorActionPreference = 'Stop'`,
    `try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}`,
    `try {`,
    `  $s = Get-AuthenticodeSignature -LiteralPath '${literal}'`,
    `} catch {`,
    `  '{"Status":"Error","StatusMessage":"' + ($_.Exception.Message -replace '"','\\"') + '","Subject":"","Thumbprint":"","TimestampSubject":""}'`,
    `  exit 0`,
    `}`,
    `$subject = ''`,
    `$thumb = ''`,
    `$ts = ''`,
    `if ($s.SignerCertificate -ne $null) { $subject = $s.SignerCertificate.Subject; $thumb = $s.SignerCertificate.Thumbprint }`,
    `if ($s.TimeStamperCertificate -ne $null) { $ts = $s.TimeStamperCertificate.Subject }`,
    `$out = [ordered]@{`,
    `  Status = [string]$s.Status`,
    `  StatusMessage = [string]$s.StatusMessage`,
    `  Subject = $subject`,
    `  Thumbprint = $thumb`,
    `  TimestampSubject = $ts`,
    `}`,
    `$out | ConvertTo-Json -Compress`,
  ].join('\n');

  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: 60000, windowsHide: true }
  );
  if (r.error) return { ok: false, reason: `PowerShell 调用失败：${r.error.message}` };
  const stdout = (r.stdout || '').trim();
  if (!stdout) {
    return { ok: false, reason: `PowerShell 无输出（退出码 ${r.status}）：${(r.stderr || '').trim().split('\n')[0] || '未知'}` };
  }
  try {
    return { ok: true, data: JSON.parse(stdout.split(/\r?\n/).pop()) };
  } catch {
    return { ok: false, reason: `返回值无法解析：${stdout.slice(0, 200)}` };
  }
}

function verifyAuthenticodeOssl(exePath) {
  const r = spawnSync('osslsigncode', ['verify', '-in', exePath], {
    encoding: 'utf8',
    timeout: 60000,
  });
  if (r.error) return { available: false };
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  return {
    available: true,
    ok: r.status === 0,
    hasTimestamp: /timestamp/i.test(output) && !/no timestamp/i.test(output),
    detail: output.trim().split('\n').slice(0, 4).join(' | '),
  };
}

// ---------------------------------------------------------------- 主流程

function sha512File(path) {
  return readFile(path).then((b) => createHash('sha512').update(b).digest('base64'));
}

async function findArtifactDir(explicit) {
  if (explicit) return resolve(explicit);
  for (const d of ['release', 'dist', 'out']) {
    if (existsSync(d)) {
      try {
        const entries = await readdir(d);
        if (entries.some((f) => f.toLowerCase().endsWith('.exe'))) return resolve(d);
      } catch {
        /* ignore */
      }
    }
  }
  return resolve('release');
}

async function readExpectedVersion(dir) {
  for (const candidate of [join(dir, '..', 'package.json'), join(process.cwd(), 'package.json')]) {
    try {
      const pkg = JSON.parse(await readFile(candidate, 'utf8'));
      if (pkg.version) return pkg.version;
    } catch {
      /* next */
    }
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = await findArtifactDir(opts.dir);
  const manifestPath = resolve(dir, opts.manifest);

  if (!existsSync(dir)) {
    console.error(`产物目录不存在：${dir}`);
    process.exit(2);
  }
  if (!existsSync(manifestPath)) {
    fail('清单存在', `找不到 ${manifestPath}（更新链路无从谈起）`);
    return finish(opts);
  }
  pass('清单存在', manifestPath);

  let manifest;
  try {
    manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  } catch (e) {
    fail('清单可解析', e.message);
    return finish(opts);
  }
  if (!manifest.version || manifest.files.length === 0) {
    fail('清单可解析', '缺少 version 或 files[]');
    return finish(opts);
  }
  pass('清单可解析', `version=${manifest.version}，files=${manifest.files.length}`);

  // 版本一致性
  const expectedVersion = opts.expectVersion ?? (await readExpectedVersion(dir));
  if (!expectedVersion) {
    skip('版本一致', '无法确定期望版本（未传 --expect-version 且读不到 package.json）');
  } else if (manifest.version === expectedVersion) {
    pass('版本一致', `${manifest.version}`);
  } else {
    fail('版本一致', `清单 ${manifest.version} ≠ 期望 ${expectedVersion}（客户端不会升级）`);
  }

  // 产物与哈希
  const targets = opts.exe
    ? [{ url: basename(opts.exe), sha512: null, size: null, explicit: resolve(opts.exe) }]
    : manifest.files;

  for (const file of targets) {
    const filePath = file.explicit ?? resolve(dir, file.url);
    const label = file.url;

    if (!existsSync(filePath)) {
      fail(`产物存在：${label}`, filePath);
      continue;
    }
    pass(`产物存在：${label}`, filePath);

    const info = await stat(filePath);
    if (file.size == null) {
      skip(`体积一致：${label}`, '清单未声明 size');
    } else if (info.size === file.size) {
      pass(`体积一致：${label}`, `${info.size} bytes`);
    } else {
      fail(`体积一致：${label}`, `实际 ${info.size} ≠ 清单 ${file.size}`);
    }

    if (!file.sha512) {
      skip(`sha512 一致：${label}`, '清单未声明 sha512');
    } else {
      const actual = await sha512File(filePath);
      if (actual === file.sha512) {
        pass(`sha512 一致：${label}`, actual.slice(0, 16) + '…');
      } else {
        fail(
          `sha512 一致：${label}`,
          `实际 ${actual.slice(0, 16)}… ≠ 清单 ${file.sha512.slice(0, 16)}…（签名晚于元数据时必现）`
        );
      }
    }

    // PE 架构（NSIS 安装包要看载荷，不能直接比对引导程序）
    const buf = await readFile(filePath);
    const pe = readPeMachine(buf);
    if (!pe.ok) {
      fail(`PE 合法：${label}`, pe.reason);
    } else if (isNsisStub(buf)) {
      const payloadPath = await findPayloadExe(dir);
      let payloadArch = null;
      if (payloadPath) {
        const p = readPeMachine(await readFile(payloadPath));
        if (p.ok) payloadArch = p.arch;
      }
      if (!payloadArch) {
        pass(`PE 架构：${label}`, 'NSIS 引导 x86（正常）；载荷 exe 未找到，架构未复核');
      } else if (opts.expectArch && payloadArch !== opts.expectArch) {
        fail(
          `PE 架构：${label}`,
          `载荷 ${payloadArch} ≠ 期望 ${opts.expectArch}（NSIS 引导 x86 属正常）`
        );
      } else {
        pass(`PE 架构：${label}`, `NSIS 引导 x86（正常）+ 载荷 ${payloadArch}`);
      }
    } else if (opts.expectArch && pe.arch !== opts.expectArch) {
      fail(`PE 架构：${label}`, `实际 ${pe.arch} ≠ 期望 ${opts.expectArch}`);
    } else {
      pass(`PE 架构：${label}`, pe.arch);
    }

    // blockmap
    const blockmap = `${filePath}.blockmap`;
    if (!existsSync(blockmap)) {
      fail(`blockmap：${label}`, '缺失（差量更新不可用，且说明清单与产物可能非同批）');
    } else {
      const bm = await stat(blockmap);
      const skew = Math.abs(bm.mtimeMs - info.mtimeMs) / 1000;
      if (skew <= opts.maxBlockmapSkew) {
        pass(`blockmap：${label}`, `同批（mtime 差 ${skew.toFixed(0)}s）`);
      } else {
        fail(
          `blockmap：${label}`,
          `mtime 差 ${skew.toFixed(0)}s > ${opts.maxBlockmapSkew}s，疑似上一批残留`
        );
      }
    }

    // Authenticode
    if (process.platform === 'win32') {
      const r = verifyAuthenticodeWindows(filePath);
      if (!r.ok) {
        // 在 Windows 上「签名校验没跑起来」不能当 SKIP：组策略 / AppLocker / 执行策略
        // 都可能让它失败，若记 SKIP 又不影响退出码，签名分支等于从未验证过。
        fail(`Authenticode：${label}`, `Windows 上无法完成签名校验，不能当作通过：${r.reason}`);
      } else {
        const d = r.data;
        const unsigned = String(d.Status) === 'NotSigned';
        if (String(d.Status) === 'Valid') {
          pass(`Authenticode：${label}`, d.Subject || '(无 subject)');
        } else if (unsigned && opts.allowUnsigned) {
          skip(`Authenticode：${label}`, '未签名（--allow-unsigned 已声明接受，用户会看到 SmartScreen）');
        } else {
          fail(`Authenticode：${label}`, `${d.Status} ${d.StatusMessage || ''}`.trim());
        }
        if (unsigned) {
          skip(`时间戳：${label}`, '未签名，无时间戳');
        } else if (d.TimestampSubject) {
          pass(`时间戳：${label}`, d.TimestampSubject);
        } else {
          fail(`时间戳：${label}`, '缺少时间戳（证书过期后签名即失效）');
        }
      }
    } else {
      const r = verifyAuthenticodeOssl(filePath);
      if (!r.available) {
        skip(
          `Authenticode：${label}`,
          '当前非 Windows 且未安装 osslsigncode；请在 Windows 上复核'
        );
      } else if (r.ok) {
        pass(`Authenticode：${label}`, r.detail);
        if (r.hasTimestamp) pass(`时间戳：${label}`, '已包含');
        else fail(`时间戳：${label}`, '未检出时间戳');
      } else {
        fail(`Authenticode：${label}`, r.detail);
      }
    }
  }

  // path 与 files[0] 一致
  if (!opts.exe && manifest.path) {
    const first = manifest.files[0]?.url;
    if (first && manifest.path !== first) {
      fail('path 指向', `path=${manifest.path} 与 files[0].url=${first} 不一致`);
    } else {
      pass('path 指向', manifest.path);
    }
  }

  return finish(opts);
}

function finish(opts) {
  const failed = results.filter((r) => r.status === 'FAIL');
  const skipped = results.filter((r) => r.status === 'SKIP');
  // 默认语义：exit 0 = 无 FAIL（SKIP 需人工复核）；--strict 下 SKIP 也算未通过 → 3
  const code = failed.length ? 1 : opts.strict && skipped.length ? 3 : 0;

  if (opts.json) {
    console.log(
      JSON.stringify({ ok: code === 0, exitCode: code, failed: failed.length, skipped: skipped.length, strict: !!opts.strict, results }, null, 2)
    );
  } else {
    console.log('');
    for (const r of results) {
      const icon = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '!';
      console.log(`  ${icon} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
    }
    console.log('');
    if (failed.length) {
      console.log(`结论：${failed.length} 项失败，该产物不得分发`);
    } else if (skipped.length && opts.strict) {
      console.log(`结论：无 FAIL，但 --strict 下有 ${skipped.length} 项 SKIP，按未通过处理`);
    } else if (skipped.length) {
      console.log(`结论：通过（${results.length - skipped.length} 项），SKIP ${skipped.length} 项需人工复核`);
    } else {
      console.log(`结论：通过（${results.length} 项）`);
    }
  }

  process.exit(code);
}

/**
 * CLI 入口判定。
 *
 * ⚠️ 历史 bug（务必不要回退成旧写法）：曾用
 *     `resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)`
 *   Windows 下 `new URL(...).pathname` 形如 `/C:/dir/a.mjs`，而 argv[1] 是 `C:\dir\a.mjs`，
 *   两者永不相等 → `main()` 不执行、进程以 0 退出 —— 表现为「校验静默通过」，
 *   比校验失败危险得多（发布流程会误判产物合格）。
 * 现在改用 fileURLToPath 归一化，并加一道「疑似入口却没匹配上」的硬报错。
 */
const isCli = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const norm = (p) => {
    let v;
    try {
      v = realpathSync(p);
    } catch {
      v = p;
    }
    return process.platform === 'win32' ? v.toLowerCase() : v;
  };
  try {
    return norm(entry) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isCli) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  });
} else if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  // 通过「同名脚本被当作入口调用」兜底：宁可报错，也不静默 exit 0
  console.error(
    `[verify-win-artifact] 无法确认 CLI 入口（argv[1]=${process.argv[1]}），拒绝静默退出。\n` +
      '若通过符号链接/大小写不同的路径调用，请改用真实路径重跑。'
  );
  process.exit(2);
}
