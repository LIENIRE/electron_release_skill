# electron-release

跨agent、跨 IDE 通用的 Electron 打包 / 签名 / 公证 / 发布流程技能包。

一套文件，多处引用。默认软链到各 agent 的技能目录，**单一源，不会各自漂移**。

---

## 这个 skill 解决什么问题

Electron 打包看着是`npx electron-builder` 一条命令，实际有三个反复踩的坑：

1. **构建成功 ≠ 能分发**。没配签名时 electron-builder 照样成功退出，日志只有一行 warn，
   但用户装上会被 Gatekeeper 拦。
2. **清单与产物必须成对**。构建不可复现——同一个版本号打两次，sha512 不同。
   清单配了旧产物，客户端下载后校验失败直接拒更新。
3. **更新源挂掉时难定位**。是服务器没文件，还是本地代理劫持了 DNS？没有工具就只能猜。

这个 skill 把这三件事做成了可执行的断言。

---

## 安装

解压后目录结构（`SKILL.md` 位于 `electron-release/` 根目录）：

```
electron-release/
├── SKILL.md                    # 技能定义，YAML frontmatter 含 name 与 description
├── README.md
├── LICENSE
├── scripts/                    # probe.sh / probe.mjs / verify-artifact.sh
│                               # verify-win-artifact.mjs / manifest-cli.mjs / build.mjs / install.sh
│   └── lib/                    # 共用模块：manifest（清单解析）/ windows-sign / powershell / project-config
├── references/
│   ├── mechanism.md            # mac 为主：公证、凭据、清单结构、坑位
│   └── windows.md              # Windows 分册：NSIS、签名时序、云签名器、故障树
├── tests/
│   └── smoke.mjs               # 可复跑自测（合成夹具，10 项契约断言）
└── assets/
    └── project-config.template.json
```

```bash
# 1. 放到中立位置（跨 agent 中枢）
mkdir -p ~/.agents/skills && unzip electron-release-skill.zip -d ~/.agents/skills/

# 2. 链接到已装的 agent
bash ~/.agents/skills/electron-release/scripts/install.sh --list   # 先看支持项
bash ~/.agents/skills/electron-release/scripts/install.sh   # 自动探测并链接
```

支持的位置（`--list` 会显示本机哪些存在）：

| ID | 路径 | Agent |
|---|---|---|
| `agents` | `~/.agents/skills/` | 通用（跨 agent 中枢） |
| `claude` | `~/.claude/skills/` | Claude Code |
| `codex` | `~/.codex/skills/` | Codex |
| `cursor` | `~/.cursor/skills/` | Cursor |
| `windsurf` | `~/.codeium/windsurf/skills/` | Windsurf |
| `gemini` | `~/.gemini/skills/` | Gemini CLI |
| `copilot` | `~/.config/github-copilot/skills/` | GitHub Copilot CLI |
| `workbuddy` | `~/.workbuddy/skills/` | WorkBuddy |

其他参数：`--copy` 用复制代替软链（跨机/ Windows / 不支持符号链接的环境）、
`--all` 装到全部位置、`--link <id...>` 只装指定几个。

### 项目级安装（随仓库分发）

把整个 `electron-release/` 目录放进仓库，团队克隆即用：

```
<repo>/.agents/skills/electron-release/     # 跨 agent
<repo>/.claude/skills/electron-release/     # Claude Code 专用
<repo>/.workbuddy/skills/electron-release/  # WorkBuddy 专用
```

提交前确认配置类文件（`.electron-release.json`）不含凭据。

---

## 使用

### 方式一：让 agent 自动触发

装好后直接说人话即可，描述里的触发词会被匹配：

- 「帮我打个包」「出 dmg」「构建安装包」
- 「要发版了，跑一下 release」
- 「公证怎么配」「去掉 Gatekeeper 拦截」
- 「electron-updater 拉不到包」「检查更新失败」

### 方式二：手动跑脚本

四个校验/探测脚本都可独立使用，**只读、不改项目文件**（`install.sh` 除外，它专门做安装）：

