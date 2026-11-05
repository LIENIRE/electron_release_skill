#!/usr/bin/env node
/**
 * preflight-win-sign.mjs —— Windows 代码签名前置检查（SimplySign / 证书存储 / PFX）
 *
 * 在真正打包前回答三个问题：
 *   1. 这台机器的 `Cert:\CurrentUser\My` 里有没有可用代码签名证书？
 *   2. 本次构建该用哪张（命令行 / SIGN_SHA1 / .electron-release.json / package.json / 唯一证书）？
 *   3. 云签名器的 PIN 缓存是否就绪（可选 --warmup，用临时副本先签一次）。
 *
 * 只读证书存储；`--warmup` 只签临时副本，不改动项目产物。
 *
 * 用法：
 *   node preflight-win-sign.mjs [项目根目录] [选项]
 *
 * 选项：
 *   --sha1 <指纹>          指定证书指纹（也可用 SIGN_SHA1 / WIN_SIGN_SHA1 环境变量）
 *   --subject <子串>       按 Subject 子串选择证书（多命中会要求改用 --sha1）
 *   --timestamp-url <URL>  RFC3161 时间戳服务（默认取项目配置，其次 DigiCert）
 *   --warmup               预热签名：对临时 exe 签一次，触发 PIN / 手机确认
 *   --allow-unsigned       没有证书时不报错（明确接受未签名产物）
 *   --json                 输出 JSON
 *
 * 退出码：0 可以签名 / 明确接受不签名；1 不可签（未登录、证书缺失、私钥缺失、过期）；
 *         2 参数或环境错误；3 命中多张证书，需要 --sha1 指定。
 */

import fs from 'node:fs';
import path from 'node:path';

