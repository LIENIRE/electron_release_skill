#!/usr/bin/env node
/**
 * probe.mjs —— Electron 项目打包配置探测器（只读，无副作用）
 *
 * 用法：
 *   node probe.mjs [项目根目录]           # 默认 process.cwd()
 *   node probe.mjs . --json              # 纯 JSON 输出，便于程序消费
 *
 * 作用：读出package.json 的 build 段/ electron-builder.yml、构建脚本、
 * 图标、发布配置、签名配置，输出结构化画像。**不执行任何构建、不修改任何文件。**
 *
 * 退出码：0 = 识别为 Electron 项目；3 = 未识别；2 = 参数错误
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';

const args = process.argv.slice(2).filter((a) => a !== '--json');
const asJson = process.argv.includes('--json');
const root = resolve(args[0] || process.cwd());

const out = (o) => {
  if (asJson) console.log(JSON.stringify(o, null, 2));
  else console.log(o);
};
const fail = (msg, code = 2) => {
  if (asJson) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
  else console.error('✗ ' + msg);
  process.exit(code);
};

// ---------- 极简 YAML 读取（只需顶层键与缩进块，避免引入依赖） ----------
/**
 * 从 electron-builder.yml 中抽取 build 段的关键字段。
 * 目的不是完整解析 YAML，而是拿到「配置长什么样」的画像信息。
 */
function readBuilderYaml(file) {
  try {
    const text = readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const cfg = { _raw: lines.filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 200) };

    /**取顶层 key（无前导缩进） */
    const topKeys = [];
    for (const l of lines) {
      const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(l);
      if (m) topKeys.push(m[1]);
    }
    cfg._topKeys = [...new Set(topKeys)];

    // ---- 解析嵌套段（directories/mac/win/linux/publish），支持缩进块与行内数组 ----
    /** 取出以 `name:` 开头的缩进块；返回null 表示该段不存在 */
    function platformBlock(name) {
      const m = new RegExp('^' + name + ':\\s*(.*)$', 'm').exec(text);
      if (!m) return null;
      const all = text.split('\n');
      const startLine = text.slice(0, m.index).split('\n').length;
      const inline = m[1].trim();
      const body = [];
      for (let i = startLine + 1; i < all.length; i++) {
        const l = all[i];
        if (l.trim() === '') { body.push(''); continue; }
        if (!/^\s/.test(l)) break;   // 顶格= 出了这一段
        body.push(l);
      }
      const t = (inline ? inline + '\n' : '') + body.join('\n');
      return t.trim() ? t : null;
    }

    /** 取 `key: value` 的标量值（value 在同一行） */
    const scalar = (key) => {
      const m = new RegExp('^' + key + ':\\s*(\\S.*)$', 'm').exec(text);
      return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
    };
    cfg.appId = scalar('appId');
    cfg.productName = scalar('productName');
    // directories.output 可能是嵌套键，也与directories: 同行
    const dirSec = platformBlock('directories');
    cfg.outputDir = dirSec
      ? (/(?:^|\n)\s*output:\s*(\S+)/.exec(dirSec) || [])[1] || null
      : null;

    const extractTargets = (block) => {
      if (!block) return [];
      const t = [];
      // 写法 A:  - target: dmg
      for (const m of block.matchAll(/^\s*-\s*target:\s*(\S+)/gm)) t.push(m[1]);
      if (!t.length) {
        // 写法 B: target: dmg / target: [dmg, zip]
        const line = /(?:^|\n)\s*target:\s*(.+)/.exec(block);
        if (line) line[1].replace(/[\[\]]/g, '').split(',').forEach((x) => x.trim() && t.push(x.trim()));
      }
      return [...new Set(t)];
    };

    const mac = platformBlock('mac');
    const win = platformBlock('win');
    const linux = platformBlock('linux');
    cfg.mac = mac ? { targets: extractTargets(mac), icon: (/icon:\s*(\S+)/.exec(mac) || [])[1] || null } : null;
    cfg.win = win ? { targets: extractTargets(win), icon: (/icon:\s*(\S+)/.exec(win) || [])[1] || null } : null;
    cfg.linux = linux ? { targets: extractTargets(linux), icon: (/icon:\s*(\S+)/.exec(linux) || [])[1] || null } : null;

    // identity：可能是 null / false / 证书名字符串
    cfg.identity = mac ? (/(?:^|\n)\s*identity:\s*(.+)/.exec(mac) || [])[1]?.trim() ?? null : null;

    // notarize / hardenedRuntime / entitlements（限定在 mac 段内查找）
    cfg.hasNotarize = mac ? /notarize/i.test(mac) : false;
    cfg.notarizeValue = mac ? (/(?:^|\n)\s*notarize:\s*(.+)/.exec(mac) || [])[1]?.trim() ?? null : null;
    cfg.hardenedRuntime = mac ? (/(?:^|\n)\s*hardenedRuntime:\s*(\S+)/.exec(mac) || [])[1] ?? null : null;
    cfg.entitlements = mac ? (/(?:^|\n)\s*entitlements:\s*(\S+)/.exec(mac) || [])[1] ?? null : null;

    // publish
    const pub = platformBlock('publish') || '';
    const provider = (providerRe => (pub.match(providerRe) || [])[1] || null)(/(?:^|\n)\s*provider:\s*(\S+)/);
    cfg.publish = pub.trim() ? { provider, url: (/(?:^|\n)\s*url:\s*(\S+)/.exec(pub) || [])[1] || null } : null;

    return cfg;
  } catch (e) {
    return { _error: e.message };
  }
}

