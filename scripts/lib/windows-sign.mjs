#!/usr/bin/env node
/**
 * windows-sign.mjs —— Windows 代码签名：证书探测 / 签名来源解析 / 参数拼装 / PIN 预热
 *
 * 背景：`build-and-publish-win.py` 这类项目脚本把「云签名器证书指纹」硬编码进 Python，
 * 换项目就要改代码。本模块把它通用化：
 *
 *   1. 从 `Cert:\CurrentUser\My` 枚举代码签名证书（SimplySign / 物理令牌 / 本地 PFX 导入后都在这）
 *   2. 按优先级解析该用哪张证书：
 *        命令行 --sign-sha1/--sign-subject
 *        → 环境变量 SIGN_SHA1 / WIN_SIGN_SHA1
 *        → 项目 `.electron-release.json`
 *        → 项目 `package.json#build.win.signtoolOptions`
 *        → 证书存储里唯一一张可用证书
 *        另：`certificateFile` / `WIN_CSC_LINK` 走 PFX 路径，不查存储
 *   3. 生成 electron-builder 的 CLI 覆盖参数：
 *        --c.win.signtoolOptions.certificateSha1=<sha1>
 *        --c.win.signtoolOptions.rfc3161TimeStampServer=<url>
 *   4. 构建前预热：用 electron-builder 自带的 64 位 signtool 对一份临时 exe 签一次，
 *      把 PIN / 手机确认前移到构建之前（否则 builder 会卡在
 *      `Submitting digest for signing...`，表现为「无响应」而不是报错）。
 *
 * 只读证书存储；预热只签临时副本，不改动项目产物。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { runPowerShell } from './powershell.mjs';

export const DEFAULT_TIMESTAMP_URL = 'http://timestamp.digicert.com';
const IS_WIN = process.platform === 'win32';
const SIGNING_ENV_KEYS = ['WIN_CSC_LINK', 'CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'CSC_KEY_PASSWORD'];

export function normalizeThumbprint(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function stripBom(text) {
  return String(text || '').replace(/^\uFEFF/, '');
}

/**
 * 枚举当前用户的代码签名证书。
 *
 * 用 -EncodedCommand（UTF-16LE base64）传脚本，避开中文 Subject 与引号转义；
 * 显式设置控制台输出编码为 UTF-8，否则重定向到管道时中文会按 ANSI 码页输出成乱码。
 *
 * @returns {{ supported: boolean, certs: Array<object>, error: string|null }}
 */
export function enumerateCodeSigningCerts() {
  if (!IS_WIN) return { supported: false, certs: [], error: null };

  const body = [
    `$list = @(Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert -ErrorAction SilentlyContinue | ForEach-Object {`,
    `  [ordered]@{`,
    `    Subject = [string]$_.Subject`,
    `    Thumbprint = [string]$_.Thumbprint`,
    `    HasPrivateKey = [bool]$_.HasPrivateKey`,
    `    NotBefore = $_.NotBefore.ToUniversalTime().ToString('o')`,
    `    NotAfter = $_.NotAfter.ToUniversalTime().ToString('o')`,
    `  }`,
    `})`,
    `$result = if ($list.Count -eq 0) { '[]' } else { ConvertTo-Json -InputObject $list -Compress -Depth 4 }`,
  ].join('\n');

  const r = runPowerShell(body, { timeout: 30000 });
  if (!r.ok) return { supported: true, certs: [], error: r.error || '读取证书存储失败' };
  const stdout = stripBom(r.stdout).trim();
  if (!stdout) return { supported: true, certs: [], error: '证书存储返回空结果' };
  let parsed;
  try {
    parsed = JSON.parse(stdout.split(/\r?\n/).filter(Boolean).pop());
  } catch {
    return { supported: true, certs: [], error: `证书存储返回值无法解析：${stdout.slice(0, 200)}` };
  }
  if (parsed && !Array.isArray(parsed) && parsed.error) {
    return { supported: true, certs: [], error: String(parsed.error) };
  }
  // 只有一张证书时 ConvertTo-Json 会输出对象而不是数组
  const certs = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []).map((c) => ({
    Subject: String(c.Subject || ''),
    Thumbprint: String(c.Thumbprint || ''),
    HasPrivateKey: Boolean(c.HasPrivateKey),
    NotBefore: c.NotBefore || null,
    NotAfter: c.NotAfter || null,
  }));
  return { supported: true, certs, error: null };
}

