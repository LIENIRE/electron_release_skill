#!/usr/bin/env node
/**
 * smoke.mjs —— 最小可复跑自测（零依赖，不联网，不碰真实项目）
 *
 * 存在的理由：README 的「已验证范围」原先只是一次性人工记录，改完脚本无法回归。
 * 本脚本用合成夹具把关键契约变成断言：清单解析、退出码、ASCII 改名、清单改写、
 * sha512 配对。跑一次 3 秒，可以放进任何提交前检查。
 *
 * 用法：
 *   node tests/smoke.mjs            # 全部用例
 *   node tests/smoke.mjs -v         # 额外打印子进程 stdout/stderr
 *
 * 退出码：0 全部通过；1 有失败用例；2 环境不满足（找不到 node 自身以外的前提）。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(HERE, '..', 'scripts');
const VERBOSE = process.argv.includes('-v');

const results = [];
const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const no = (name, detail = '') => results.push({ name, pass: false, detail });

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...(opts.env || {}) },
    timeout: 120000,
  });
  if (VERBOSE) {
    console.log(`\n$ node ${args.join(' ')}`);
    if (r.stdout) console.log(r.stdout.trimEnd());
    if (r.stderr) console.log('[stderr] ' + r.stderr.trimEnd());
  }
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function runBash(args, opts = {}) {
  const r = spawnSync('bash', args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: 120000,
  });
  if (VERBOSE) {
    console.log(`\n$ bash ${args.join(' ')}`);
    if (r.stdout) console.log(r.stdout.trimEnd());
    if (r.stderr) console.log('[stderr] ' + r.stderr.trimEnd());
  }
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`, missing: r.error && r.error.code === 'ENOENT' };
}

// ---------------------------------------------------------------- 夹具

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-release-smoke-'));
process.on('exit', () => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

function sha512Of(buf) {
  return crypto.createHash('sha512').update(buf).digest('base64');
}

/** 造一个最小 Electron 项目：package.json + dist(产物 + latest.yml) */
function makeFixture() {
  const root = path.join(TMP, 'fixture');
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

  const buf = Buffer.from('fake-nsis-payload-'.repeat(50));
  fs.writeFileSync(path.join(root, 'dist', 'MyApp-1.0.0.exe'), buf);
  const sha = sha512Of(buf);

  const manifest = [
    'version: 1.0.0',
    'files:',
    '  - url: MyApp-1.0.0.exe',
    `    sha512: ${sha}`,
    `    size: ${buf.length}`,
    'path: MyApp-1.0.0.exe',
    `sha512: ${sha}`,
    "releaseDate: '2026-01-01T00:00:00.000Z'",
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'dist', 'latest.yml'), manifest);

  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'my-app',
        version: '1.0.0',
        devDependencies: { electron: '^40.0.0', 'electron-builder': '^25.0.0' },
        build: { productName: 'MyApp', appId: 'com.example.myapp' },
      },
      null,
      2,
    ),
  );

  return { root, dist: path.join(root, 'dist'), manifestPath: path.join(root, 'dist', 'latest.yml'), size: buf.length };
}

const fx = makeFixture();
const CLI = path.join(SCRIPTS, 'manifest-cli.mjs');

// ---------------------------------------------------------------- 用例

{
  // 1. 清单与产物配对：通过
  const r = run([CLI, 'verify', '--manifest', fx.manifestPath, '--dir', fx.dist]);
  if (r.code === 0 && /sha512 匹配/.test(r.out)) ok('清单配对：正向通过');
  else no('清单配对：正向通过', `退出码 ${r.code}；${r.out.trim().split('\n').slice(-2).join(' | ')}`);
}

{
  // 2. --json 结构可用
  const r = run([CLI, 'verify', '--manifest', fx.manifestPath, '--dir', fx.dist, '--json']);
  let parsed = null;
  try {
    parsed = JSON.parse(r.out.slice(r.out.indexOf('{')).trim());
  } catch {
    /* 下面统一判失败 */
  }
  if (r.code === 0 && parsed && parsed.ok === true && parsed.fileCount === 1) ok('清单配对：--json 输出');
  else no('清单配对：--json 输出', `退出码 ${r.code}，JSON 解析${parsed ? '成功' : '失败'}`);
}

{
  // 3. 产物被篡改 → 体积不符 → 退出码 1
  const p = path.join(fx.dist, 'MyApp-1.0.0.exe');
  const original = fs.readFileSync(p);
  fs.appendFileSync(p, 'X');
  const r = run([CLI, 'verify', '--manifest', fx.manifestPath, '--dir', fx.dist]);
  if (r.code === 1 && /字节 ≠ 清单/.test(r.out)) ok('清单配对：篡改产物被拦截');
  else no('清单配对：篡改产物被拦截', `退出码 ${r.code}`);
  fs.writeFileSync(p, original);
}

{
  // 4. 清单缺 files → 退出码 1（不是静默通过）
  const bad = path.join(TMP, 'no-files.yml');
  fs.writeFileSync(bad, 'version: 9.9.9\npath: x.exe\n');
  const r = run([CLI, 'verify', '--manifest', bad, '--dir', fx.dist]);
  if (r.code === 1 && /缺少 files/.test(r.out)) ok('清单配对：缺 files 报错');
  else no('清单配对：缺 files 报错', `退出码 ${r.code}`);
}