```bash
S=~/.agents/skills/electron-release

# 探测项目画像（含 Windows 签名方式与 NSIS 默认值）
bash $S/scripts/probe.sh /path/to/project
bash $S/scripts/probe.sh . --json              # 供程序消费

# 验证签名 / 公证（自动挂载 dmg 取内部 .app）
bash $S/scripts/verify-artifact.sh dist/app.dmg

# 验证清单与产物是否配对（逐条比对 size + sha512）
bash $S/scripts/verify-artifact.sh --manifest dist/latest-mac.yml --dir dist

# Windows：清单 + sha512 + PE 架构 + blockmap + Authenticode
node $S/scripts/verify-win-artifact.mjs --dir release --expect-version 1.2.3 --expect-arch x64

# 验证线上更新源（不可达时自动区分服务器问题 vs 代理问题）
bash $S/scripts/verify-artifact.sh --feed https://example.com/updates/ 1.2.3
```

> Windows 侧不要只确认"`latest.yml` 存在"。签名时序错误、混入旧批次、架构不符都不会让
> 构建失败，只会在客户端更新或启动时暴露。`verify-win-artifact.mjs` 就是为这三类问题
> 做产物级断言。

---

## 一键构建

```bash
# 推荐：自动选命令 + 自动收尾 + 自动校验 + 批次核对
node ~/.agents/skills/electron-release/scripts/build.mjs [选项] [项目根目录]

# 只看会执行什么，不实际构建
node ~/.agents/skills/electron-release/scripts/build.mjs --dry-run .
```

| 选项 | 说明 |
|---|---|
| `--platform mac\|win\|linux\|all` | 构建平台（默认 mac）；选项与位置参数顺序无关。**两平台请分开跑**，`all` 的收尾只读 `latest-mac.yml`，且共用 `package/` 会互相覆盖 |
| `--out <目录>` | 收尾产物目录（默认 `<outputDir>/package`，不再影响 builder 输出目录） |
| `--name-prefix <前缀>` | 指定产物 ASCII 前缀（默认从包名/appId 推断） |
| `--skip-tests` | 跳过单元测试 |
| `--skip-build` | 跳过测试与构建，只重跑收尾 + 校验 |
| `--no-finalize` | 只构建，不收尾不校验 |
| `--no-verify` | 收尾后不跑 `verify-win-artifact.mjs` |
| `--dry-run` | 只打印将执行的步骤 |
| `--sign-sha1 <40位>` | Windows 证书指纹；默认依次取 `SIGN_SHA1` / `.electron-release.json` / `package.json` |
| `--sign-subject <子串>` | 按 Subject 选择 Windows 证书 |
| `--timestamp-url <URL>` | RFC3161 时间戳服务 |
| `--warmup` | 构建前预热签名（SimplySign 的 PIN/手机确认） |
| `--skip-sign` | 不签名（同时剥离 `WIN_CSC_LINK` 等凭据变量） |
| `--allow-unsigned` | 没有可用证书时继续（未签名产物会触发 SmartScreen） |
| `--expect-arch x64\|arm64` | 产物架构断言（NSIS 包自动校验载荷） |
| `--strict` | 校验出现 SKIP 也算失败（发布门禁） |

**它解决四个高频问题**：

1. **打包脚本只在部分分支上存在** —— 自动按 `package` → `build:mac` → 裸
   `electron-builder` 选择，缺失时明确提示「本脚本将补齐收尾」
2. **裸 builder 不做收尾** —— 无论用哪个命令，都统一执行「以清单 files[] 为权威来源
   收齐 → ASCII 改名（含 `.blockmap` 同名）→ YAML 解析改写 url → 逐条校验 sha512 → 批次核对」
3. **`npm run` / `npx` 在本机不可用** —— `.bin` 缺本平台 shim（`node_modules` 跨平台拷来的）
   时，自动回退 `node node_modules/electron-builder/cli.js`
4. **Windows rcedit 被实时防护锁定** —— 解析日志里的原始 rcedit 命令行退避补写，
   再用 `--prepackaged` 只补跑分发目标，不整包重跑

