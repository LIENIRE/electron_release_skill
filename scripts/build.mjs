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
 *   --skip-build                   跳过测试与构建，只对已有产物做收尾 + 校验
 *   --no-finalize                  只构建，不做收尾与校验
 *   --no-verify                    收尾后不跑产物校验
 *   --dry-run                      只打印将要执行的步骤
 *   --name-prefix <前缀>            指定产物 ASCII 前缀（默认从包名/appId 推断）
 *   --allow-cross-build            允许在非 Windows 宿主构建 Windows 包（原生模块会失败）
 *
 * Windows 签名（证书存储 / SimplySign 云签名器 / PFX）：
 *   --sign-sha1 <指纹>             证书指纹；默认依次取 SIGN_SHA1 / .electron-release.json / package.json
 *   --sign-subject <子串>          按 Subject 选择证书（多命中时要求改用 --sign-sha1）
 *   --timestamp-url <URL>          RFC3161 时间戳服务（默认取项目配置，其次 DigiCert）
 *   --warmup                       构建前预热签名（触发 PIN / 手机确认）
 *   --skip-sign                    不签名（同时剥离 WIN_CSC_LINK 等凭据变量）
 *   --allow-unsigned               没有可用证书时继续（未签名产物会被 SmartScreen 拦截）
 *   --expect-arch x64|arm64|x86    产物架构断言（交给 verify-win-artifact.mjs；NSIS 看载荷）
 *   --strict                       校验出现 SKIP 也算失败（发布门禁）
 *
 * 退出码：0 成功；1 收尾/校验失败；2 参数或环境错误（含签名前置检查不通过）；
 *         3 构建失败。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadProjectConfig } from './lib/project-config.mjs';
import { createCodec, sha512Buffer } from './lib/manifest.mjs';
import { resolveWindowsSigning, buildSigningArgs, prewarmSigning, stripSigningEnv as stripSigningEnvVars } from './lib/windows-sign.mjs';

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const has = (name) => argv.includes(name);

// `--help` 必须最先处理：否则会去读 cwd 的 package.json 并报「未找到 package.json」，
// 而 SKILL.md / README 都把 `build.mjs --help` 当作「完整选项的唯一真相来源」。
// 直接复用本文件头部注释，避免再维护第二份选项表。
if (has('--help') || has('-h')) {
  const selfText = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const doc = /^\/\*\*([\s\S]*?)\*\//m.exec(selfText);
  const body = doc
    ? doc[1]
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*\* ?/, ''))
        .join('\n')
        .trim()
    : '用法见 scripts/build.mjs 头部注释';
  console.log(body);
  process.exit(0);
}

// 位置参数 = 既不是 `--xxx`、也不是某个选项的取值。
// ⚠️ 旧实现把「--platform 的取值」也算成位置参数，于是文档里的
//    `build.mjs --platform win <项目根>` 会把 `win` 当成项目根 → chdir 到 <cwd>/win 失败。
const VALUE_FLAGS = new Set([
  '--platform',
  '--out',
  '--name-prefix',
  '--sign-sha1',
  '--sign-subject',
  '--timestamp-url',
  '--expect-arch',
]);
const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a.startsWith('--')) {
    if (VALUE_FLAGS.has(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) i += 1;
    continue;
  }
  positional.push(a);
}

const PLATFORM = opt('--platform', 'mac');
const ROOT = path.resolve(positional[0] || process.cwd());
const SKIP_TESTS = has('--skip-tests');
const SKIP_BUILD = has('--skip-build');
const NO_FINALIZE = has('--no-finalize');
const NO_VERIFY = has('--no-verify');
const DRY = has('--dry-run');
const WARMUP = has('--warmup');
const SKIP_SIGN = has('--skip-sign');
const ALLOW_UNSIGNED = has('--allow-unsigned');
const ALLOW_CROSS_BUILD = has('--allow-cross-build');
const SIGN_SHA1 = opt('--sign-sha1');
const SIGN_SUBJECT = opt('--sign-subject');
const TIMESTAMP_URL = opt('--timestamp-url');
const EXPECT_ARCH = opt('--expect-arch');
const VERIFY_STRICT = has('--strict');

