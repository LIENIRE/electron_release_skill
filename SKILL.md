---
name: electron-release  
description: >-  
  Electron 应用的打包、代码签名、公证（notarization）与发布。适用于任何基于  
  Electron + electron-builder / Electron Forge / electron-packager 的项目。当用户要  
  "打包 / 构建安装包 / 出 dmg / 出 mac app / 出 Setup.exe / 出 AppImage"、"签名 /  
  公证 / notarize / staple / 去掉 Gatekeeper 拦截"、"发版 / 发布新版本 / 更新线上版本 /  
  跑 release"、"自动更新问题（electron-updater 拉不到包 / latest-mac.yml 不可用 /  
  检查更新失败 / 清单版本对不上）"时使用。覆盖 macOS（Developer ID + notarization +  
  staple + entitlements）、Windows（NSIS + signtool / 云签名器 / 产物校验）、Linux  
  产物，以及 GitHub Release / 自建更新源两种分发模式。  
  触发词：打包、构建、打包发布、发版、发布、build、package、release、mac 应用、  
  dmg、zip、nsis、pkg、appimage、electron-builder、electron-forge、electron-packager、  
  notarize、公证、签名、stapler、staple、Gatekeeper、electron-updater、latest-mac.yml、  
  latest.yml、blockmap、autoupdates、Setup.exe、Windows 安装包、signtool、  
  SimplySign、云签名、Authenticode、代码签名证书、时间戳。  
---

# Electron 打包与发布

跨agent、跨 IDE 通用。使用前**必须先探测项目画像**，不得凭记忆套用本文档。

## 运行要求

| 项        | 要求                                                    | 缺失时                    |
| -------- | ----------------------------------------------------- | ---------------------- |
| Node.js  | 建议 16+（仅 `probe.mjs` 需要；`verify-artifact.sh` 是纯 bash） | 自动降级为纯 bash 探测，能力缩减但可用 |
| bash     | 必需（`verify-artifact.sh` / `install.sh`）               | 改用 npm 脚本手工执行          |
| macOS 工具 | 签名验证需 `codesign`/`spctl`/`xcrun`（系统自带）                | 非 macOS 明确提示并改用对应平台命令  |
| YAML 解析  | 清单校验需 `js-yaml`（多数 Electron 项目已装）或 `pyyaml`           | 两者皆无则明确报错，**不静默跳过**    |

**平台无关性**：本文档不含任何特定 agent 或 IDE 的路径写死。脚本位置见 §1。

---

## 0. 铁律

| # | 规则                                                                      |
| - | ----------------------------------------------------------------------- |
| 1 | **先探测，再动手**。任何配置（版本号、产物名、输出目录、签名状态）以 `probe.mjs` 的输出为准，本文档里出现的一切具体值都是示例 |
| 2 | **不得篡改清单**。`latest*.yml` 只能 YAML 解析后改写，禁止逐行文本替换                         |
| 3 | **清单与产物必须成对发布**。构建不可复现，同版本两次构建 sha512 不同                                |
| 4 | **构建成功 ≠ 公证成功**。凭据不全时 electron-builder只打 warn 并跳过，必须做产物级断言              |
| 5 | **远端写操作前必须人工确认**。推 tag、建 Release、改线上清单都是不可逆的                            |
| 6 | **未经验证的步骤不得写成结论**。项目自带的脚本可能没跑过，要标注                                      |

---

## 1. 第一步：探测项目画像

### 脚本路径

本文档中的 `<SKILL_DIR>` = 本 skill 所在目录，即本 `SKILL.md` 文件的父目录。  
各agent 的安装位置：

按所在 agent 找本skill 目录：

| Agent                    | 路径                                                               |
| ------------------------ | ---------------------------------------------------------------- |
| 通用（agents 规范，跨 agent 中枢） | `~/.agents/skills/electron-release`                              |
| Claude Code              | `~/.claude/skills/electron-release`                              |
| Codex                    | `~/.codex/skills/electron-release`                               |
| Cursor                   | `~/.cursor/skills/electron-release`                              |
| Windsurf                 | `~/.codeium/windsurf/skills/electron-release`                    |
| Gemini CLI               | `~/.gemini/skills/electron-release`                              |
| GitHub Copilot CLI       | `~/.config/github-copilot/skills/electron-release`               |
| 项目级（随仓库分发）               | `<项目>/.agents/skills/electron-release` 或 `<项目>/.claude/skills/…` |