import { loadProjectConfig } from './lib/project-config.mjs';
import {
  resolveWindowsSigning,
  prewarmSigning,
  findSigntool,
  describeCert,
} from './lib/windows-sign.mjs';

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', c: '\x1b[36m', x: '\x1b[0m' };
const log = (s) => console.log(`${C.c}▸${C.x} ${s}`);
const ok = (s) => console.log(`${C.g}✓${C.x} ${s}`);
const bad = (s) => console.log(`${C.r}✗${C.x} ${s}`);
const warn = (s) => console.log(`${C.y}!${C.x} ${s}`);
const dim = (s) => console.log(`${C.d}  ${s}${C.x}`);

function parseArgs(argv) {
  const opts = {
    root: null,
    sha1: null,
    subject: null,
    timestampUrl: null,
    warmup: false,
    allowUnsigned: false,
    json: false,
  };
  const takesValue = new Set(['--sha1', '--subject', '--timestamp-url', '--project']);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--warmup') { opts.warmup = true; continue; }
    if (arg === '--allow-unsigned') { opts.allowUnsigned = true; continue; }
    if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const [name, inline] = arg.includes('=') ? arg.split(/=(.*)/s, 2) : [arg, undefined];
    if (!takesValue.has(name)) {
      console.error(`未知参数：${arg}`);
      usage();
      process.exit(2);
    }
    const value = inline ?? argv[++i];
    if (value === undefined) {
      console.error(`${name} 需要一个值`);
      process.exit(2);
    }
    if (name === '--sha1') opts.sha1 = value;
    if (name === '--subject') opts.subject = value;
    if (name === '--timestamp-url') opts.timestampUrl = value;
    if (name === '--project') opts.root = value;
  }
  if (!opts.root) opts.root = positionals[0] || process.cwd();
  return opts;
}

function usage() {
  console.log(`用法：node preflight-win-sign.mjs [项目根目录] [选项]

  --sha1 <指纹>          指定证书指纹（也可用 SIGN_SHA1 / WIN_SIGN_SHA1）
  --subject <子串>       按 Subject 子串选择证书
  --timestamp-url <URL>  RFC3161 时间戳服务
  --warmup               预热签名（触发 PIN / 手机确认）
  --allow-unsigned       没有证书时不报错
  --json                 输出 JSON

退出码：0 可签名 / 已接受未签名；1 不可签；2 参数或环境错误；3 命中多张证书。`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = path.resolve(opts.root);

  const pkgPath = path.join(root, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error(`✗ 未找到 package.json：${pkgPath}`);
    process.exit(2);
  }
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.error(`✗ package.json 解析失败：${e.message}`);
    process.exit(2);
  }

  const projectConfig = loadProjectConfig(root);
  if (projectConfig.error) {
    warn(`${projectConfig.path} 解析失败（${projectConfig.error}），已忽略`);
  }

  const signing = resolveWindowsSigning({
    projectRoot: root,
    packageBuild: pkg.build || {},
    projectConfig: projectConfig.config,
    sha1: opts.sha1,
    subject: opts.subject,
    timestampUrl: opts.timestampUrl,
    allowUnsigned: opts.allowUnsigned,
  });

  const result = {
    ok: ['cert', 'pfx', 'pfx-env', 'unsigned'].includes(signing.mode),
    project: root,
    mode: signing.mode,
    code: signing.code || null,
    source: signing.source || null,
    sha1: signing.sha1 || null,
    subject: signing.subject || signing.cert?.Subject || null,
    timestampUrl: signing.timestampUrl || null,
    cert: signing.cert || null,
    certs: signing.certs || [],
    error: signing.error || null,
    hints: signing.hints || [],
    warmup: null,
  };

  if (!opts.json) {
    log(`项目：${root}`);
    log('证书存储：Cert:\\CurrentUser\\My（代码签名 EKU）');
    if (signing.certs?.length) {
      for (const c of signing.certs) dim(`候选 · ${describeCert(c)}`);
    } else {
      dim('候选 · （无）');
    }
  }

  if (signing.mode === 'cert') {
    result.warmup = null;
    if (!opts.json) {
      ok(`可用证书：${signing.cert.Subject}`);
      dim(`thumbprint   ${signing.cert.Thumbprint}`);
      dim(`HasPrivateKey ${signing.cert.HasPrivateKey}    NotAfter ${String(signing.cert.NotAfter).slice(0, 10)}`);
      dim(`来源         ${signing.source}`);
      dim(`时间戳       ${signing.timestampUrl}`);
      const signtool = findSigntool();
      dim(`signtool     ${signtool || '未找到（构建时 electron-builder 会自行下载）'}`);
    }
    if (opts.warmup) {
      if (!opts.json) log('预热签名');
      const outputDir = path.resolve(root, pkg.build?.directories?.output || 'release');
      const w = prewarmSigning({ signing, projectRoot: root, outputDir });
      result.warmup = w;
      if (w.ok) {
        result.ok = true;
        if (!opts.json) ok('预热成功（PIN 已缓存，构建时不再弹确认）');
      } else {
        result.ok = false;
        result.error = w.reason || '预热失败';
        if (!opts.json) bad(`预热失败：${result.error}`);
      }
    }
  } else if (signing.mode === 'pfx' || signing.mode === 'pfx-env') {
    if (!opts.json) {
      ok(`签名方式：PFX（${signing.source}）`);
      dim(signing.reason || '');
      warn('PFX 路径无法在打包前校验私钥/口令；若签名阶段失败，先核对文件与 WIN_CSC_KEY_PASSWORD');
    }
  } else if (signing.mode === 'unsigned') {
    if (!opts.json) {
      warn(`不签名：${signing.reason || signing.source}`);
      dim('产物首次安装与每次升级都会被 SmartScreen 拦截，需要用户手动「仍要运行」');
    }
  } else if (signing.mode === 'unsupported-platform') {
    result.ok = false;
    if (!opts.json) {
      bad(signing.reason);
      dim('请在 Windows 打包机上运行本检查（macOS/Linux 无法访问 Cert:\\CurrentUser\\My）');
    }
  } else {
    // error / choose
    result.ok = false;
    if (!opts.json) {
      bad(signing.error || '签名前置检查未通过');
      for (const hint of result.hints) {
        for (const line of String(hint).split('\n')) dim(`  · ${line.trim()}`);
      }
    }
  }

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }

  if (!result.ok) {
    process.exit(signing.mode === 'choose' ? 3 : 1);
  }
  process.exit(0);
}

main();
