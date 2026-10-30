#!/usr/bin/env node
/**
 * build.mjs —— 自包含的构建 + 收尾 + 校验
 *
 * 存在的理由：项目的打包脚本（release.sh / package npm script）**可能只存在于部分分支**。
 * 本脚本不依赖它们，在任何分支上都能完成：构建 → 收齐 → 改名 → 生成配对清单 → 校验。
 *
 * 用法：
 *   node build.mjs [选项] [项目根目录]
 *
 * 选项：
 *   --platform mac|win|linux|all   构建平台（默认 mac）
 *   --out <目录>                   收尾产物目录（默认 <outputDir>/package）
 *   --skip-tests                   跳过单元测试
 *   --no-finalize只构建，不做收尾与校验
 *   --dry-run                      只打印将要执行的步骤
 *   --name-prefix <前缀>            指定产物 ASCII 前缀（默认从包名/appId 推断）
 *
 * 退出码：0 成功；1 校验失败；2 参数错；3 构建失败
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const has = (name) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && argv[i - 1] !== '--platform' && argv[i - 1] !== '--out'));

const PLATFORM = opt('--platform', 'mac');
const ROOT = path.resolve(positional[0] || process.cwd());
const SKIP_TESTS = has('--skip-tests');
const NO_FINALIZE = has('--no-finalize');
const DRY = has('--dry-run');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', c: '\x1b[36m', x: '\x1b[0m' };
const log = (s) => console.log(`${C.c}▸${C.x} ${s}`);
const ok = (s) => console.log(`${C.g}✓${C.x} ${s}`);
const bad = (s) => console.log(`${C.r}✗${C.x} ${s}`);
const warn = (s) => console.log(`${C.y}!${C.x} ${s}`);
const dim = (s) => console.log(`${C.d}  ${s}${C.x}`);

process.chdir(ROOT);

// ---------- 读配置 ----------
const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) {
  bad(`未找到 package.json：${pkgPath}`);
  process.exit(2);
}
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
} catch (e) {
  bad(`package.json 解析失败：${e.message}`);
  process.exit(2);
}

// 校验确实是 Electron 项目（避免在无关仓库上乱跑）
const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const TOOLS = ['electron-builder', '@electron-forge/cli', 'electron-packager', '@electron/packager'];
const hasElectron = 'electron' in allDeps;
const hasTool = TOOLS.some((t) => t in allDeps);
if (!hasElectron && !hasTool) {
  bad(`未识别为 Electron 项目（无 electron / 打包工具依赖）：${ROOT}`);
  dim('若这是 Forge 或 packager 项目，本脚本的收尾逻辑不适用，请用对应工具链');
  process.exit(2);
}

const build = pkg.build || {};
const OUTPUT_DIR = opt('--out') || build.directories?.output || 'dist';
const VERSION = pkg.version;
const PRODUCT = build.productName || pkg.name || 'app';

// ---------- YAML 解析（优先项目依赖，退化到内置最小实现） ----------
let yaml = null;
for (const base of [ROOT, process.cwd()]) {
  try { yaml = createRequire(path.join(base, 'noop.js'))('js-yaml'); break; } catch { /* 继续尝试 */ }
}