一次性链接到全部已安装 agent：

```bash
bash <SKILL_DIR>/scripts/install.sh              # 自动探测并链接
bash <SKILL_DIR>/scripts/install.sh --list# 查看支持项与本机状态
bash <SKILL_DIR>/scripts/install.sh --copy       # 用复制（跨机/不支持软链时）
```

若路径报 `No such file`，直接定位：`find ~ -name probe.mjs -path "*electron-release*" 2>/dev/null`。

若下述命令报 `No such file`，先定位：`find ~ -name probe.mjs -path "*electron-release*" 2>/dev/null`。

### 执行

```bash
# 推荐：跨平台包装层，自动在 Node 与纯 bash 之间回退
bash <SKILL_DIR>/scripts/probe.sh [项目根目录]
bash <SKILL_DIR>/scripts/probe.sh . --json

# 等价的直接调用（需 Node）
node <SKILL_DIR>/scripts/probe.mjs[项目根目录]
```

只读，不执行构建、不修改文件。`probe.mjs` 零第三方依赖（自带 YAML 段解析器）；  
`probe.sh` 在无 Node 时降级为 grep/sed 提取关键字段。  
退出码：`0` 识别为 Electron 项目 / `3` 未识别 / `2` 参数错。

输出包含：项目名与版本、产品名与 appId、打包工具、**配置来源**（`package.json#build`  
还是独立 yml）、各平台 target、输出目录、files 白名单、publish 配置、图标是否存在、  
签名与公证配置、已设/未设的凭据变量、产物目录现状。

### 分流

| 探测结果                       | 走哪条路                                                   |
| -------------------------- | ------------------------------------------------------ |
| electron-builder + 配置完整    | **§3 标准流程**                                            |
| Windows 目标 + 需要签名          | §4.6 + `references/windows.md`；构建后用 `verify-win-artifact.mjs` 校验 |
| Windows 目标 + 含原生模块        | 必须在 Windows 宿主构建，见 §5.5                                 |
| Electron Forge             | 改用 `forge make` / `forge publish`；本skill 的清单与公证部分不直接适用 |
| electron-packager（只出 .app） | 无安装包与自动更新清单，跳到 §3.3                                    |
| `identity: null` 且无公证需求    | 跳过 §4签名，走 §3                                           |
| 产物目录已有历史产物                 | 先确认新旧清单是否配对，见 §5.2                                     |

### 项目级配置（可选）

若项目有 `.electron-release.json`，skill 会以其为准覆盖探测默认值。  
模板见 `assets/project-config.template.json`。**不要把含凭据的配置提交到 git。**

---

## 2. 前置检查（自动化，只读）

```bash
# F1 仓库与工作区
git status --porcelain                 # 发布模式要求干净
git log --oneline -1
git tag --sort=-creatordate | head -5  # 核对 tag 与版本号是否一致 ★

# F2 工具链
node -v                                # electron-builder 25 需要 Node >= 20
npx electron-builder --version
command -v gh && gh auth status        # 需要发 GitHub Release 时
command -v notarytool || xcrun -f notarytool   # 需要公证时（macOS）

# F3 签名证书（macOS）
security find-identity -v -p codesigning

# F3' 签名证书（Windows，在 Windows 宿主执行）
powershell -NoProfile -Command "Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.NotAfter -gt (Get-Date) } | Select-Object Subject,Thumbprint,HasPrivateKey,NotAfter | Format-List"

# F4 依赖
test -d node_modules && echo OK
```

**放行规则**

| 检查                       | 不通过                          |
| ------------------------ | ---------------------------- |
| Node < 20                | 停止，提示升级                      |
| node_modules 缺失          | 停止，询问是否 `npm install`        |
| 测试失败                     | 停止并展示失败用例；**不得**擅自删除或跳过测试    |
| 工作区脏（发布模式）               | 停止。**不得**自动 stash（可能丢失未提交改动） |
| 无 Developer ID 但需公证      | 停止，进入 §4 说明阻塞                |
| Windows 证书 `HasPrivateKey=False` | 停止：重导含私钥证书，或检查云签名器登录态（§4.6） |
| Windows 目标 + 含原生模块 + 非 Windows 宿主 | 停止：换宿主（§5.5）                   |
| tag 与 package.json 版本不一致 | **必须人工确认**（这是已踩过的坑，见 §5.3）   |