// ---------- 读取 package.json ----------
const pkgPath = join(root, 'package.json');
if (!existsSync(pkgPath)) fail(`未找到 package.json：${pkgPath}`);
let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
} catch (e) {
  fail(`package.json 解析失败：${e.message}`);
}

// ---------- 判定是否为 Electron 项目 ----------
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const isElectron = 'electron' in allDeps;
const buildTools = ['electron-builder', '@electron-forge/cli', 'electron-packager', '@electron/packager']
  .filter((t) => t in allDeps);

if (!isElectron && buildTools.length === 0) {
  fail(`未识别为 Electron 项目（无 electron / 打包工具依赖）：${root}`, 3);
}

// ---------- 配置来源 ----------
const builderYml = ['electron-builder.yml', 'electron-builder.yaml', 'electron-builder.json']
  .map((f) => join(root, f))
  .find(existsSync);

let build = pkg.build || {};
let configSource = 'package.json#build';
if (!pkg.build && builderYml) {
  build = readBuilderYaml(builderYml);
  configSource = basename(builderYml);
} else if (!pkg.build && !builderYml) {
  configSource = null; // 可能是 forge / packager，或尚未配置
}

// ---------- forge / packager 分支 ----------
const isForge = '@electron-forge/cli' in allDeps;
const isLegacyPackager = ('electron-packager' in allDeps || '@electron/packager' in allDeps);

// ---------- 图标 ----------
function iconInfo(cfg) {
  const icon = cfg?.icon;
  if (!icon || typeof icon !== 'string') return { declared: null, exists: null };
  const p = join(root, icon);
  return { declared: icon, exists: existsSync(p) };
}

// ---------- 凭据环境变量（只看是否存在，不打印值） ----------
const ENV_KEYS = [
  ['CSC_LINK', 'mac/通用代码签名证书（P12 或 base64）'],
  ['CSC_KEY_PASSWORD', 'P12 口令'],
  ['CSC_NAME', '证书名称过滤（多证书时指定）'],
  ['APPLE_ID', '公证：Apple ID'],
  ['APPLE_APP_SPECIFIC_PASSWORD', '公证：App 专用密码'],
  ['APPLE_TEAM_ID', '公证：Team ID'],
  ['APPLE_API_KEY', '公证：p8 密钥路径'],
  ['APPLE_API_KEY_ID', '公证：Key ID'],
  ['APPLE_API_ISSUER', '公证：Issuer ID'],
  ['WIN_CSC_LINK', 'Windows 代码签名证书'],
  ['WIN_CSC_KEY_PASSWORD', 'Windows 证书口令'],
];
const creds = ENV_KEYS.filter(([k]) => process.env[k]).map(([k, desc]) => ({ key: k, desc, present: true }));
const credsMissing = ENV_KEYS.filter(([k]) => !process.env[k]).map(([k, desc]) => ({ key: k, desc }));