/** 极简 YAML 读取：仅支持本脚本需要的 files[]/version/path/sha512 结构 */
function miniYaml(text) {
  const out = { files: [] };
  let cur = null;
  for (const raw of text.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const vm = /^version:\s*(.+)$/.exec(raw);
    if (vm && !raw.startsWith(' ')) { out.version = vm[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const pm = /^path:\s*(.+)$/.exec(raw);
    if (pm && !raw.startsWith(' ')) { out.path = pm[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const sm = /^sha512:\s*(.+)$/.exec(raw);
    if (sm && !raw.startsWith(' ')) { out.sha512 = sm[1].trim().replace(/^["']|["']$/g, ''); continue; }
    const um = /^\s*-\s*url:\s*(.+)$/.exec(raw);
    if (um) { cur = { url: um[1].trim().replace(/^["']|["']$/g, '') }; out.files.push(cur); continue; }
    const fm = /^\s+(sha512|size):\s*(.+)$/.exec(raw);
    if (fm && cur) { cur[fm[1]] = fm[2].trim().replace(/^["']|["']$/g, ''); continue; }
  }
  return out;
}

function parseYaml(text) {
  if (yaml) {
    try { return yaml.load(text); } catch { /* 落到mini */ }
  }
  return miniYaml(text);
}

function dumpYaml(obj) {
  if (yaml) {
    try { return yaml.dump(obj, { lineWidth: -1, noRefs: true }); } catch { /* 落到 mini */ }
  }
  // 内置序列化：files 展开为多行，保证 sha512/size 独立成行（这是硬要求）
  const L = [`version: ${obj.version}`];
  L.push('files:');
  for (const f of obj.files) {
    L.push(`  - url: ${f.url}`);
    L.push(`    sha512: ${f.sha512}`);
    L.push(`    size: ${f.size}`);
  }
  if (obj.path) L.push(`path: ${obj.path}`);
  if (obj.sha512) L.push(`sha512: ${obj.sha512}`);
  if (obj.releaseDate) L.push(`releaseDate: '${obj.releaseDate}'`);
  return L.join('\n') + '\n';
}

// ---------- 文件名映射（中文名 → ASCII 名） ----------
/**
 * 推断产物文件名的 ASCII 前缀。
 *
 * 前缀必须稳定：客户端与更新清单靠它识别产物，换前缀等于换文件名，
 * 已发布的清单会全部失效。
 *
 * 优先级：
 *   1. --name-prefix 命令行参数（显式覆盖，最高优先）
 *   2. 包名去掉常见后缀（-local / -desktop / -app / -electron / -client）
 *   3. appId 的最后一段
 *   4. 兜底 'app'
 *
 * 注意：不要从 nsis.artifactName 推导，它的模式通常是
 * ${productName}-Setup-${version}.${ext}，含中文占位符，推不出 ASCII 前缀。
 */
function asciiPrefix() {
  const explicit = opt('--name-prefix');
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();

  const base = String(pkg.name || '').replace(/^@[^/]+\//, '');
  const stripped = base.replace(/-(local|desktop|app|electron|client)$/i, '');
  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(stripped)) return stripped;
  if (/^[A-Za-z][A-Za-z0-9._-]*$/.test(base)) return base;

  const appIdSeg = String((build && build.appId) || '').split('.').filter(Boolean).pop();
  if (appIdSeg && /^[A-Za-z][A-Za-z0-9._-]*$/.test(appIdSeg)) return appIdSeg;

  return 'app';
}

/** 中文产品名 → ASCII 前缀 + 剩余部分 */
function asciiName(name) {
  const prefix = asciiPrefix();
  if (!name.startsWith(PRODUCT)) return name;
  return prefix + name.slice(PRODUCT.length);
}
// ---------- 步骤1：选构建命令 ----------
/**
 * 选构建命令。优先级：
 *   1. 项目专用的打包脚本（package / release:dry 之类）——它自带收尾（ASCII 改名 + 清单生成）
 *   2. 平台 build 脚本（build:mac / build:win）—— 只构建，**不收尾**，由本脚本补
 *   3. 裸 electron-builder —— 同样只构建
 *
 * 注意：`build:mac` 虽然存在，但它不产ASCII 名与配对清单，
 * 所以即便用了它，也必须由本脚本走 finalize 补齐收尾。
 */
function pickBuildCommand() {
  const scripts = pkg.scripts || {};
  // 1. 优先「只打包不发布」的专用脚本
  for (const name of ['package', 'dist', 'pack']) {
    if (typeof scripts[name] === 'string' && scripts[name].trim()) {
      return { cmd: 'npm', args: ['run', name], via: `npm run ${name}`, isPackageScript: true };
    }
  }
  // 2. 平台脚本
  const key = PLATFORM === 'win' ? 'build:win' : PLATFORM === 'linux' ? 'build:linux' : 'build:mac';
  if (typeof scripts[key] === 'string') return { cmd: 'npm', args: ['run', key], via: `npm run ${key}` };
  if (typeof scripts.build === 'string') return { cmd: 'npm', args: ['run', 'build'], via: 'npm run build' };
  // 3. 裸命令
  const flags = PLATFORM === 'all' ? [] : ['--' + PLATFORM];
  return { cmd: 'npx', args: ['electron-builder', ...flags], via: `npx electron-builder ${flags.join(' ')}`.trim() };
}

// ---------- 步骤2：跑测试 ----------
function runTests() {
  if (SKIP_TESTS) { warn('SKIP_TESTS，跳过单元测试'); return true; }
  if (!pkg.scripts?.test) { dim('项目无 test 脚本，跳过'); return true; }
  log('运行单元测试');
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', shell: false });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = /#\s*pass\s+(\d+)/.exec(out);
  const f = /#\s*fail\s+(\d+)/.exec(out);
  if (r.status !== 0) {
    bad(`单元测试未通过（fail ${f ? f[1] : '?'}）`);
    console.log(out.split('\n').slice(-25).map((l) => '    ' + l).join('\n'));
    return false;
  }
  ok(`单元测试通过（${m ? m[1] : '?'} 个用例）`);
  return true;
}

// ---------- 步骤3：构建 ----------
function doBuild(plan) {
  log(`构建：${plan.via}`);
  const env = { ...process.env };
  // WorkBuddy 沙箱会打断 asar 写入（Brokered file token refused），必须剥掉
  if (env.NODE_OPTIONS) { delete env.NODE_OPTIONS; dim('已剥离 NODE_OPTIONS（沙箱 shim 会打断 asar 写入）'); }

  const r = spawnSync(plan.cmd, plan.args, { encoding: 'utf8', env, shell: false });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) {
    bad('构建失败，末尾输出：');
    console.log(out.split('\n').slice(-20).map((l) => '    ' + l).join('\n'));
    return false;
  }
  for (const line of out.split('\n')) {
    if (/building\s+target|skipped macOS code signing|packaging\s+platform|building block map/.test(line)) {
      dim('  ' + line.trim());
    }
  }
  return true;
}

// ---------- 步骤4：收尾 ----------
function manifestPathFor(platform) {
  return path.join(OUTPUT_DIR, platform === 'win' ? 'latest.yml' : `latest-${platform}.yml`);
}

function finalize(outDir) {
  const mf = manifestPathFor(PLATFORM === 'all' ? 'mac' : PLATFORM);
  if (!fs.existsSync(mf)) {
    bad(`构建未产出 ${mf}`);
    return false;
  }
  const m = parseYaml(fs.readFileSync(mf, 'utf8'));
  if (!m || !Array.isArray(m.files) || !m.files.length) {
    bad(`${mf} 缺少 files 数组`);
    return false;
  }
  if (m.version && String(m.version) !== String(VERSION)) {
    bad(`清单版本 ${m.version} ≠ package.json ${VERSION}`);
    return false;
  }

  // 以清单 files[] 为权威来源收齐，避免漏收/多收
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  const missing = [];
  for (const f of m.files) {
    const src = path.join(OUTPUT_DIR, path.basename(f.url));
    if (!fs.existsSync(src)) { missing.push(path.basename(f.url)); continue; }
    fs.copyFileSync(src, path.join(outDir, asciiName(path.basename(f.url))));
    n++;
  }
  if (missing.length) {
    bad(`清单引用的产物不存在：${missing.join(', ')}`);
    return false;
  }
  ok(`已收齐 ${n} 个产物 → ${outDir}/`);

  // YAML 解析 → 改写 url → 序列化（禁止逐行文本替换）
  m.files = m.files.map((f) => ({ ...f, url: asciiName(path.basename(f.url)) }));
  if (typeof m.path === 'string') {
    m.path = asciiName(path.basename(m.path));
    const main = m.files.find((f) => path.basename(f.url) === m.path);
    if (main) m.sha512 = main.sha512;
  }
  const outManifest = path.join(outDir, path.basename(mf));
  fs.writeFileSync(outManifest, dumpYaml(m));

  // 序列化后回读校验：防止 url 与 sha512/size 被并成一行
  const re = parseYaml(fs.readFileSync(outManifest, 'utf8'));
  let fail = 0;
  if (!re || !Array.isArray(re.files) || re.files.length !== m.files.length) {
    bad('清单序列化后 files 数量变化，疑似结构损坏');
    return false;
  }
  for (const [i, f] of re.files.entries()) {
    for (const k of ['url', 'sha512', 'size']) {
      if (f[k] === undefined || f[k] === '') { bad(`序列化后 files[${i}] 缺少 ${k}`); fail = 1; }
    }
  }
  if (fail) return false;
  ok('清单结构校验通过（url / sha512 / size 各自独立）');

  // 逐条比对 size + sha512
  for (const f of m.files) {
    const name = path.basename(f.url);
    const p = path.join(outDir, name);
    if (!fs.existsSync(p)) { bad(`${name} 缺失`); fail = 1; continue; }
    const buf = fs.readFileSync(p);
    const size = Number(f.size);
    if (Number.isFinite(size) && buf.length !== size) {
      bad(`${name} 实际 ${buf.length} 字节 ≠ 清单 ${f.size}`);
      fail = 1;
      continue;
    }
    if (f.sha512) {
      const h = crypto.createHash('sha512').update(buf).digest('base64');
      if (h !== f.sha512) { bad(`${name} sha512 与清单不一致`); fail = 1; continue; }
    }
    ok(`${name}  ${Math.round(buf.length / 1048576)}MB`);
  }
  return fail === 0;
}

// ---------- 批次核对 ----------
/**
 * 检查 outDir 里的产物是否与本次构建同批次。
 * 依据：构建会刷新 dist/ 顶层产物与清单；outDir 是收尾时才生成的，
 * 若其清单 mtime 早于本次构建开始时间，说明是上一批次的残留。
 */
function checkBatch(outDir) {
  const mf = path.join(outDir, path.basename(manifestPathFor(PLATFORM === 'all' ? 'mac' : PLATFORM)));
  if (!fs.existsSync(mf)) return { ok: false, reason: '收尾目录没有清单' };
  const t = fs.statSync(mf).mtime;
  if (t < BUILD_START) {
    return { ok: false, reason: `清单时间 ${t.toLocaleTimeString('zh-CN')} 早于本次构建开始 ${BUILD_START.toLocaleTimeString('zh-CN')}` };
  }
  return { ok: true };
}

const BUILD_START = new Date();

// ---------- 主流程 ----------
console.log(`${C.c}══ Electron 构建（自包含，不依赖项目脚本）══${C.x}`);
log(`项目：${ROOT}`);
log(`分支：${(spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim() || '(非 git 仓库)'}`);
log(`版本：${VERSION}   平台：${PLATFORM}   输出：${OUTPUT_DIR}/`);

const plan = pickBuildCommand();
const usingProjectScript = plan.via.startsWith('npm run');
if (plan.isPackageScript) ok(`使用项目打包脚本：${plan.via}（自带收尾，本脚本仍会校验）`);
else if (usingProjectScript) warn(`项目无 package 类脚本，只有 ${plan.via} —— 它不做收尾，本脚本将补齐改名与清单`);
else warn(`项目无可用打包脚本，回退到：${plan.via} —— 本脚本将补齐收尾`);

const outDir = opt('--out') || path.join(OUTPUT_DIR, 'package');

if (DRY) {
  dim('dry-run：以上为将要执行的步骤，未实际运行');
  process.exit(0);
}

// 构建前提示旧产物批次
if (!NO_FINALIZE && fs.existsSync(outDir)) {
  const b = checkBatch(outDir);
  if (!b.ok) warn(`${outDir}/ 存在旧产物（${b.reason}）—— 构建不可复现，收尾时会重建`);
}

if (!runTests()) process.exit(1);
if (!doBuild(plan)) process.exit(3);

if (NO_FINALIZE) {
  warn('--no-finalize：跳过收尾与校验');
  dim(`产物在 ${OUTPUT_DIR}/，清单 ${manifestPathFor(PLATFORM === 'all' ? 'mac' : PLATFORM)}`);
  process.exit(0);
}

log('收尾：收齐产物 → ASCII 改名 → 生成配对清单');
const okFinal = finalize(outDir);
if (!okFinal) {
  bad('收尾或校验失败');
  process.exit(1);
}

const b = checkBatch(outDir);
if (b.ok) ok('批次核对：收尾产物与本次构建同批次');
else warn(`批次核对异常：${b.reason}`);

console.log('');
log(`完成 v${VERSION}（未提交、未上传）`);
dim(`可分发目录   ${outDir}/`);
dim(`原始产物     ${OUTPUT_DIR}/`);
dim(`清单         ${path.join(outDir, path.basename(manifestPathFor(PLATFORM === 'all' ? 'mac' : PLATFORM)))}`);
console.log('');
warn('以下需人工完成：');
dim('  · 签名/公证：本项目 identity: null，产物未签名，Gatekeeper 会拦截');
dim('  · 版本号：若 tag 已存在，必须先递增版本号（客户端按 semver 判断是否升级）');
dim('  · 发布：推 tag → 建 Release → 改写清单为绝对地址 → 部署到更新源');
process.exit(0);