---

## 3. 自动化步骤

### 3.1 基础构建

**首选：`build.mjs` 一把梭**（自动处理脚本缺失与收尾）：

```bash
node <SKILL_DIR>/scripts/build.mjs[选项] [项目根目录]
```

它会自动完成：探测 → 跑测试 → 选构建命令 → 构建 → **收尾** → 校验 → 批次核对。

| 选项 | 说明 |
|---|---|
| `--platform mac\|win\|linux\|all` | 构建平台（默认 mac） |
| `--out <目录>` | 收尾产物目录（默认 `<outputDir>/package`） |
| `--name-prefix <前缀>` | 指定产物 ASCII 前缀（默认从包名/appId 推断） |
| `--skip-tests` | 跳过单元测试 |
| `--no-finalize` | 只构建，不做收尾与校验 |
| `--dry-run` | 只打印将执行的步骤 |

**它解决的两个高频问题**（对应 §5.7）：

1. **打包脚本只在部分分支上存在** —— 自动按`package` → `build:mac` → 裸
   `electron-builder` 的优先级选择，并在缺失时说明「本脚本将补齐收尾」
2. **裸 builder 不做收尾** —— 无论用了哪个命令，都由本脚本统一执行：
   以清单 `files[]` 为权威来源收齐 → ASCII 改名 → YAML 解析改写 url → 逐条校验 sha512

**手动等价流程**（需要自己控制时用）：

```bash
# 1. 先看项目提供了什么
node -e "console.log(Object.entries(require('./package.json').scripts||{}).map(([k,v])=>k+': '+v).join('\n'))"
```

- 项目有 `package` 脚本 → 优先用它（自带收尾）
- 只有 `build:mac` / `build` → 只构建，**收尾需自己做**
- 都没有 → `npx electron-builder --mac`

⚠️ **无论走哪条路径，收尾都不能省**。`build:mac` 与裸 `electron-builder` 都不会
产 ASCII 名与配对清单，直接投放会导致客户端 sha512 校验失败。

### 3.2 构建期必须守住的三条断言

| 断言                                               | 为什么                  |
| ------------------------------------------------ | -------------------- |
| `dist/latest-mac.yml`（win 用 `latest.yml`）**已生成** | 缺失说明更新链路无从谈起，后续发布无意义 |
| 清单里的`version` **等于**本次 `package.json` 的 version  | 版本不一致客户端不会触发升级       |
| 清单里每个 `files[].url` 对应的产物**都存在**且 sha512/size 匹配 | 否则客户端下载后校验失败         |

验清单（脚本已处理 YAML 依赖回退）：

```bash
# macOS
bash <SKILL_DIR>/scripts/verify-artifact.sh \
  --manifest dist/latest-mac.yml --dir dist

# Windows：额外校验 PE 架构、blockmap 同批、Authenticode（Windows 宿主上）
node <SKILL_DIR>/scripts/verify-win-artifact.mjs --dir release --expect-version <版本>
```

Windows 侧不要只确认"清单存在"——签名时序错误、混入旧批次、架构不符都不会让构建失败，
只会在客户端更新或启动时暴露。必须跑上面的脚本做产物级断言。

### 3.3 分发（远端写操作，需人工放行）

| 模式        | 安装包                            | 清单       | 操作                  |
| --------- | ------------------------------ | -------- | ------------------- |
| `github`  | `gh release create` + `upload` | 同Release | 见下                  |
| `generic` | `gh release` 或任意静态托管           | 自建服务器    | 清单需改写成绝对 URL，见 §5.2 |

**tag 推送顺序是硬约束**：必须先推 tag，再建 Release。  
否则 `gh` 会在旧提交上自建同名 tag，本地 tag 再推会被拒。

```bash
git push origin HEAD "refs/tags/$TAG"     # ① 先推分支与 tag
gh release create "$TAG" --title "..." --notes "..."
gh release upload "$TAG" --clobber <产物路径>   # ② 再建 Release 并传资产
```

`generic` 模式额外一步：清单里的 `url` 需从相对文件名改成绝对地址，  
再上传到更新服务器。**用 YAML 解析改写**，并原子替换（先传 `.tmp` 再 `mv`），  
避免客户端拉到写了一半的清单。