// ---------- 产物目录现状 ----------
function scanOutDir(dir) {
  const p = join(root, dir);
  if (!existsSync(p)) return { dir, exists: false, files: [] };
  const files = readdirSync(p, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => {
      const st = existsSync(join(p, d.name)) ? statSync(join(p, d.name)) : null;
      return { name: d.name, mb: st ? +(st.size / 1048576).toFixed(1) : null };
    })
    .filter((f) => /\.(dmg|zip|exe|msi|AppImage|deb|rpm|blockmap|yml)$/i.test(f.name));
  return { dir, exists: true, files };
}

// ---------- 输出画像 ----------
const image = {
  ok: true,
  project: {
    root,
    name: pkg.name || null,
    version: pkg.version || null,
    productName: build?.productName || null,
    appId: build?.appId || null,
    description: pkg.description || null,
    // 缺失时 electron-builder 会把 exe CompanyName / NSIS 发布者回落成 "GitHub, Inc."
    author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name || null,
  },
  detection: {
    isElectron,
    electronRange: allDeps.electron || null,
    buildTools,
    isForge,
    isLegacyPackager,
    note: isForge
      ? '检测到 Electron Forge，本 skill 的流程需按 Forge 适配（forge make / forge publish）'
      : isLegacyPackager
        ? '检测到 electron-packager（只打包不产安装包），无 dmg/nsis 与自动更新清单'
        : null,
  },
  configSource,
  targets: (() => {
    const b = build || {};
    const norm = (t) => (Array.isArray(t) ? t : t ? [t] : []).filter(Boolean).map((x) => (typeof x === 'string' ? x : x.target));
    const t = {};
    // package.json#build 用 target（数组或单值）；解析 yml 时已归一为 targets
    if (b.mac) t.mac = norm(b.mac.target ?? b.mac.targets);
    if (b.win) t.win = norm(b.win.target ?? b.win.targets);
    if (b.linux) t.linux = norm(b.linux.target ?? b.linux.targets);
    return t;
  })(),
  outputDir: (build && build.directories && build.directories.output) || build?.outputDir || 'dist',
  filesWhitelist: build?.files || null,
  publish: build?.publish || null,
  icons: {
    mac: iconInfo(build?.mac),
    win: iconInfo(build?.win),
  },
  signing: {
    macIdentity: build?.mac ? (build.mac.identity !== undefined ? build.mac.identity : '(未声明)') : '(无 mac 段)',
    notarizeConfigured: build?.mac?.notarize ?? null,
    hardenedRuntime: build?.mac?.hardenedRuntime ?? build?.hardenedRuntime ?? null,
    entitlements: build?.mac?.entitlements ?? build?.entitlements ?? null,
    windowsCSC: build?.win?.certificateFile ?? build?.win?.signingHashAlgorithms ?? null,
    windows: (() => {
      const w = build?.win || null;
      const so = w?.signtoolOptions || {};
      const sha1 = so.certificateSha1 ?? w?.certificateSha1 ?? null;
      const subject = so.certificateSubjectName ?? w?.certificateSubjectName ?? null;
      const file = so.certificateFile ?? w?.certificateFile ?? null;
      const publisherName = so.publisherName ?? w?.publisherName ?? null;
      const timestampServer = so.rfc3161TimeStampServer ?? so.timeStampServer ?? w?.rfc3161TimeStampServer ?? null;
      // 只有 publisherName / 时间戳、没有证书选择方式时，证书很可能由 CLI 或 WIN_CSC_LINK 传入
      const hasHints = !!publisherName || !!timestampServer;
      const method = sha1
        ? 'certificateSha1（证书存储；独占来源，不回退 PFX）'
        : subject
          ? 'certificateSubjectName（证书存储）'
          : file
            ? 'certificateFile（PFX）'
            : hasHints
              ? '未在配置中指定证书（可能经 CLI 参数或 WIN_CSC_LINK 传入）'
              : '未配置（可能不签名）';
      const nsis = w?.nsis || {};
      return {
        method,
        certificateSha1: sha1,
        certificateSubjectName: subject,
        certificateFile: file,
        publisherName,
        timestampServer,
        nsis: {
          oneClick: nsis.oneClick ?? null,
          perMachine: nsis.perMachine ?? null,
          allowToChangeInstallationDirectory: nsis.allowToChangeInstallationDirectory ?? null,
        },
      };
    })(),
    note: (build?.mac && (build.mac.identity === null || build.mac.identity === false))
      ? '显式跳过 mac 签名（identity: null/false）'
      : build?.mac
        ? '未显式跳过，由 electron-builder 自动选择钥匙串证书'
        : null,
  },
  scripts: pkg.scripts || {},
  credentialsInEnv: creds,
  credentialsMissing: credsMissing,
  artifacts: ['dist', 'release', 'out'].map((d) => scanOutDir(d)).filter((d) => d.exists),
};