function isExpired(cert) {
  const t = Date.parse(cert?.NotAfter || '');
  return Number.isFinite(t) ? t < Date.now() : false;
}

function describeCert(cert) {
  const bits = [cert.Subject || '(无 Subject)'];
  if (cert.Thumbprint) bits.push(`thumbprint=${cert.Thumbprint}`);
  bits.push(`HasPrivateKey=${cert.HasPrivateKey}`);
  if (cert.NotAfter) bits.push(`NotAfter=${String(cert.NotAfter).slice(0, 10)}`);
  return bits.join('  ');
}

function certHint(cloudSigner) {
  const hints = [
    '证书是否在 CurrentUser\\My 且 HasPrivateKey=True：'
      + `powershell -NoProfile -Command "Get-ChildItem Cert:\\CurrentUser\\My -CodeSigningCert | Select-Object Subject,Thumbprint,HasPrivateKey,NotAfter"`,
  ];
  if (cloudSigner?.enabled) {
    hints.push('SimplySign 客户端是否已登录（掉线即私钥不可用，报 After Private Key filter, 0 certs were left）');
    hints.push('首次使用或换机：先跑安全客户端完成 PIN/手机确认，再重试');
  }
  hints.push(
    '需要显式指定时：preflight 用 --sha1 <40位指纹>，build.mjs 用 --sign-sha1；'
      + '也可用环境变量 SIGN_SHA1 或 .electron-release.json'
  );
  return hints;
}

function matchByThumbprint(certs, thumbprint) {
  const want = normalizeThumbprint(thumbprint);
  return certs.find((c) => normalizeThumbprint(c.Thumbprint) === want) || null;
}

function matchBySubject(certs, subject) {
  const want = String(subject || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!want) return [];
  return certs.filter((c) => String(c.Subject || '').toLowerCase().replace(/\s+/g, ' ').includes(want));
}

function validateCert(cert, { sha1, source, timestampUrl, certs, cloudSigner }) {
  if (!cert.HasPrivateKey) {
    return {
      mode: 'error',
      code: 'no-private-key',
      source,
      sha1,
      cert,
      certs,
      timestampUrl,
      error: `证书存在但 HasPrivateKey=False：${describeCert(cert)}`,
      hints: [
        '本地 PFX：重新导入含私钥的证书（导入时勾选「允许导出私钥」不影响签名，但必须带私钥）',
        ...certHint(cloudSigner).slice(1),
      ],
    };
  }
  if (isExpired(cert)) {
    return {
      mode: 'error',
      code: 'expired',
      source,
      sha1,
      cert,
      certs,
      timestampUrl,
      error: `证书已过期：${describeCert(cert)}`,
      hints: ['向证书颁发机构续期后同步更新指纹（续期后 thumbprint 会变化）'],
    };
  }
  return { mode: 'cert', source, sha1: normalizeThumbprint(cert.Thumbprint), subject: cert.Subject, timestampUrl, cert, certs, hints: [] };
}

/**
 * 解析本次构建应该用哪种签名来源。
 *
 * @param {object} opts
 * @param {string} opts.projectRoot
 * @param {object} [opts.packageBuild]  package.json#build 段
 * @param {object} [opts.projectConfig] .electron-release.json 内容（已解析）
 * @param {string} [opts.sha1]          命令行 --sign-sha1
 * @param {string} [opts.subject]       命令行 --sign-subject
 * @param {string} [opts.timestampUrl]  命令行 --timestamp-url
 * @param {boolean} [opts.allowUnsigned] 明确接受未签名产物
 * @param {boolean} [opts.skipSign]     命令行 --skip-sign
 */