### 3.4 发布后验证

```bash
# 一并完成：可达性 + 版本一致性 + 清单形态 + 不可达根因诊断
bash <SKILL_DIR>/scripts/verify-artifact.sh --feed <更新源 URL> [期望版本]

# 资产是否真的可下载（Range 请求）
curl -s -o /dev/null -w "%{http_code}" -r 0-1023 -L <资产 URL>
```

`--feed` 模式会**区分两类不可达**（这是最常见的坑）：

| 现象                            | 判定                                              | 处置                                                |
| ----------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| 代理与直连结果**一致**（都 404）          | 服务器侧确实没有该文件                                     | ssh 上去 `ls` 部署目录；核对 nginx `root`/`alias` 是否指向部署目录 |
| 代理与直连结果**不同**                 | 本地代理干扰                                          | 查代理对该域名的分流规则；必要时配置里填真实 IP                         |
| 域名解析到 `198.18.x` / `198.19.x` | Clash/mihomo 的 fake-IP 池（RFC 2544 保留段），非真实服务器地址 | 确认代理规则；直连时用真实 IP                                  |

同时检查清单形态：`url` 为**相对路径** → 安装包必须与清单同目录托管；  
为**绝对地址** → 两者分开托管（常见做法：包在 GitHub、清单在国内服务器）。

> 域名被本地代理劫持时，把发布配置里的 `ssh.host` 填**真实 IP** 而非域名。

**唯一无法脚本化的验证**：装上旧版本 → 手动触发检查更新 → 确认能拉到新版本。  
清单能下载 ≠ 客户端能升级。

---

## 4. 签名与公证

> 完整机制与 entitlements 模板见 `references/mechanism.md`。

### 4.1 现状判定

```bash
# 证书
security find-identity -v -p codesigning
# 产物是否真签名/公证/装订
bash <SKILL_DIR>/scripts/verify-artifact.sh dist/*.dmg
```

### 4.2 不签名的构建

很多内部工具选择不签名，构建配置里显式关闭：

```json
{ "mac": { "identity": null } }
```

**后果必须如实告知用户**：首次安装需在「系统设置 → 隐私与安全性」手动放行；  
自动更新推的新包也会再次拦截。这不是 bug。

反过来，从「不签名」切换到正式分发时，**第一件事是删掉 `identity: null`** ——
即使 `CSC_*` / `APPLE_*` 环境变量全部就位，这个字段也会让签名被跳过
（日志 `skipped macOS code signing reason=identity explicitly is set to null`）。

### 4.3 启用签名（需要 Developer ID 证书）

前置：**Apple Developer Program 会员**（Developer ID 证书为付费证书，年费 99 美元）。  
`Apple Development` 证书**不能用于分发**。

先确认证书来源，两种场景二选一：

| 场景 | 证书位置 | 需要配置 |
|---|---|---|
| 个人 / 团队构建机 | 本机钥匙串（`security find-identity -v -p codesigning` 可见） | **无需 `CSC_LINK` / `CSC_KEY_PASSWORD`**；钥匙串有多张证书时才需 `CSC_NAME` |
| CI / Docker / 云构建 | `.p12` 文件 | `CSC_LINK` + `CSC_KEY_PASSWORD`（或 base64 内联） |

**证书在钥匙串时不需要 `CSC_LINK` / `CSC_KEY_PASSWORD`** —— electron-builder
直接读钥匙串。仅当钥匙串里有多张可签名证书（常见：同时存在
`Apple Development` 与 `Developer ID Application`）时，用 `CSC_NAME` 指定：

```bash
export CSC_NAME="Developer ID Application: ..."  # 多证书时才需要
```

`.p12` 方案（无钥匙串的环境，避免把证书路径写进配置）：

```bash
export CSC_LINK=/path/to/cert.p12      # 或 base64 内联
export CSC_KEY_PASSWORD=***
```

公证凭据（两套互斥，选一套）：

```bash
# 方案A：Apple ID + 专用密码
export APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=...

# 方案 B：App Store Connect API Key
export APPLE_API_KEY=/path/to/key.p8 APPLE_API_KEY_ID=... APPLE_API_ISSUER=...
```

### 4.4 dmg 必须手动 staple ★