> ⚠️ 换了构建命令**不等于**可以跳过收尾。`build:mac` 与裸 `electron-builder` 都不会
> 产 ASCII 名与配对清单，直接投放会导致客户端 sha512 校验失败。

## Windows 签名（SimplySign / 证书存储）

把项目脚本里硬编码的证书指纹通用化成了「预检 + 自动注入」两步，**不需要改项目代码**：

```bash
S=~/.agents/skills/electron-release

# ① 首次 / 换机：确认登录态、证书可见、PIN 已预热（会弹 PIN/手机确认）
node $S/scripts/preflight-win-sign.mjs <项目> --warmup

# ② 打包：自动解析证书 → 注入 signtoolOptions → 构建 → 收尾 → 产物校验
node $S/scripts/build.mjs --platform win --expect-arch x64 <项目>
```

证书来源优先级：`--sign-sha1` / `--sign-subject` → `SIGN_SHA1` → `.electron-release.json`
→ `package.json#build.win.signtoolOptions` → 证书存储里唯一一张可用证书。
命中多张会停止并列出候选，不会猜。

**默认安全姿态**：Windows 上找不到可用证书、项目也没声明不签名时，`build.mjs` 在构建前
以退出码 2 停止，避免产出「能装但没签名」的包。确实不签名请显式 `--allow-unsigned`
或在项目里写 `signing.windows.method: "none"`。

构建后会自动跑 `verify-win-artifact.mjs`：清单 / sha512 / PE 架构 / blockmap / Authenticode，
任一 FAIL（或 `--strict` 下的 SKIP）都会让本次构建失败。

Windows 上一次成功构建的真实日志（用于对照是否走到兜底分支）：

```
▸ 构建：npm run build:win
! npm 脚本不可用（npm run build:win），回退到 node cli.js
✗ rcedit 被实时防护短暂锁定，进入退避补写
  ✓ rcedit 补写成功（第 2 次尝试）
▸ 续跑分发目标：--prepackaged dist\win-unpacked
✓ idea-note-Setup-1.1.1.exe  94MB
```

## 脚本能力

### `probe.sh` —— 项目画像探测

只读，一次跑完：项目名与版本、产品名与 appId、打包工具、**配置来源**
（`package.json#build` 还是独立 `electron-builder.yml`）、各平台 target、输出目录、
files 白名单、publish 配置、图标是否存在、签名与公证状态、已设/未设的凭据、产物现状。

自动分流：

| 探测到 | 走哪条路 |
|---|---|
| electron-builder | 标准流程 |
| Electron Forge | 提示改用 `forge make` / `forge publish` |
| electron-packager | 说明只出 `.app`，无安装包与更新清单 |
| 非Electron 项目 | 退出码 3 |

`probe.sh` 是包装层：有 Node 走 `probe.mjs`（零依赖，自带 YAML 段解析器），
无 Node 降级为 grep/sed 提取关键字段。

### `verify-artifact.sh` —— 三种校验模式

**① 签名 / 公证 / staple**

```
$ verify-artifact.sh dist/app.dmg
挂载 dist/app.dmg ...
── 签名 ──
✗ 未签名（Gatekeeper 会拦截，需用户手动放行）
── 公证 ──
✗ Gatekeeper 拒绝：source=no usable signature
── staple（公证票据装订）──
! staple 无效或不存在（dmg 需 electron-builder 之外手动 xcrun stapler staple）
```

能区分「完全无签名」与「ad-hoc 签名」——后者是新版 Electron 的
`linker-signed` 产物，仍等于不可分发，但不能一概而论。

**② 清单配对**

```
$ verify-artifact.sh --manifest dist/latest-mac.yml --dir dist
✓ app-1.2.3-arm64.dmg  113MB  sha512 匹配
✓ app-1.2.3.dmg  117MB  sha512 匹配
```

清单校验走 `scripts/manifest-cli.mjs`：**零第三方依赖**（内置解析器只认 electron-updater
固定形态）。装了 `js-yaml` 时 `build.mjs` 会自动改用它以保留清单里的未知字段；
系统 `pyyaml` 只作为没有 Node 时的兜底。两者都没有才明确报错（**不静默跳过**）。