export function resolveWindowsSigning({
  projectRoot,
  packageBuild = {},
  projectConfig = null,
  sha1 = null,
  subject = null,
  timestampUrl = null,
  allowUnsigned = false,
  skipSign = false,
} = {}) {
  const cfgSigning = (projectConfig && projectConfig.signing) || {};
  const winCfg = cfgSigning.windows || {};
  const cloudSigner = winCfg.cloudSigner || {};
  const ts =
    timestampUrl ||
    process.env.WIN_SIGN_TIMESTAMP_URL ||
    winCfg.timestampServer ||
    DEFAULT_TIMESTAMP_URL;

  const base = { certs: [], timestampUrl: ts, allowUnsigned, source: '默认' };

  if (skipSign) {
    return { ...base, mode: 'unsigned', source: '--skip-sign', reason: '命令行指定跳过签名' };
  }
  if (String(winCfg.method || '').toLowerCase() === 'none') {
    return {
      ...base,
      mode: 'unsigned',
      source: '.electron-release.json',
      reason: '项目配置声明 signing.windows.method=none',
    };
  }
  if (!IS_WIN) {
    return {
      ...base,
      mode: 'unsupported-platform',
      reason: '当前不是 Windows 宿主：证书存储签名只能在 Windows 上执行',
    };
  }

  const pkgSig = (packageBuild.win && packageBuild.win.signtoolOptions) || packageBuild.win || {};
  const cliSha1 = normalizeThumbprint(sha1);
  const envSha1 = normalizeThumbprint(process.env.WIN_SIGN_SHA1 || process.env.SIGN_SHA1);
  const cfgSha1 = normalizeThumbprint(winCfg.certificateSha1);
  const pkgSha1 = normalizeThumbprint(pkgSig.certificateSha1);

  // 显式选择优先级：命令行的 sha1 / subject 必须高于项目配置，否则「换个证书构建」做不到。
  const wanted = [
    cliSha1 && { kind: 'sha1', value: cliSha1, source: '命令行 --sign-sha1' },
    subject && { kind: 'subject', value: subject, source: '命令行 --sign-subject' },
    envSha1 && { kind: 'sha1', value: envSha1, source: '环境变量 SIGN_SHA1' },
    cfgSha1 && { kind: 'sha1', value: cfgSha1, source: '.electron-release.json' },
    winCfg.certificateSubjectName && {
      kind: 'subject',
      value: winCfg.certificateSubjectName,
      source: '.electron-release.json',
    },
    pkgSha1 && { kind: 'sha1', value: pkgSha1, source: 'package.json#build.win' },
    pkgSig.certificateSubjectName && {
      kind: 'subject',
      value: pkgSig.certificateSubjectName,
      source: 'package.json#build.win',
    },
  ].filter(Boolean);
  const wantedCert = wanted[0] || null;
  const wantSha1 = wantedCert?.kind === 'sha1' ? wantedCert.value : '';
  const wantSubject = wantedCert?.kind === 'subject' ? wantedCert.value : '';
  const wantSource = wantedCert?.source || '证书存储';

  const store = enumerateCodeSigningCerts();
  if (store.error) {
    return {
      ...base,
      mode: 'error',
      code: 'store-unreadable',
      source: '证书存储',
      error: store.error,
      hints: certHint(cloudSigner),
    };
  }
  const certs = store.certs;

  if (wantSha1 || wantSubject) {
    let cert = null;
    if (wantSha1) {
      cert = matchByThumbprint(certs, wantSha1);
      if (!cert) {
        return {
          ...base,
          mode: 'error',
          code: 'cert-not-found',
          certs,
          source: wantSource,
          sha1: wantSha1,
          error: `证书存储中找不到指纹为 ${wantSha1} 的代码签名证书`,
          hints: [
            certs.length
              ? `当前可用：\n${certs.map((c) => '  · ' + describeCert(c)).join('\n')}`
              : '证书存储里没有任何代码签名证书',
            ...certHint(cloudSigner),
          ],
        };
      }
    } else {
      const hits = matchBySubject(certs, wantSubject);
      if (hits.length === 0) {
        return {
          ...base,
          mode: 'error',
          code: 'cert-not-found',
          certs,
          source: wantSource,
          error: `证书存储中找不到 Subject 含「${wantSubject}」的代码签名证书`,
          hints: certHint(cloudSigner),
        };
      }
      if (hits.length > 1) {
        return {
          ...base,
          mode: 'choose',
          code: 'ambiguous-subject',
          certs: hits,
          source: wantSource,
          error: `Subject 匹配到 ${hits.length} 张证书，需要用 --sign-sha1 指定`,
          hints: hits.map((c) => '  · ' + describeCert(c)),
        };
      }
      cert = hits[0];
    }
    return validateCert(cert, { sha1: normalizeThumbprint(cert.Thumbprint), source: wantSource, timestampUrl: ts, certs, cloudSigner });
  }

  // PFX 路径：配置了 certificateFile 或提供了 WIN_CSC_LINK
  const pfxFile = pkgSig.certificateFile || (packageBuild.win && packageBuild.win.certificateFile) || null;
  if (pfxFile) {
    const abs = path.isAbsolute(pfxFile) ? pfxFile : path.join(projectRoot, pfxFile);
    if (!fs.existsSync(abs)) {
      return {
        ...base,
        mode: 'error',
        code: 'pfx-missing',
        source: 'package.json#build.win.certificateFile',
        error: `配置的 PFX 文件不存在：${abs}`,
        hints: ['检查路径是否相对项目根目录', '或改用 --sign-sha1 / WIN_CSC_LINK'],
      };
    }
    return { ...base, mode: 'pfx', source: 'package.json#build.win.certificateFile', reason: `PFX：${abs}` };
  }
  if (process.env.WIN_CSC_LINK) {
    return { ...base, mode: 'pfx-env', source: 'WIN_CSC_LINK', reason: '由 electron-builder 从 WIN_CSC_LINK 导入证书' };
  }

  // 未显式指定：证书存储里恰好一张可用证书时直接采用（SimplySign 场景常见）
  const usable = certs.filter((c) => c.HasPrivateKey && !isExpired(c));
  if (usable.length === 1) {
    return validateCert(usable[0], {
      sha1: normalizeThumbprint(usable[0].Thumbprint),
      source: '证书存储（唯一可用证书）',
      timestampUrl: ts,
      certs,
      cloudSigner,
    });
  }
  if (usable.length > 1) {
    return {
      ...base,
      mode: 'choose',
      code: 'multiple-certs',
      certs: usable,
      source: '证书存储',
      error: `证书存储里有 ${usable.length} 张可用代码签名证书，无法自动选择（避免签错主体）`,
      hints: ['用 --sign-sha1 指定：', ...usable.map((c) => '  · ' + describeCert(c))],
    };
  }
  if (allowUnsigned) {
    return {
      ...base,
      mode: 'unsigned',
      source: '--allow-unsigned',
      certs,
      reason: '证书存储里没有可用证书，已按 --allow-unsigned 接受未签名产物',
    };
  }
  return {
    ...base,
    mode: 'error',
    code: 'no-cert',
    certs,
    source: '证书存储',
    error: '证书存储里没有可用的代码签名证书（HasPrivateKey=True 且未过期）',
    hints: certHint({ enabled: true }),
  };
}