electron-builder 的 notarize **只作用于 `.app`**，dmg 不在范围内。  
打包后补一次：

```bash
xcrun stapler staple dist/*.dmg && xcrun stapler validate dist/*.dmg
```

### 4.5 hardenedRuntime 前置

公证要求开启 Hardened Runtime，且 Electron 20+ arm64 必须有  
`com.apple.security.cs.allow-jit`，否则启动即崩。  
`build/entitlements.mac.plist` 与 `build/entitlements.mac.inherit.plist` 模板见  
`references/mechanism.md`。

配套设置 `gatekeeperAssess: false`：该字段控制 electron-builder 是否在
**构建期**对产物做本地 Gatekeeper 预评估。未公证产物会评估失败并中断构建，
而公证发生在构建末尾，两者顺序矛盾 —— 正式包构建应显式关闭它。

### 4.6 Windows 签名

> 完整机制、NSIS 默认值、云签名器细节与故障树见 `references/windows.md`。

**三条路径选一条。** `certificateSha1` 一旦设置即独占来源，不会回退 PFX / `WIN_CSC_LINK`：

| 路径 | 配置 | 适用 |
|---|---|---|
| 证书存储 | `signtoolOptions.certificateSha1`（或 `certificateSubjectName`） | 构建机已导入含私钥的证书 |
| PFX 文件 | `signtoolOptions.certificateFile` + 密码，或 `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` | CI / 临时构建机 |
| 云签名器 | 同"证书存储"，但证书由 SimplySign 等客户端挂进 `Cert:\CurrentUser\My` | 私钥在云端 HSM |

```bash
# PFX 方案
export WIN_CSC_LINK=/path/to/cert.pfx WIN_CSC_KEY_PASSWORD=***
```

**三条硬约束：**

1. **签名必须由 electron-builder 在生成 blockmap / latest.yml 之前完成。**
   构建后用脚本重签会改变哈希，清单 sha512 与产物不一致，客户端更新必失败。
2. **`publisherName` 必须与证书 Subject 完全一致**（建议完整 DN，不只写 CN），
   否则 electron-updater 拒绝更新包。
3. **必须在 Windows 宿主构建**，见 §5.5。

**云签名器（SimplySign 等）额外要求：**

- 客户端保持登录——掉线即私钥不可用，报 `After Private Key filter, 0 certs were left`
- 开启 PIN 缓存（约 3 小时），并在构建前**预热签一次**；否则构建卡在
  `Submitting digest for signing...`，表现为无响应而非报错
- 用 64 位 signtool（builder 自带 `windows-10/x64/signtool.exe`）

未签名的 exe 会触发 SmartScreen；新证书即使已签名，信誉积累期仍可能提示。这是预期行为。

---

## 5. 风险与已知坑

### 5.1 产物不可复现

同版本两次构建 sha512 不同（时间戳、asar 顺序、zip 元数据）。  
**清单必须与当次产物成对发布，禁止复用旧资产目录。**

### 5.2 清单改写会破坏结构（高频事故）

逐行文本替换会把缩进错位的 `sha512`/`size` 并进 `url`：

```yaml
# 损坏的清单 —— 客户端解析必失败
files:
  - url: idea-note-1.1.1.dmg sha512: xxxxx size: 123
```

正确做法见 `references/mechanism.md` §3.3，或直接复用项目里已有的清单改写脚本  
（若项目已封装，优先用它）。

### 5.3 版本号与 tag 脱节（真实踩过的坑）

已见到 tag 指向的 commit 里 `package.json` 版本号未同步。  
**发布前必须核对**：

```bash
git tag --sort=-creatordate | head -3
node -p "require('./package.json').version"
# 逐个核对 tag 指向 commit 的版本
for t in $(git tag --sort=-creatordate | head -3); do
  echo "$t -> $(git show $(git rev-list -n1 $t):package.json | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).version")"
done
```

### 5.4 tag 顺序

tag 必须**先于** Release 推送。顺序反了会导致 gh 在旧提交上自建同名 tag，  
本地 tag 推送被拒。

### 5.5 Windows 交叉构建的边界

| 项目特征 | 能否在 macOS/Linux 上产出可用 Windows 包 |
|---|---|
| 纯 JS 依赖 | 可（Wine + NSIS），但属非官方路径，需实测 |
| 含原生模块（`better-sqlite3` / `bufferutil` / `node-screenshots` 等） | **不可** |