**③ 线上更新源**

```
$ verify-artifact.sh --feed https://example.com/updates/ 1.2.3
! 清单不可访问（HTTP 404，出口 127.0.0.1；绕过代理后 HTTP 404）
! 域名解析到 198.18.67.158 —— RFC 2544 保留段，是 Clash/mihomo 的 fake-IP 池
✗ 代理与直连结果一致（均 404）→ 服务器侧确实没有该文件，不是代理问题
  处理：① 确认部署目录是否存在  ② 核对 web server root/alias  ③ 确认清单文件名
```

关键能力：**自动做「走代理 vs `--noproxy` 直连」双路对比**，避免把服务器问题
误判成代理问题。同时校验线上版本与期望是否一致、检查清单 url 是相对（同目录托管）
还是绝对地址（分开托管）。

### `preflight-win-sign.mjs` —— Windows 签名前置检查

```bash
node scripts/preflight-win-sign.mjs <项目> [--sha1 <指纹>] [--warmup] [--allow-unsigned] [--json]
```

```
▸ 证书存储：Cert:\CurrentUser\My（代码签名 EKU）
  候选 · CN=射手科技（珠海）有限公司, O=…  thumbprint=…  HasPrivateKey=True  NotAfter=2027-09-01
✓ 可用证书：CN=…
  thumbprint   f37ada…
  HasPrivateKey True    NotAfter 2027-09-01
  来源         证书存储（唯一可用证书）
  时间戳       http://timestamp.digicert.com
  signtool     …\winCodeSign-2.6.0\windows-10\x64\signtool.exe
```

| 能力 | 说明 |
|---|---|
| 证书枚举 | `Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert`，区分 `HasPrivateKey` 与过期 |
| 来源判定 | 命令行 / `SIGN_SHA1` / `.electron-release.json` / `package.json` / 存储唯一证书；多命中返回退出码 3 |
| 登录态提示 | 只读存储；失败时明确提示 SimplySign 是否登录、是否 `0 certs were left` |
| `--warmup` | 用 builder 缓存里的 64 位 signtool 对**临时副本**签一次，触发 PIN/手机确认后删除，不改项目产物 |
| `--json` | 供 agent/CI 消费；`--allow-unsigned` 时明确返回「接受不签名」 |

退出码：0 可签 / 已接受不签名；1 不可签；2 参数或环境错误；3 命中多张证书。

### `verify-win-artifact.mjs` —— Windows 产物断言

```bash
node scripts/verify-win-artifact.mjs --dir dist/package --expect-version 1.1.1 \
  --expect-arch x64 --allow-unsigned
```

```
✓ 清单存在  — dist/package/latest.yml
✓ 版本一致  — 1.1.1
✓ sha512 一致：idea-note-Setup-1.1.1.exe  — 8kY2uDNmVaSeublo…
✓ PE 架构：idea-note-Setup-1.1.1.exe  — NSIS 引导 x86（正常）+ 载荷 x64
✓ blockmap：idea-note-Setup-1.1.1.exe  — 同批（mtime 差 2s）
! Authenticode：… — 未签名（--allow-unsigned 已声明接受，用户会看到 SmartScreen）
结论：通过（9 项），SKIP 2 项需人工复核
```

| 能力 | 说明 |
|---|---|
| 清单配对 | version / size / sha512 / `path` 与 `files[0]` 一致 |
| PE 架构 | 识别 `NullsoftInst`，NSIS 包改为校验 `win-unpacked` 载荷，不误报 x86；找不到载荷记 SKIP（不记 PASS） |
| blockmap 批次 | 与安装包 mtime 比对，识别混入旧批次 |
| Authenticode | Windows 走 `Get-AuthenticodeSignature`（`-EncodedCommand`，兼容中文路径）；Windows 上执行失败记 **FAIL**，不降级为 SKIP |
| `--allow-unsigned` | 不签名项目把 `NotSigned` 降为 SKIP，其余项仍作硬门禁 |
| `--strict` | 有 SKIP 即非 0（退出码 3），发布门禁用；默认 `exit 0 = 无 FAIL` |
| 入口自检 | 无法确认 CLI 入口时 **exit 2**，不会静默 `exit 0` 假装通过 |