if (!asJson) {
  const p = image.project;
  console.log(`项目        ${p.name || '(无名)'}  v${p.version}`);
  console.log(`根目录      ${image.project.root}`);
  console.log(`产品名/ID   ${p.productName || '(未声明)'}  /  ${p.appId || '(未声明)'}`);
  console.log(`发布者      ${p.author || '(未声明) ← exe CompanyName 与卸载项发布者会回落 GitHub, Inc.'}`);
  console.log(`打包工具    ${image.detection.buildTools.join(', ') || '(无)'}`);
  console.log(`配置来源    ${configSource || '(无构建配置)'}`);
  console.log(`目标        ${Object.entries(image.targets).map(([k, v]) => `${k}: ${[].concat(v).join('/')}`).join('  ') || '(未声明)'}`);
  console.log(`输出目录    ${image.outputDir}`);
  console.log(`发布源      ${image.publish ? JSON.stringify(image.publish) : '(未配置)'}`);
  console.log(`mac 签名    ${image.signing.macIdentity}${image.signing.note ? '  ← ' + image.signing.note : ''}`);
  console.log(`公证配置    ${image.signing.notarizeConfigured ?? '(未配置)'}${image.signing.hardenedRuntime !== null ? `  hardenedRuntime=${image.signing.hardenedRuntime}` : ''}`);
  {
    const w = image.signing.windows;
    console.log(`win 签名    ${w.method}${w.publisherName ? `  publisherName=${w.publisherName}` : ''}`);
    const nsis = [];
    if (w.nsis.oneClick === true) nsis.push('oneClick=true');
    if (w.nsis.perMachine === true) nsis.push('perMachine=true');
    if (w.nsis.allowToChangeInstallationDirectory === true) nsis.push('可改安装目录');
    const nsisNote = w.nsis.oneClick === null && w.nsis.perMachine === null
      ? '(未配置 nsis 块 → 默认 oneClick=true，静默安装)'
      : (nsis.length ? nsis.join(' / ') : '(显式配置，无特殊项)');
    console.log(`NSIS        ${nsisNote}`);
    if (w.timestampServer) console.log(`时间戳      ${w.timestampServer}`);
  }
  console.log(`凭据(已设)  ${image.credentialsInEnv.length ? image.credentialsInEnv.map((c) => c.key).join(', ') : '(无)'}`);
  if (image.artifacts.length) {
    console.log('产物现状    ' + image.artifacts.map((a) => `${a.dir}(${a.files.length} 个包文件)`).join(''));
  }
  console.log(`图标        mac=${image.icons.mac.declared || '(无)'}${image.icons.mac.exists === false ? ' ←文件不存在!' : ''}  win=${image.icons.win.declared || '(无)'}${image.icons.win.exists === false ? ' ← 文件不存在!' : ''}`);
  if (image.detection.note) console.log(`\n⚠ ${image.detection.note}`);
}

out(image);