`@electron/rebuild` 在 `rebuilder.platform !== process.platform` 时直接抛错。
更隐蔽的是**部分成功**：有匹配 prebuild 的模块拿到 win32 二进制，没有的才回退 node-gyp 失败。

**副作用**：失败会把 `node_modules/<native>/build/Release/*.node` 换成 PE DLL，
同一份 `node_modules` 在 macOS 上立即不可用，需按项目脚本重建 ABI。

发布用途的 Windows 包一律在 Windows 宿主构建；构建脚本应在非 Windows 宿主上
**快速失败并说明原因**，而不是"试一下"。**若无法验证，明确告知用户，不要假装成功。**

### 5.6 公证静默跳过

见 §0 铁律 4。必须跑 `verify-artifact.sh` 做产物级断言。

### 5.7 打包脚本可能只在部分分支上存在

多分支项目里，`release.sh` / `package` script 这类收尾脚本是某个 commit 引入的，
**切分支后可能整个消失**：

```bash
npm run package        # → npm error Missing script: "package"
ls scripts/            # → No such file or directory
```

确认脚本是否在本分支上：

```bash
git merge-base --is-ancestor <引入脚本的commit> HEAD && echo "在" || echo "不在本分支"
```

**回退**：用 `npx electron-builder --mac`。但要注意——

| 命令 | 构建 | 收尾（ASCII 改名 + 配对清单 + sha512 校验） |
|---|---|---|
| `npm run package` | 是 | **自带** |
| `npm run build:mac` | 是 | **不做** |
| `npx electron-builder` | 是 | **不做** |

**换了构建命令不等于可以跳过收尾**。`build.mjs` 无论选哪个命令都统一收尾。

### 5.8 `dist/` 不随分支隔离

切分支后 `dist/` 里会同时存在不同分支的产物。构建不可复现（§5.1），
两批 sha512 不同，混用会导致客户端校验失败。

**核对批次**：

```bash
stat -f '%Sm' dist/package/latest-mac.yml# macOS
# 清单时间早于本次构建开始时间 → 旧批次，必须重建
```

`build.mjs` 会自动判断并在必要时重建收尾目录。
---

## 6. 人工介入（不可自动化）

> 每项都需人工操作或明确口头确认。AI 不得代为执行含凭据或远端写操作的动作。

### 🔧 M1 · 注入发布凭据

**触发**：首次执行发布前，或更换服务器/密钥后。  
**前置**：拿到服务器访问方式（IP、用户、密钥路径）。  
**为何人工**：涉及服务器凭据与内网信息。  
**失败处理**：连接失败 → 核对 IP/端口/密钥；域名被本地代理劫持时 `host` 填真实 IP。  
**禁止**：把凭据写进 `package.json`、`.yml` 或任何入库文件。


### 🔑 M2 · 发布平台登录鉴权

**触发**：发 GitHub Release 前。  
**前置**：`gh` 已安装；账号对目标仓库有 **Write 及以上**权限。  
**操作**：`gh auth login`。  
**失败处理**：权限不足时脚本/命令会报错 →换账号或授权，**不要**绕过权限检查。

### 📝 M3 · 确认版本号

**触发**：发布前。  
**前置**：确定 bump 类型（修复→patch / 新功能→minor / 不兼容→major）。  
**为何人工**：版本号是对外契约，误发布会推给所有用户。  
**强制约束**：**必须严格递增**，否则客户端不会触发升级。  
**失败处理**：tag 已存在 → 换更高版本号。**不要**删已发布 tag（破坏可追溯性）。

### 🔏 M4 · 证书主体确认

**触发**：启用签名前。  
**前置**：确认证书归属主体是否为本人/本组织，且有分发授权。  
**为何人工**：用他人主体的证书签名分发涉及法律风险。  
**失败处理**：主体不符 → 采购自己的证书，不要借用。

### 🌍 M5 · 环境差异确认

**触发**：跨平台构建；切换构建机；首次在新机器上发布。  
**需确认**：① 目标平台能否在本机构建；② 证书是否就位；③ 更新源是否可达；④ 产物命名与更新清单是否匹配。  
**失败处理**：不具备条件时**停止并告知**，不要产出未经验证的包。

### 🚦 M6 · 发布放行