---

## 覆盖范围

| 环节 | 内容 |
|---|---|
| 打包 | electron-builder（两种配置来源）、Electron Forge（分流）、electron-packager（分流） |
| 产物 | macOS `dmg`/`zip`/`pkg`、Windows `nsis`/`portable`/`msi`、Linux `AppImage`/`deb`/`rpm`/`snap` |
| 签名 | macOS Developer ID（钥匙串 / `.p12`，含 hardenedRuntime + entitlements + gatekeeperAssess）；Windows 证书存储 / PFX / SimplySign 云签名器，含签名时序与时间戳 |
| 公证 | `notarytool` 凭据两套方案、dmg 手动 staple |
| 发布 | GitHub Release / generic 自建更新源、清单改写与原子部署 |
| 验证 | 签名公证断言、清单 sha512 配对、线上源可达性诊断、Windows PE 架构与 blockmap 批次 |

**不覆盖**：iOS/tvOS App Store（MAS）应用、Tauri/Neutralino 等非 Electron 框架。

---

## 依赖

| 依赖 | 必需 | 缺失时 |
|---|---|---|
| bash | 是 | 无法执行 shell 脚本 |
| Node.js 16+ | 否 | `probe.sh` 降级为 grep/sed 探测 |
| macOS 工具链 | 仅签名验证 | 非 macOS 提示改用对应平台命令 |
| `js-yaml` | 否 | 清单校验改用内置零依赖解析器（只认 electron-updater 固定形态） |
| `pyyaml` | 否 | 仅在没有 Node 时作为 `verify-artifact.sh` 的兜底；两者皆无才报错 |
| Windows C++ 工具链 | 视原生模块而定 | `node-gyp-build` 类型模块会走源码编译，缺工具链即失败（见 `references/windows.md` §2.3） |

---

## 已验证范围

下表的断言已收敛为可复跑脚本：`node tests/smoke.mjs`（合成夹具，10 项，3 秒，不联网）。
它只证明脚本自身契约没坏，**不替代**真实项目的端到端打包。

| 项 | 验证方式 |
|---|---|
| 探测脚本 | 4 类项目实测：electron-builder(package.json)、electron-builder(yml)、Forge、非 Electron |
| 签名识别 | 真实 dmg 实测，能区分无签名与 ad-hoc |
| 清单配对 | 真实 `latest-mac.yml` + 真实产物，多产物 sha512 全匹配；错误目录正确报缺失 |
| 清单解析统一 | `scripts/lib/manifest.mjs` 单一实现：夹具实测「通过 / 篡改产物 / 缺 files / 缺参数」四类输入，退出码 0/1/1/2；`build.mjs --skip-build` 在项目无 `js-yaml` 时走内置解析器仍完成收尾，有 `js-yaml` 时确认走库分支 |
| 无 Node 降级 | `env -i` 模拟，核心字段仍正确提取 |
| 完整构建 | 在 idea-note-desktop 实测 `electron-builder --mac`，arm64+x64 共 4 个安装包 + blockmap，36 秒完成 |
| Windows 产物校验 | 临时产物 + 手工构造 `latest.yml`：正向 9 项 PASS；注入 sha512 篡改、架构不符、blockmap 旧批次三类故障均被拦截；退出码 0/1/2 正确 |
| Windows 签名探测 | 真实项目实测：正确识别 `publisherName`、RFC3161 时间戳、缺省 `nsis` 块（`oneClick=true`） |
| Windows 端到端打包 | 真实项目（Electron 33.4.11 + electron-builder 25.1.8，Windows 11 26200 / Node 22）：`build.mjs --platform win` 一次跑通「测试 144 用例 → npm shim 回退 → rcedit 锁退避补写 → `--prepackaged` 续跑 nsis/zip → ASCII 改名 + blockmap 同名 + latest.yml 配对 → 校验通过」 |
| Windows 产物校验（降级路径） | 同一产物上验证：NSIS 载荷架构识别、blockmap 同批、`--allow-unsigned` 降级、退出码 0/1 区分（用 `--expect-version` 传错版本确认会 FAIL） |
| Windows 签名前置/注入 | 合成产物 + 真实 `package.json` 实测：无证书时 `preflight` 退出码 1 并给出登录提示；`build.mjs --platform win` 在构建前停止（退出码 2）；`method:none` / `--skip-sign` / `--allow-unsigned` 正确放行；签名参数按 electron-builder 语法拼装（`--c.win.signtoolOptions.*`），npm 脚本 / `node cli.js` / `--prepackaged` 三条路径都会带 |
| 收尾 + 校验闭环 | 合成 `latest.yml + NSIS PE + blockmap`：`build.mjs --skip-build` 完成 ASCII 改名 → 清单改写 → sha512 配对 → 自动跑 `verify-win-artifact`（含 SKIP/`--strict` 退出码）；`--out` 自定义目录可用（修复了旧版必然自毁的缺陷） |
| 受限沙箱 | 在禁止管道捕获的沙箱里，证书枚举与 Authenticode 校验改为临时文件取回结果，可正常执行 |