/** electron-builder CLI 覆盖参数（只有证书存储路径需要） */
export function buildSigningArgs(signing) {
  if (!signing || signing.mode !== 'cert' || !signing.sha1) return [];
  const args = [`--c.win.signtoolOptions.certificateSha1=${signing.sha1}`];
  if (signing.timestampUrl) {
    args.push(`--c.win.signtoolOptions.rfc3161TimeStampServer=${signing.timestampUrl}`);
  }
  return args;
}

/** 去掉会触发意外签名的环境变量（--skip-sign / 明确不签名时用） */
export function stripSigningEnv(env) {
  const out = { ...env };
  for (const key of SIGNING_ENV_KEYS) delete out[key];
  return out;
}

/** 在 PATH 里找可执行文件（不 spawn，避免受限环境下管道/进程创建问题） */
function findOnPath(names) {
  const dirs = String(process.env.PATH || '')
    .split(';')
    .map((d) => d.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** 找 64 位 signtool：优先 electron-builder 缓存（与 builder 用同一份） */
export function findSigntool() {
  if (!IS_WIN) return null;
  if (process.env.SIGNTOOL_PATH && fs.existsSync(process.env.SIGNTOOL_PATH)) return process.env.SIGNTOOL_PATH;
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const root = path.join(local, 'electron-builder', 'Cache', 'winCodeSign');
    if (fs.existsSync(root)) {
      const dirs = fs
        .readdirSync(root)
        .filter((d) => /^winCodeSign-/.test(d))
        .sort()
        .reverse();
      for (const d of dirs) {
        for (const arch of ['x64', 'ia32', 'x86']) {
          const p = path.join(root, d, 'windows-10', arch, 'signtool.exe');
          if (fs.existsSync(p)) return p;
        }
      }
    }
  }
  return findOnPath(['signtool.exe', 'signtool']);
}

function findWinCodeSignFile(name) {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const root = path.join(local, 'electron-builder', 'Cache', 'winCodeSign');
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root).filter((d) => /^winCodeSign-/.test(d)).sort().reverse();
  for (const d of dirs) {
    const p = path.join(root, d, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pickPrewarmTarget(outputDir, signtool) {
  const candidates = [];
  const unpacked = outputDir ? [path.join(outputDir, 'win-unpacked'), path.join(outputDir, 'win-x64-unpacked')] : [];
  for (const dir of unpacked) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.exe$/i.test(f)) continue;
      const p = path.join(dir, f);
      try {
        candidates.push({ p, size: fs.statSync(p).size });
      } catch {
        /* ignore */
      }
    }
  }
  if (!candidates.length && outputDir && fs.existsSync(outputDir)) {
    for (const f of fs.readdirSync(outputDir)) {
      if (!/\.exe$/i.test(f)) continue;
      const p = path.join(outputDir, f);
      try {
        candidates.push({ p, size: fs.statSync(p).size });
      } catch {
        /* ignore */
      }
    }
  }
  candidates.sort((a, b) => b.size - a.size);
  if (candidates[0]) return candidates[0].p;
  // 还没有任何构建产物时（首次打包）：用 builder 缓存里的无签名 rcedit 副本预热，
  // 避免去签已带 Microsoft 签名的 signtool.exe
  const rcedit = findWinCodeSignFile('rcedit-x64.exe');
  return rcedit || signtool;
}