**触发**：任何远端写操作**之前**。  
**需确认**：① 版本号正确；② 清单与产物 sha512 配对通过；③ 目标地址正确；④ 知晓远端将出现新 tag / Release。  
**为何人工**：不可逆。

### 🖐 M7 · 云签名器登录 / PIN

**触发**：使用 SimplySign 等云签名器，或首次在打包机上签名。  
**前置**：客户端已安装并登录；证书在 `Cert:\CurrentUser\My` 可见且 `HasPrivateKey=True`。  
**操作**：先对任意已有 exe 手工签一次，完成 PIN/手机确认（PIN 缓存约 3 小时）。  
**为何人工**：OTP/PIN 在手机上，不能入库，也不能由脚本代按。  
**失败处理**：`After Private Key filter, 0 certs were left` → 重新登录，或换 64 位 signtool；  
构建卡在 `Submitting digest for signing...` → 预热未完成，回到本节第一步。

---

## 7. 清理与回滚

**回滚**

| 场景                | 处置                                                    |
| ----------------- | ----------------------------------------------------- |
| 版本写错，未 push       | `git checkout package.json package-lock.json`；清产物目录重跑 |
| 已推 tag，未建 Release | Release 可删；tag 保留（已分发版本需可追溯）                          |
| 已建 Release        | 可删资产，但已升级客户端无法回退，需发新版本修复                              |
| 线上清单已更新           | 需人工重新部署旧清单 —— **无自动回滚**                               |
| 清单与产物不匹配          | **最危险**。客户端校验失败会拒更新，需成对重新发布                           |

**清理**

```bash
# 仅清产物目录（先确认已在 .gitignore 中）
rm -rf dist release out

# 保留产物但清构建元信息前，先留档——排查配置问题很有用
# dist/builder-debug.yml / dist/builder-effective-config.yaml
```

🛑 **禁止**

- 为"解决"构建问题而删除 `dist/` 外的文件
- 手工编辑 `latest*.yml`
- 删除或跳过测试来让构建通过
- 把含凭据的配置文件加入版本控制

---

## 8. 输出约定

每次打包结束时，报告必须包含：

```
[项目] <name> v<version>  （<配置来源>）
[产物] <路径列表与大小>
[清单] <路径>  version 一致性: ✓/✗
[签名] macOS: Developer ID / adhoc / 未签名；Windows: Authenticode 有效 / 无效 / 未签名
[时间戳] 有 / 无 / 不适用（Windows 无时间戳时证书过期即失效）
[公证] 已公证 / 未公证 / 未配置（仅 macOS）
[staple] 已装订 / 未装订 / 不适用（仅 macOS）
[产物校验] 通过 / 未通过（含失败项与 SKIP 项）
[人工确认项] 列出未完成的人工步骤
```

**任何一项无法确认时写"未确认"，不得留空或写成成功。**

---

## 9. 附录

| 文件                                    | 用途                                          | 依赖              |
| ------------------------------------- | ------------------------------------------- | --------------- |
| `scripts/probe.sh`                    | 项目画像探测（推荐入口，自动回退）                           | bash，可无 Node    |
| `scripts/probe.mjs`                   | 项目画像探测核心实现                                  | Node 16+，零依赖    |
| `scripts/verify-artifact.sh`          | 产物验证：签名 / 公证 / staple / 清单配对（macOS 为主）      | bash + macOS 工具 |
| `scripts/verify-win-artifact.mjs`     | Windows 产物验证：清单 / sha512 / PE 架构 / blockmap / Authenticode | Node 16+，零依赖 |
| `scripts/install.sh`                  | 链接到各 agent 的技能目录                            | bash            |
| `references/mechanism.md`             | 机制速查：公证流程、凭据、entitlements 模板、清单结构、平台差异、坑位清单 | —               |
| `references/windows.md`               | Windows 分册：平台边界、十阶段流水线、NSIS 默认值、签名时序、云签名器、故障树 | —               |
| `assets/project-config.template.json` | 项目级配置模板                                     | —               |

**验证环境**：electron-builder 25.1.8 / @electron/notarize 2.5.0 / Electron 33.4.11 /  
macOS 15.7.8 / Node 22。其他版本的机制细节（尤其公证字段默认值）**需读该项目的  
node_modules 源码确认**，不要照搬本文档。