**未验证**：

- 含**原生模块**的 Windows 打包（需 Windows 宿主 + 真实 ABI 切换脚本）。
- 真实证书签名的 Authenticode 分支（当前只在未签名产物上验过 `NotSigned` 路径、
  `Get-AuthenticodeSignature` 的 JSON 解析链路）。
- SimplySign 真实 PIN 交互（代码路径已实现：枚举 → 来源判定 → `--warmup` → 注入参数；
  但没有可用的云证书，未在真机上完成一次签名）。

skill 中标注为「无法验证时须如实告知」。

---

## 已知边界

- 机制细节基于 electron-builder 25.1.8 / @electron/notarize 2.5.0。
  其他版本的公证字段默认值**需读该项目 node_modules 确认**。
- 脚本里的路径用 `<SKILL_DIR>` 约定，不含任何写死的本机路径。
- 涉及凭据与远端写操作的步骤一律要求人工确认，脚本不会代为执行。
- 在 WorkBuddy 内跑 electron-builder 需先 `env -u NODE_OPTIONS`，
  否则文件代理 shim 会打断 asar 写入（见坑位 #18）。

---

## 文件结构

```
electron-release/
├── SKILL.md                    # 主流程（agent 读取的入口）
├── README.md                   # 本文件
├── LICENSE                     # MIT
├── scripts/
│   ├── build.mjs               # 一键构建：签名预检 → 选命令 → 收尾 → 产物校验
│   ├── preflight-win-sign.mjs  # Windows 签名前置检查（证书/来源/PIN 预热）
│   ├── probe.sh                # 探测包装层（无 Node 自动降级）
│   ├── probe.mjs               # 探测核心（零依赖）
│   ├── verify-artifact.sh      # macOS：签名 / 公证 / 清单 / 线上源
│   ├── verify-win-artifact.mjs # Windows：清单 / sha512 / PE / blockmap / Authenticode
│   ├── manifest-cli.mjs       # 清单 ↔ 产物配对校验 CLI（零依赖，供 verify-artifact.sh 调用）
│   ├── install.sh              # 多agent 安装器
│   └── lib/
│       ├── manifest.mjs        # 清单解析/序列化唯一实现（parse / dump / sha512）
│       ├── windows-sign.mjs    # 证书枚举 / 来源判定 / builder 参数 / 预热
│       ├── project-config.mjs  # 读取 .electron-release.json
│       └── powershell.mjs      # 受限沙箱下的 PowerShell 结果取回
├── references/
│   ├── mechanism.md            # mac 机制速查 + 坑位清单
│   └── windows.md              # Windows 分册：十阶段、NSIS、签名时序、云签名器、故障树
└── assets/
    └── project-config.template.json  # 项目级配置模板
```

`SKILL.md` 是入口，`references/` 只在被问到细节时才读——节省上下文。

许可：MIT，可自由修改分发。