const C = { r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', d: '\x1b[2m', c: '\x1b[36m', x: '\x1b[0m' };
const log = (s) => console.log(`${C.c}▸${C.x} ${s}`);
const ok = (s) => console.log(`${C.g}✓${C.x} ${s}`);
const bad = (s) => console.log(`${C.r}✗${C.x} ${s}`);
const warn = (s) => console.log(`${C.y}!${C.x} ${s}`);
const dim = (s) => console.log(`${C.d}  ${s}${C.x}`);

if (!['mac', 'win', 'linux', 'all'].includes(PLATFORM)) {
  bad(`--platform 只支持 mac|win|linux|all，收到：${PLATFORM}`);
  process.exit(2);
}
if (EXPECT_ARCH === true) {
  bad('--expect-arch 需要一个值（x64 / arm64 / x86）');
  process.exit(2);
}
if ((has('--sign-sha1') && SIGN_SHA1 === true) || (has('--sign-subject') && SIGN_SUBJECT === true) || (has('--timestamp-url') && TIMESTAMP_URL === true)) {
  bad('--sign-sha1 / --sign-subject / --timestamp-url 都需要值');
  process.exit(2);
}
// 纯参数矛盾，必须在任何前置检查（签名预检、证书枚举）之前拦下：
// 否则在没证书的机器上会先报「签名前置检查未通过」，掩盖真正的参数错误。
if (SKIP_BUILD && NO_FINALIZE) {
  bad('--skip-build 与 --no-finalize 同时使用没有任何动作');
  process.exit(2);
}

const IS_WIN = process.platform === 'win32';

/**
 * 跨平台执行 npm / npx / 自定义命令。
 *
 * Windows 上 npm 实际是 `npm.cmd`：`spawnSync('npm', [...], {shell:false})` 会直接 ENOENT
 * （libuv 只补 `.exe`，不认 PATHEXT）；而 Node ≥18.20 出于 CVE-2024-27980 又禁止
 * 无 shell 执行 `.cmd`。所以 Windows 必须 `shell: true`。
 * 代价：shell 模式下 Node 只是把 args 用空格拼接、不自动加引号，
 * 带空格的参数必须自己包引号（签名参数里的 Subject 可能含空格/中文）。
 */
function quoteShellArg(a) {
  const s = String(a);
  if (!/[\s"&|<>^]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function runTool(cmd, args, opts = {}) {
  if (IS_WIN) {
    const bin = cmd === 'npm' ? 'npm.cmd' : cmd === 'npx' ? 'npx.cmd' : cmd;
    return spawnSync(bin, args.map(quoteShellArg), { shell: true, windowsHide: true, ...opts });
  }
  return spawnSync(cmd, args, opts);
}


process.chdir(ROOT);

// ---------- 读配置 ----------
const pkgPath = path.join(ROOT, 'package.json');
if (!fs.existsSync(pkgPath)) {
  bad(`未找到 package.json：${pkgPath}`);
  process.exit(2);
}
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
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
const projectConfig = loadProjectConfig(ROOT);
if (projectConfig.error) {
  warn(`${projectConfig.path} 解析失败（${projectConfig.error}），已忽略项目级配置`);
}
const cfgBuild = (projectConfig.config && projectConfig.config.build) || {};
// ⚠️ 历史缺陷：旧实现把 `--out` 同时当作 builder 输出目录与收尾目录，
//    于是传了 `--out` 就命中「--out 不能等于产物目录本身」的自毁守卫，选项必然失败。
//    现在 `--out` 只覆盖收尾目录，builder 输出目录只看项目配置。
const OUTPUT_DIR = cfgBuild.outputDir || build.directories?.output || 'dist';
const VERSION = pkg.version;
const PRODUCT = build.productName || pkg.name || 'app';

// ---------- 清单解析（统一实现在 lib/manifest.mjs） ----------
// 有项目 js-yaml 就用它（保真、保留未知字段），没有则用内置最小解析器，
// 保证「零第三方依赖也能跑完整收尾」。
const manifestCodec = createCodec([ROOT, process.cwd()]);
const parseYaml = manifestCodec.parse;
const dumpYaml = manifestCodec.dump;
if (!manifestCodec.usingLibrary) {
  dim('未找到 js-yaml，清单解析使用内置解析器（仅支持 electron-updater 固定形态）');
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
 *   0. `.electron-release.json#build.command`（项目显式指定）
 *   1. **平台专属脚本**（dist:win / package:win / build:win / dist:mac:arm64 …）
 *      —— 必须先于通用脚本，否则会把 mac 专用链路跑到 Windows 上
 *   2. 通用打包脚本（package / dist / pack）—— 可能自带收尾，也可能含平台专属步骤
 *   3. build 编译脚本 / 裸 electron-builder —— 只构建，收尾由本脚本补齐
 *
 * 注意：除了项目自己的 package 脚本，其他命令都不产 ASCII 名与配对清单，
 * 所以无论选了哪条，都必须走本脚本的 finalize 收尾。
 */
function pickBuildCommand() {
  const scripts = pkg.scripts || {};
  const hasScript = (n) => typeof scripts[n] === 'string' && scripts[n].trim();

  // 0. 项目级配置显式指定（模板 assets/project-config.template.json#build.command）
  if (typeof cfgBuild.command === 'string' && cfgBuild.command.trim()) {
    return {
      cmd: 'custom',
      shellCommand: cfgBuild.command.trim(),
      via: cfgBuild.command.trim(),
      origin: 'config',
    };
  }

  // 1. 平台专属脚本：dist:win / package:win / build:win …，也支持 dist:win:x64 变体
  if (PLATFORM !== 'all') {
    const candidates = [];
    for (const base of ['dist', 'package', 'build', 'pack', 'release']) {
      candidates.push(`${base}:${PLATFORM}`);
      const prefix = `${base}:${PLATFORM}:`;
      for (const key of Object.keys(scripts)) {
        if (key.startsWith(prefix) && hasScript(key)) candidates.push(key);
      }
    }
    for (const name of candidates) {
      if (hasScript(name)) {
        return { cmd: 'npm', args: ['run', name], via: `npm run ${name}`, origin: 'platform' };
      }
    }
  }

  // 2. 通用打包脚本
  for (const name of ['package', 'dist', 'pack']) {
    if (hasScript(name)) {
      return {
        cmd: 'npm',
        args: ['run', name],
        via: `npm run ${name}`,
        origin: 'generic',
        platformHint:
          PLATFORM === 'win' && /(screenshot:mac|native:[^\s]*mac|--mac\b)/i.test(scripts[name])
            ? `脚本内容含 mac 专属步骤：${scripts[name]}`
            : null,
      };
    }
  }

  // 3. 编译脚本 / 裸 builder
  if (hasScript('build')) {
    return { cmd: 'npm', args: ['run', 'build'], via: 'npm run build', origin: 'compile' };
  }
  const flags = PLATFORM === 'all' ? [] : ['--' + PLATFORM];
  return {
    cmd: 'npx',
    args: ['electron-builder', ...flags],
    via: `npx electron-builder ${flags.join(' ')}`.trim(),
    origin: 'npx',
  };
}

// ---------- 步骤2：跑测试 ----------
function runTests() {
  if (SKIP_TESTS) { warn('SKIP_TESTS，跳过单元测试'); return true; }
  if (!pkg.scripts?.test) { dim('项目无 test 脚本，跳过'); return true; }
  log('运行单元测试');
  const r = runTool('npm', ['test'], { encoding: 'utf8' });
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
/**
 * 所有构建相关 spawn 共用的环境变量。
 *
 * WorkBuddy 沙箱的 shim（NODE_OPTIONS=--require .../node-language-shim.cjs）会打断
 * asar 写入，**必须剥掉**。兜底路径（node cli.js / --prepackaged 续跑）也必须走这里，
 * 否则一旦走兜底就会带着 shim 再跑一遍，主路径刻意剥离的意义归零。
 *
 * stripSigning：`--skip-sign` / 明确的未签名项目要剥掉 WIN_CSC_LINK 等凭据变量，
 * 否则 electron-builder 会绕过本脚本的意图直接签名。
 */
let envNoticeShown = false;
let STRIP_SIGNING_ENV = false;
function buildEnv() {
  let env = { ...process.env };
  if (env.NODE_OPTIONS) {
    delete env.NODE_OPTIONS;
    if (!envNoticeShown) {
      dim('已剥离 NODE_OPTIONS（沙箱 shim 会打断 asar 写入）');
      envNoticeShown = true;
    }
  }
  if (STRIP_SIGNING_ENV) env = stripSigningEnvVars(env);
  return env;
}

/** 执行构建命令，返回 { ok, out, via } */
function doBuild(plan, extraBuilderArgs = []) {
  log(`构建：${plan.via}`);
  if (plan.origin === 'custom') {
    warn('使用了 .electron-release.json#build.command：签名参数只能追加在命令末尾，需确认最后一步是 electron-builder');
  }
  let r;
  if (plan.cmd === 'custom') {
    const cmdline = [plan.shellCommand, ...extraBuilderArgs.map(quoteShellArg)].join(' ');
    if (extraBuilderArgs.length) dim(`  追加签名参数：${extraBuilderArgs.join(' ')}`);
    r = spawnSync(cmdline, { shell: true, windowsHide: true, encoding: 'utf8', env: buildEnv() });
  } else {
    const args = [...plan.args];
    if (extraBuilderArgs.length) {
      if (plan.cmd === 'npm') args.push('--');
      args.push(...extraBuilderArgs);
      dim(`  追加签名参数：${extraBuilderArgs.join(' ')}`);
    }
    r = runTool(plan.cmd, args, { encoding: 'utf8', env: buildEnv() });
  }
  // spawn 自身失败（ENOENT / EACCES）时 stdout/stderr 都是空的，必须把 r.error 带上，
  // 否则报错信息为空、兜底判定也无从命中（表现为「构建失败 + 一片空白」）。
  const out = ((r.stdout || '') + (r.stderr || '') + (r.error ? `\n${r.error.code || 'SPAWN_ERROR'} ${r.error.message}` : '')).trim();
  if (r.status !== 0) {
    return { ok: false, out, via: plan.via, cmd: plan.cmd, spawnError: r.error?.code || null };
  }
  for (const line of out.split('\n')) {
    if (/building\s+target|skipped macOS code signing|packaging\s+platform|building block map/.test(line)) {
      dim('  ' + line.trim());
    }
  }
  return { ok: true, out, via: plan.via };
}

/** 直接调用项目内的 electron-builder CLI（绕过 .bin shim） */
function localBuilderCli() {
  const p = path.join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
  return fs.existsSync(p) ? p : null;
}

// ---------- 步骤3.5：Windows 打包的两个本机兜底 ----------

/**
 * 兜底 1：`.bin` shim 不可用。
 *
 * 典型场景：node_modules 从 macOS / 另一台机器整体拷贝过来。此时
 *   - `node_modules/.bin/` 里没有 `.cmd` / `.ps1` shim（Windows 解析不到）
 *   - `node_modules/electron/dist/electron.exe` 也不存在
 * 于是 `npm run build:win` 报「electron-builder 不是内部或外部命令」，
 * `npm start` / `npx electron-builder` 同样失效。可直接用 node 调 cli.js 绕过。
 *
 * ⚠️ 只认「shim 缺失」这一类信号。**不能**把 `Cannot find module` 也算进来：
 *   项目自身的 `vite build` 因缺模块失败时会被误判，随后直接跑 electron-builder
 *   把上一次的旧产物打进安装包，收尾与校验还会全部通过 —— 静默发旧版本。
 */
const SHIM_FAILURE = /不是内部或外部命令|is not recognized as an internal or external command/i;

/**
 * npm 的 `Missing script: x` 只有在 x **正是本次请求的那个脚本**时才算回退信号。
 * 若缺的是项目脚本内部调用的子脚本（`build:win` → `electron:build` 不存在），
 * 说明构建链本身坏了；此时回退到裸 electron-builder 会跳过 `vite build`，
 * 直接把 `dist/` 里上一次的旧产物打进安装包 —— 与 `Cannot find module` 同一类事故。
 */
function missingScriptIsRequest(res) {
  const m = /Missing script:\s*"?([^\s"]+)"?/i.exec(res.out || '');
  if (!m) return false;
  const req = /npm run\s+(\S+)/.exec(res.via || '');
  return Boolean(req) && m[1] === req[1];
}

function shouldFallbackToCli(res) {
  if (!res || !['npm', 'npx'].includes(res.cmd)) return false;
  if (res.spawnError === 'ENOENT' || res.spawnError === 'EACCES') return true;
  return SHIM_FAILURE.test(res.out || '') || missingScriptIsRequest(res);
}

function buildWithNodeCli(summary, extraBuilderArgs = []) {
  const cli = localBuilderCli();
  if (!cli) {
    bad('项目内找不到 node_modules/electron-builder/cli.js，无法回退');
    return null;
  }
  warn(`npm 脚本不可用（${summary}），回退到 node cli.js`);
  const flags = PLATFORM === 'all' ? [] : [`--${PLATFORM}`];
  const args = [cli, ...flags, '--publish', 'never', ...extraBuilderArgs];
  if (extraBuilderArgs.length) dim(`  追加签名参数：${extraBuilderArgs.join(' ')}`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, env: buildEnv() });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: r.status === 0, out, via: `node cli.js ${args.slice(1).join(' ')}` };
}

/**
 * 兜底 2：rcedit `Unable to commit changes`。
 *
 * 现象：打包到「写 exe 版本信息 / 图标」阶段必失败一次，报
 *   `Fatal error: Unable to commit changes`（来自 EndUpdateResourceW）。
 * 根因：刚拷出的 exe（几十~两百 MB）被实时防护（火绒 / 电脑管家 / Defender）
 *   瞬时独占，等 8~30 秒后同一命令必成功。electron-builder 内置 3 次重试间隔太短。
 * 处置：从日志里抠出**原始命令行**（不硬编码品牌信息，参数按单引号分段以兼容中文/空格路径），
 *   退避重写元数据；再用 `--prepackaged <win-unpacked>` 只补跑分发目标 ——
 *   整包重跑会重新拷贝 exe，必然再次触发锁定。
 */
function extractRceditCommand(out) {
  const lines = out.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/command='.*rcedit.*'/i.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  // builder 偶尔把超长命令行折行渲染（续行以缩进 + `--xxx` 开头），一并拼回
  let s = lines[start];
  for (let j = start + 1; j < lines.length; j += 1) {
    if (/^\s{4,}--/.test(lines[j])) s += ' ' + lines[j].trim();
    else break;
  }
  s = s.replace(/^\s*command=/, '');
  const toks = [];
  let cur = '';
  let inQuote = false;
  for (const ch of s) {
    if (ch === "'") {
      if (inQuote) {
        toks.push(cur);
        cur = '';
        inQuote = false;
      } else {
        if (cur.trim()) toks.push(cur.trim());
        cur = '';
        inQuote = true;
      }
    } else if (!inQuote && /\s/.test(ch)) {
      if (cur.trim()) toks.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) toks.push(cur.trim());
  return toks.length > 1 ? toks : null;
}

/** 同步休眠（不占 CPU；热自旋会在杀软扫描期间白烧一个核，反而拖慢释放） */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const t = Date.now();
    while (Date.now() - t < ms) { /* 兜底：极少数环境禁用 SAB */ }
  }
}

function patchExeMetadata(cmd) {
  const exe = cmd[1];
  // 秒级退避：实时防护的扫描锁通常 8~30s 释放
  const waits = [0, 8, 8, 10, 12, 15, 20, 25];
  for (const [i, w] of waits.entries()) {
    if (w) sleepSync(w * 1000);
    try {
      // 先确认目标未被独占写（等价于 rcedit 的前提条件）
      fs.closeSync(fs.openSync(exe, 'r+'));
    } catch (e) {
      dim(`  [${i}] 目标仍被占用（${e.code}），继续等待`);
      continue;
    }
    const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) {
      ok(`rcedit 补写成功（第 ${i + 1} 次尝试）`);
      return true;
    }
    dim(`  [${i}] rcedit 失败：${(r.stderr || r.stdout || '').trim().split('\n').pop()}`);
  }
  return false;
}

function recoverFromRceditLock(out, extraBuilderArgs = []) {
  const cmd = extractRceditCommand(out);
  if (!cmd) {
    bad('未从日志中解析出 rcedit 命令行');
    return false;
  }
  dim(`目标 exe：${cmd[1]}`);
  if (!patchExeMetadata(cmd)) {
    bad('rcedit 多次重试仍失败：把项目目录 / 输出目录加入安全软件信任区后重试');
    return false;
  }
  const cli = localBuilderCli();
  // 目录名通常是 win-unpacked；多架构并行构建时 electron-builder 会用 win-<arch>-unpacked
  let appOutDir = path.join(OUTPUT_DIR, 'win-unpacked');
  if (!fs.existsSync(appOutDir) && fs.existsSync(OUTPUT_DIR)) {
    const alt = fs.readdirSync(OUTPUT_DIR).find((f) => /^win-.+-unpacked$/.test(f));
    if (alt) appOutDir = path.join(OUTPUT_DIR, alt);
  }
  if (!fs.existsSync(appOutDir)) {
    bad(`找不到未打包目录（${appOutDir}），无法用 --prepackaged 续跑`);
    return false;
  }
  if (!cli) {
    bad('找不到 node_modules/electron-builder/cli.js，无法续跑安装包');
    return false;
  }
  log(`续跑分发目标：--prepackaged ${appOutDir}`);
  // 续跑仍会执行签名（nsis 安装包在这一步才签），必须带上同样的签名参数
  const args = [cli, '--win', '--publish', 'never', '--prepackaged', appOutDir, ...extraBuilderArgs];
  if (extraBuilderArgs.length) dim(`  追加签名参数：${extraBuilderArgs.join(' ')}`);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, env: buildEnv() });
  const o = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) {
    bad('续跑失败，末尾输出：');
    console.log(o.split('\n').slice(-20).map((l) => '    ' + l).join('\n'));
    return false;
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
    const dest = path.join(outDir, asciiName(path.basename(f.url)));
    fs.copyFileSync(src, dest);
    // blockmap 必须与改名后的安装包同名同目录，否则客户端静默退化为全量下载
    // （latest.yml 不列 blockmap，漏拷不会报错，只会让差量更新失效）
    const bmSrc = `${src}.blockmap`;
    if (fs.existsSync(bmSrc)) fs.copyFileSync(bmSrc, `${dest}.blockmap`);
    n++;
  }
  if (missing.length) {
    bad(`清单引用的产物不存在：${missing.join(', ')}`);
    return false;
  }
  // Windows 的 latest.yml 只登记 nsis 安装包；win.zip 是「手动分发」用的额外产物，
  // 一并收齐改名（不写进清单），方便 release 上传时保持 ASCII 命名。
  // ⚠️ 必须按「本次版本 + 平台」过滤：OUTPUT_DIR 从不清空，跨版本构建后旧 zip
  //    仍在目录里，无过滤会把历史版本一起收进 package/ 分发出去。
  if (PLATFORM === 'win') {
    const zi = fs.readdirSync(OUTPUT_DIR);
    const allZips = zi.filter((f) => /\.zip$/i.test(f));
    // 版本号要按「分隔符边界」比对：裸 includes('1.1.1') 会把 1.1.10 也算成本批次。
    const esc = VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const verRe = new RegExp(`(^|[\\s._-])${esc}([\\s._-]|$)`);
    const mine = allZips.filter((f) => verRe.test(f) && /win/i.test(f));
    for (const f of allZips) {
      if (!mine.includes(f)) dim(`  跳过非本批次 zip：${f}`);
    }
    if (!mine.length) {
      // 不能静默：artifactName 不含 win / 不含版本号时这里会零收，
      // 用户会以为免安装包已进 package/（实际只有安装包）。
      warn(`未找到本批次 win zip（version=${VERSION}）——若项目配置了 zip 目标，请核对 artifactName`);
    }
    for (const f of mine) {
      const dest = path.join(outDir, asciiName(f));
      if (fs.existsSync(dest)) continue;
      fs.copyFileSync(path.join(OUTPUT_DIR, f), dest);
      dim(`  额外收齐（不在清单内）：${path.basename(dest)}`);
    }
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
      const h = sha512Buffer(buf);
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

// ---------- 产物校验（Windows） ----------
/**
 * 收尾后跑 verify-win-artifact.mjs 做产物级断言。
 *
 * 这是 §0 铁律 4 的落地：构建成功 ≠ 可分发。签名被跳过、签名晚于 sha512、
 * 旧批次混入、PE 架构不符，都不会让构建失败，只会在客户端暴露。
 * 校验脚本用 --json 输出，本函数负责渲染与汇总；退出码非 0 直接判失败。
 */
function runWinVerify(dir) {
  const script = path.join(SKILL_DIR, 'verify-win-artifact.mjs');
  if (!fs.existsSync(script)) return { skipped: true, reason: `找不到校验脚本：${script}` };
  const jsonOut = path.join(os.tmpdir(), `electron-release-verify-${process.pid}-${Date.now()}.json`);
  const args = [
    script,
    '--dir',
    dir,
    '--manifest',
    'latest.yml',
    '--expect-version',
    String(VERSION),
    '--json-out',
    jsonOut,
  ];
  if (EXPECT_ARCH) args.push('--expect-arch', String(EXPECT_ARCH));
  // 明确不签名的项目（--skip-sign / 项目配置 method=none / --allow-unsigned）里，
  // 未签名是预期结果，校验应记 SKIP 而不是 FAIL
  if (ALLOW_UNSIGNED || signing.mode === 'unsigned') args.push('--allow-unsigned');
  if (VERIFY_STRICT) args.push('--strict');
  // stdio: 'ignore' + --json-out：受限沙箱禁止管道捕获，用文件取回结果
  const r = spawnSync(process.execPath, args, { stdio: 'ignore', windowsHide: true });
  let out = '';
  try {
    if (fs.existsSync(jsonOut)) out = fs.readFileSync(jsonOut, 'utf8');
  } finally {
    try {
      fs.unlinkSync(jsonOut);
    } catch {
      /* 清理失败不影响结果 */
    }
  }
  if (!out) {
    return {
      skipped: false,
      exitCode: 2,
      data: null,
      out: `校验脚本没有产出结果（退出码 ${r.status}${r.error ? `，${r.error.code || r.error.message}` : ''}）`,
    };
  }
  let data = null;
  try {
    data = JSON.parse(out);
  } catch {
    data = null;
  }
  return {
    skipped: false,
    exitCode: typeof r.status === 'number' ? r.status : data?.exitCode ?? 2,
    data,
    out,
  };
}

function renderWinVerify(result) {
  if (!result.data) {
    bad('校验脚本输出无法解析，原始输出：');
    console.log((result.out || '').split('\n').slice(-20).map((l) => '    ' + l).join('\n'));
    return;
  }
  for (const item of result.data.results) {
    const icon = item.status === 'PASS' ? '✓' : item.status === 'FAIL' ? '✗' : '!';
    const color = item.status === 'PASS' ? C.g : item.status === 'FAIL' ? C.r : C.y;
    console.log(`  ${color}${icon}${C.x} ${item.name}${item.detail ? `  — ${item.detail}` : ''}`);
  }
  const failed = result.data.failed || 0;
  const skipped = result.data.skipped || 0;
  if (result.exitCode === 0) {
    ok(`产物校验通过（${result.data.results.length - skipped} 项，SKIP ${skipped} 项）`);
  } else if (result.exitCode === 3) {
    bad(`产物校验未通过：--strict 下存在 ${skipped} 项 SKIP（发布门禁）`);
  } else {
    bad(`产物校验未通过（FAIL ${failed} 项，SKIP ${skipped} 项，退出码 ${result.exitCode}）`);
  }
}

/** 从校验结果里提炼一行签名结论（无法确认时明确写「未确认」） */
function signatureSummary(data) {
  const auth = data?.results?.find((r) => /^Authenticode/.test(r.name));
  const ts = data?.results?.find((r) => /^时间戳/.test(r.name));
  if (!auth) return '未确认';
  if (auth.status === 'PASS') {
    return `已签名（${auth.detail}）${ts?.status === 'PASS' ? '，含时间戳' : ts?.status === 'FAIL' ? '，缺时间戳' : ''}`;
  }
  if (auth.status === 'SKIP') return '未签名（已明确接受，用户会看到 SmartScreen）';
  return `签名无效（${auth.detail}）`;
}

// ---------- 主流程 ----------
console.log(`${C.c}══ Electron 构建（自包含，不依赖项目脚本）══${C.x}`);
log(`项目：${ROOT}`);
log(`分支：${(spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).stdout || '').trim() || '(非 git 仓库)'}`);
log(`版本：${VERSION}   平台：${PLATFORM}   输出：${OUTPUT_DIR}/`);
if (projectConfig.present && projectConfig.config) dim(`项目配置：${projectConfig.path}`);

const plan = pickBuildCommand();
if (plan.origin === 'platform') ok(`使用平台脚本：${plan.via}`);
else if (plan.origin === 'generic') ok(`使用通用打包脚本：${plan.via}`);
else if (plan.origin === 'config') ok(`使用项目配置指定的命令：${plan.via}`);
else if (plan.origin === 'compile') {
  warn(`只有编译脚本 ${plan.via}：它不产出安装包与更新清单，收尾很可能失败`);
} else warn(`项目无可用打包脚本，回退到：${plan.via}（本脚本会补齐收尾）`);
if (plan.platformHint) warn(plan.platformHint);
// 项目脚本里若显式写了 --publish always/onTag，构建就会触发远端写操作（不可逆）。
// 本脚本不擅自改动项目命令，但必须让人看到这一步。
const publishMode = /--publish\s+(\S+)/.exec(String(plan.shellCommand || (pkg.scripts || {})[plan.args?.[1]] || ''));
if (publishMode && !/^(never|false)$/i.test(publishMode[1])) {
  warn(`项目脚本包含 ${publishMode[0]}：构建会触发远端发布（不可逆），请确认版本与目标仓库后再继续`);
}

const outDir = opt('--out') || path.join(OUTPUT_DIR, 'package');

// `--out` 指到产物目录本身时自毁：finalize 开头就 rmSync(outDir) 重建，
// 刚构建的 exe / win-unpacked 会一起被删，随后报「清单引用的产物不存在」，
// 看不出真实原因。这里直接拒绝，比事后排查便宜。
if (!DRY && !NO_FINALIZE && path.resolve(outDir) === path.resolve(OUTPUT_DIR)) {
  bad(`--out 不能等于产物目录本身（${OUTPUT_DIR}）：收尾会清空该目录`);
  process.exit(2);
}

// ---- Windows 宿主与签名前置（必须早于构建）----
if (PLATFORM === 'win' && !IS_WIN && !ALLOW_CROSS_BUILD) {
  bad('Windows 打包必须在 Windows 宿主执行：原生模块无法交叉编译，node-gyp 也拒绝跨平台构建');
  dim('只出纯 JS 包且已装 Wine 时可加 --allow-cross-build 尝试，但不属于官方支持路径');
  process.exit(2);
}

let signing = { mode: 'n/a', certs: [], hints: [] };
if (PLATFORM === 'win') {
  signing = resolveWindowsSigning({
    projectRoot: ROOT,
    packageBuild: build,
    projectConfig: projectConfig.config,
    sha1: SIGN_SHA1,
    subject: SIGN_SUBJECT,
    timestampUrl: TIMESTAMP_URL,
    allowUnsigned: ALLOW_UNSIGNED,
    skipSign: SKIP_SIGN,
  });
  if (signing.mode === 'cert') {
    ok(`签名：${signing.cert.Subject}`);
    dim(`thumbprint   ${signing.cert.Thumbprint}`);
    dim(`来源         ${signing.source}`);
    dim(`时间戳       ${signing.timestampUrl}`);
  } else if (signing.mode === 'pfx' || signing.mode === 'pfx-env') {
    ok(`签名：PFX（${signing.source}）${signing.reason ? '  ' + signing.reason : ''}`);
  } else if (signing.mode === 'unsigned') {
    warn(`不签名：${signing.reason || signing.source}`);
    STRIP_SIGNING_ENV = true;
    const pkgSig = (build.win && build.win.signtoolOptions) || build.win || {};
    const configured = pkgSig.certificateSha1 || pkgSig.certificateSubjectName || pkgSig.certificateFile;
    if (configured) {
      warn('项目构建配置里已声明签名证书：--skip-sign / method=none 不会覆盖 electron-builder 的配置，产物仍会被签名');
      dim('  若要真正不签名，需从 package.json#build.win.signtoolOptions 移除证书字段');
    }
  } else if (signing.mode === 'choose') {
    if (DRY) {
      warn(`dry-run 预检：${signing.error || '存在多张可用证书'}`);
      for (const hint of signing.hints) dim(`  ${hint}`);
    } else {
      bad(signing.error || '存在多张可用证书');
      for (const hint of signing.hints) dim(`  ${hint}`);
      process.exit(2);
    }
  } else {
    if (DRY) {
      warn(`dry-run 预检：${signing.error || signing.reason || signing.mode}`);
      for (const hint of signing.hints || []) dim(`  ${hint}`);
    } else {
      bad(`签名前置检查未通过：${signing.error || signing.reason || signing.mode}`);
      for (const hint of signing.hints || []) {
        for (const line of String(hint).split('\n')) dim(`  · ${line.trim()}`);
      }
      dim('可先单独运行：node <SKILL_DIR>/scripts/preflight-win-sign.mjs <项目> --warmup');
      process.exit(2);
    }
  }
}
const signingArgs = buildSigningArgs(signing);
if (signingArgs.length) dim(`electron-builder 签名参数：${signingArgs.join(' ')}`);

if (DRY) {
  dim(`收尾目录     ${outDir}/`);
  if (WARMUP && signing.mode === 'cert') dim('dry-run：不执行预热签名');
  dim('dry-run：以上为将要执行的步骤，未实际运行');
  process.exit(0);
}

// 预热签名：把 PIN / 手机确认从「构建卡住」前移到构建之前
if (WARMUP && signing.mode === 'cert') {
  log('预热签名（触发 PIN / 手机确认）');
  const warmed = prewarmSigning({ signing, projectRoot: ROOT, outputDir: OUTPUT_DIR });
  if (!warmed.ok) {
    bad(`预热失败：${warmed.reason}`);
    process.exit(2);
  }
  ok(`预热成功：${warmed.signtool}`);
}

// 构建前提示旧产物批次
if (!NO_FINALIZE && fs.existsSync(outDir)) {
  const b = checkBatch(outDir);
  if (!b.ok) warn(`${outDir}/ 存在旧产物（${b.reason}）—— 构建不可复现，收尾时会重建`);
}

if (!SKIP_BUILD) {
  if (!runTests()) process.exit(1);

  let buildRes = doBuild(plan, signingArgs);

  // 兜底 1：npm 脚本 / .bin shim 不可用（跨平台拷贝来的 node_modules 常见）
  if (!buildRes.ok && shouldFallbackToCli(buildRes)) {
    const alt = buildWithNodeCli(buildRes.via, signingArgs);
    if (alt) buildRes = alt;
  }

  // 兜底 2：rcedit 被实时防护瞬时锁定（Windows 必现，等 8~30s 即恢复）
  if (!buildRes.ok && PLATFORM === 'win' && /Unable to commit changes/i.test(buildRes.out)) {
    bad('rcedit 被实时防护短暂锁定，进入退避补写');
    if (!recoverFromRceditLock(buildRes.out, signingArgs)) process.exit(3);
    buildRes = { ok: true, out: '', via: 'prepackaged 续跑' };
  }

  if (!buildRes.ok) {
    bad(`构建失败（${buildRes.via}），末尾输出：`);
    console.log(buildRes.out.split('\n').slice(-20).map((l) => '    ' + l).join('\n'));
    process.exit(3);
  }
} else {
  warn('--skip-build：跳过测试与构建，直接对现有产物做收尾与校验');
}

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

if (!SKIP_BUILD) {
  const b = checkBatch(outDir);
  if (b.ok) ok('批次核对：收尾产物与本次构建同批次');
  else warn(`批次核对异常：${b.reason}`);
}

let verifyResult = null;
if (PLATFORM === 'win' && !NO_VERIFY) {
  log('产物校验：清单 / sha512 / PE 架构 / blockmap / Authenticode');
  verifyResult = runWinVerify(outDir);
  if (verifyResult.skipped) {
    warn(verifyResult.reason);
  } else {
    renderWinVerify(verifyResult);
    if (verifyResult.exitCode !== 0) {
      bad('产物校验未通过，产物不得分发');
      process.exit(1);
    }
  }
}

console.log('');
log(`完成 v${VERSION}（未提交、未上传）`);
dim(`可分发目录   ${outDir}/`);
dim(`原始产物     ${OUTPUT_DIR}/`);
dim(`清单         ${path.join(outDir, path.basename(manifestPathFor(PLATFORM === 'all' ? 'mac' : PLATFORM)))}`);
if (verifyResult?.data) dim(`签名         ${signatureSummary(verifyResult.data)}`);
console.log('');
warn('以下需人工完成：');
if (PLATFORM === 'win') {
  if (signing.mode === 'cert') {
    dim('  · 签名已完成；若客户端更新校验失败，核对 publisherName 与证书 Subject 是否完全一致');
  } else {
    dim('  · 产物未签名：首次安装与每次升级都会被 SmartScreen 拦截（不是 bug）');
  }
} else {
  dim('  · 签名/公证：按 references/mechanism.md 手工核对，本脚本不代签');
}
dim('  · 版本号：若 tag 已存在，必须先递增版本号（客户端按 semver 判断是否升级）');
dim('  · 发布：推 tag → 建 Release → 改写清单为绝对地址 → 部署到更新源');
process.exit(0);