/**
 * 构建前预热签名：对临时副本签一次，触发 PIN / 手机确认并把凭据放进缓存。
 * 只签临时文件，成功/失败都会删除，不改动项目产物。
 */
export function prewarmSigning({ signing, projectRoot, outputDir }) {
  if (!signing || signing.mode !== 'cert') {
    return { ok: false, skipped: true, reason: '当前签名方式不需要预热（仅证书存储 / 云签名器需要）' };
  }
  const signtool = findSigntool();
  if (!signtool) {
    return {
      ok: false,
      reason:
        '找不到 signtool.exe：electron-builder 的 winCodeSign 缓存尚未下载，且 PATH 里也没有。' +
        '先跑一次 Windows 构建让 builder 下载工具链，或用 SIGNTOOL_PATH 指定。',
    };
  }
  const source = pickPrewarmTarget(outputDir, signtool);
  if (!source || !fs.existsSync(source)) {
    return { ok: false, reason: '找不到可用于预热的 exe（也没有 signtool 本身）' };
  }
  const tmp = path.join(os.tmpdir(), `electron-release-prewarm-${process.pid}-${Date.now()}.exe`);
  try {
    fs.copyFileSync(source, tmp);
    console.log(`▸ 预热签名（会触发 PIN / 手机确认）：${path.basename(source)} → 临时副本`);
    const args = [
      'sign',
      '/sha1',
      signing.sha1,
      '/fd',
      'sha256',
      '/tr',
      signing.timestampUrl,
      '/td',
      'sha256',
      '/v',
      tmp,
    ];
    const r = spawnSync(signtool, args, { stdio: 'inherit', windowsHide: false });
    if (r.error) return { ok: false, signtool, source, reason: `signtool 启动失败：${r.error.message}` };
    if (r.status !== 0) {
      return {
        ok: false,
        signtool,
        source,
        exitCode: r.status,
        reason:
          `signtool 退出码 ${r.status}。若是云签名器：检查客户端登录态、PIN 缓存、` +
          '以及是否用 64 位 signtool（builder 缓存里那份就是）',
      };
    }
    return { ok: true, signtool, source };
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件删不掉不影响结果 */
    }
  }
}

export { describeCert, isExpired };