{
  // 5. 缺参数 → 退出码 2（与「校验失败」区分）
  const r = run([CLI, 'verify', '--manifest', fx.manifestPath]);
  if (r.code === 2) ok('清单配对：参数错误退出码 2');
  else no('清单配对：参数错误退出码 2', `实际 ${r.code}`);
}

{
  // 6. build.mjs --skip-build：ASCII 改名 + 清单改写 + sha512 复核
  const r = run([
    path.join(SCRIPTS, 'build.mjs'),
    '--platform',
    'win',
    '--skip-build',
    '--skip-sign',
    '--allow-unsigned',
    '--no-verify',
    fx.root,
  ]);
  const pkgDir = path.join(fx.dist, 'package');
  const ascii = path.join(pkgDir, 'my-1.0.0.exe');
  const outManifest = path.join(pkgDir, 'latest.yml');
  const text = fs.existsSync(outManifest) ? fs.readFileSync(outManifest, 'utf8') : '';
  const manifestOk = /url: my-1\.0\.0\.exe/.test(text) && /^\s+sha512: /m.test(text) && /^\s+size: \d+$/m.test(text);
  if (r.code === 0 && fs.existsSync(ascii) && manifestOk) ok('build 收尾：改名 + 清单改写 + 结构校验');
  else
    no(
      'build 收尾：改名 + 清单改写 + 结构校验',
      `退出码 ${r.code}，产物 ${fs.existsSync(ascii) ? '存在' : '缺失'}，清单结构 ${manifestOk ? '正常' : '异常'}`,
    );
}

{
  // 7. 收尾后的清单与产物仍可被独立校验（跨脚本契约）
  const pkgDir = path.join(fx.dist, 'package');
  const r = run([CLI, 'verify', '--manifest', path.join(pkgDir, 'latest.yml'), '--dir', pkgDir]);
  if (r.code === 0 && /sha512 匹配/.test(r.out)) ok('build → verify 跨脚本契约');
  else no('build → verify 跨脚本契约', `退出码 ${r.code}`);
}

{
  // 8. verify-artifact.sh 走 manifest-cli（无 bash 的平台跳过）
  const probe = runBash(['-c', 'echo ok']);
  if (probe.missing) {
    ok('verify-artifact.sh 委托 manifest-cli', '跳过：本机无 bash');
  } else {
    const pkgDir = path.join(fx.dist, 'package');
    const r = runBash([
      path.join(SCRIPTS, 'verify-artifact.sh'),
      '--manifest',
      path.join(pkgDir, 'latest.yml'),
      '--dir',
      pkgDir,
    ]);
    if (r.code === 0 && /sha512 匹配/.test(r.out)) ok('verify-artifact.sh 委托 manifest-cli');
    else no('verify-artifact.sh 委托 manifest-cli', `退出码 ${r.code}；${r.out.trim().split('\n').slice(-2).join(' | ')}`);
  }
}

{
  // 9. 非 Electron 项目必须被拒绝（退出码 2），避免在任意仓库乱跑
  const bare = path.join(TMP, 'bare');
  fs.mkdirSync(bare, { recursive: true });
  fs.writeFileSync(path.join(bare, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));
  const r = run([path.join(SCRIPTS, 'build.mjs'), '--platform', 'win', '--skip-build', bare]);
  if (r.code === 2 && /未识别为 Electron 项目/.test(r.out)) ok('build：非 Electron 项目被拒绝');
  else no('build：非 Electron 项目被拒绝', `退出码 ${r.code}`);
}

{
  // 10. 签名预检在非 Windows 上必须明确报「不支持」，而不是装作通过
  if (process.platform !== 'win32') {
    const r = run([path.join(SCRIPTS, 'preflight-win-sign.mjs'), fx.root]);
    if (r.code === 1 && /unsupported-platform|仅支持 Windows|Windows/.test(r.out)) ok('签名预检：非 Windows 明确失败');
    else no('签名预检：非 Windows 明确失败', `退出码 ${r.code}`);
  } else {
    const r = run([path.join(SCRIPTS, 'preflight-win-sign.mjs'), fx.root]);
    // Windows 上结论取决于本机证书，只断言「退出码在约定集合内且有人类可读输出」
    if ([0, 1, 3].includes(r.code) && r.out.trim().length > 0) ok('签名预检：Windows 上返回约定退出码');
    else no('签名预检：Windows 上返回约定退出码', `退出码 ${r.code}`);
  }
}

// ---------------------------------------------------------------- 汇总

const failed = results.filter((r) => !r.pass);
for (const r of results) {
  console.log(`${r.pass ? '✓' : '✗'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
}
console.log('');
if (failed.length) {
  console.log(`${failed.length}/${results.length} 项失败`);
  process.exit(1);
}
console.log(`${results.length}/${results.length} 项通过（夹具已清理：${TMP}）`);
process.exit(0);
