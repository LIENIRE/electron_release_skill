---
name: electron-release
agent_created: true
license: MIT
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
| Node.js  | 脚本最低 16+；**构建**需 ≥ 20（electron-builder 25 要求） | 探测自动降级为纯 bash；构建流程明确停止 |
| bash     | 必需（`verify-artifact.sh` / `install.sh`）               | 改用 npm 脚本手工执行          |
| macOS 工具 | 签名验证需 `codesign`/`spctl`/`xcrun`（系统自带）                | 非 macOS 明确提示并改用对应平台命令  |
| YAML 解析  | 全部 Node 脚本自带最小解析器（零依赖，`scripts/lib/manifest.mjs`）；装了项目 `js-yaml` 会自动改用 | 内置解析器只认 electron-updater 固定形态；`verify-artifact.sh` 无 node 时退 `pyyaml`，两者都无才报错 |
| 文件系统/权限 | 构建需要写项目输出目录，并 spawn `npm` / `electron-builder` | agent 的只读或仅工作区沙箱会失败：请在可写环境运行；`preflight-win-sign.mjs` 与 `verify-win-artifact.mjs` 已适配受限沙箱（结果走临时文件） |

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
| 7 | **校验脚本要先自证**。判定入口跨平台、成功路径必须有输出；无输出/静默 `exit 0` 一律当失败（§5.12）                |
| 8 | **Windows 默认必须签名**。没有可用证书时 `build.mjs` 在构建前停止；确实不签名要显式 `--allow-unsigned` 或 `method:"none"`，并在报告里写明 SmartScreen 后果 |

---

## 1. 第一步：探测项目画像

### 脚本路径

`<SKILL_DIR>` = 本 `SKILL.md` 的父目录。装到哪个 agent 由 `install.sh` 决定，不必背路径：

```bash
bash <SKILL_DIR>/scripts/install.sh --list    # 查看支持项与本机状态（含 ~/.workbuddy/skills）
bash <SKILL_DIR>/scripts/install.sh           # 自动探测并链接；--copy 用复制代替软链
```

若路径报 `No such file`：`find ~ -name probe.mjs -path "*electron-release*" 2>/dev/null`。
各 agent 的完整路径表见 `README.md` 的安装章节（此处不再维护第二份）。

### 执行

```bash
# macOS / Linux：推荐跨平台包装层，自动在 Node 与纯 bash 之间回退
bash <SKILL_DIR>/scripts/probe.sh [项目根目录]
bash <SKILL_DIR>/scripts/probe.sh . --json

# Windows：直接跑 Node 版（Windows 上 bash 未必可用）
node <SKILL_DIR>/scripts/probe.mjs [项目根目录]
node <SKILL_DIR>/scripts/probe.mjs . --json
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
| Windows 目标 + `node_modules` 非本平台安装（`.bin` 无 `.cmd`） | 先按 §5.10 处理，否则 `npm run` / `npx` 直接失败；`build.mjs` 会自动回退 |
| Electron Forge             | 改用 `forge make` / `forge publish`；本skill 的清单与公证部分不直接适用 |
| electron-packager（只出 .app） | 无安装包与自动更新清单，跳到 §3.3                                    |
| `identity: null` 且无公证需求    | 跳过 §4签名，走 §3                                           |
| 产物目录已有历史产物                 | 先确认新旧清单是否配对，见 §5.2                                     |

### 项目级配置（可选）

若项目有 `.electron-release.json`，`probe.mjs` / `build.mjs` / `preflight-win-sign.mjs` 都会读取：
可覆盖 `build.outputDir`、`build.command`、签名证书（`signing.windows.*`）、
`signing.windows.method: "none"`（明确声明不签名）、RFC3161 时间戳服务。
字段清单与默认值见 `assets/project-config.template.json`。

**证书来源优先级**：命令行（`--sign-sha1` / `--sign-subject`）> `SIGN_SHA1` / `WIN_SIGN_SHA1` >
`.electron-release.json` > `package.json#build.win.signtoolOptions` > 证书存储里**唯一**一张可用证书。
命中多张时脚本会停止并列出候选，**不会替你猜**。**不要把含凭据的配置提交到 git。**

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

# F3' 的推荐替代：skill 的 Windows 签名前置检查（含登录态/私钥/过期与来源判定）
node <SKILL_DIR>/scripts/preflight-win-sign.mjs .            # 只检查
node <SKILL_DIR>/scripts/preflight-win-sign.mjs . --warmup   # 额外预热 PIN（SimplySign 首次/换机）

# F4 依赖
test -d node_modules && echo OK

# F5 依赖是否为本平台安装的（Windows 宿主必查，见 §5.10）
ls node_modules/.bin | grep -c '\.cmd$'      # Windows 上应为非 0；全无 .cmd 说明是从 mac 拷来的
ls node_modules/electron/dist/electron.exe   # Windows 上应存在；缺失则 npm start / 冒烟测试都不可用

# F6 发布者信息（Windows 必查，见 §5.11）
node -p "require('./package.json').author || '(缺失：CompanyName 会回落 GitHub, Inc.)'"
```

**放行规则**

| 检查                       | 不通过                          |
| ------------------------ | ---------------------------- |
| Node < 20（构建场景；仅跑探测/校验时 16+ 可用） | 停止，提示升级 |
| node_modules 缺失          | 停止，询问是否 `npm install`        |
| 测试失败                     | 停止并展示失败用例；**不得**擅自删除或跳过测试    |
| 工作区脏（发布模式）               | 停止。**不得**自动 stash（可能丢失未提交改动） |
| 无 Developer ID 但需公证      | 停止，进入 §4 说明阻塞                |
| Windows 证书 `HasPrivateKey=False` | 停止：重导含私钥证书，或检查云签名器登录态（§4.6） |
| Windows 无可用证书且未声明不签名 | **默认停止**（`build.mjs` 退出码 2）：先检查 SimplySign 登录态，或显式加 `--allow-unsigned` / 项目配置 `method:"none"` |
| Windows 目标 + 含原生模块 + 非 Windows 宿主 | 停止：换宿主（§5.5）                   |
| tag 与 package.json 版本不一致 | **必须人工确认**（这是已踩过的坑，见 §5.3）   |
| `.bin` 无本平台 shim（`npm run` / `npx` 失效） | **不阻断**：改用 `node node_modules/electron-builder/cli.js`（§5.10）；`build.mjs` 会自动回退 |
| `author` 缺失              | **不阻断**：安装包发布者与 exe `CompanyName` 会回落 `GitHub, Inc.`，承诺分发前应补（§5.11） |

---

## 3. 自动化步骤

### 3.1 基础构建

**首选：`build.mjs` 一把梭**（自动处理脚本缺失与收尾）：

```bash
node <SKILL_DIR>/scripts/build.mjs [选项] [项目根目录]
```

它会自动完成：探测 → **Windows 签名预检** → 跑测试 → 选构建命令 → 构建 →
**收尾** → **产物校验** → 批次核对。

| 选项 | 说明 |
|---|---|
| `--platform mac\|win\|linux\|all` | 构建平台（默认 mac）。要出两平台包请**分别跑两次**：`all` 的收尾只读 `latest-mac.yml`，且共用 `package/` 会互相覆盖 |
| `--out <目录>` | 收尾产物目录（默认 `<outputDir>/package`；**不再**影响 builder 输出目录） |
| `--skip-build` / `--skip-tests` | 只做收尾 + 校验（重跑收尾/补验） / 跳过单元测试 |
| `--dry-run` | 只打印将执行的步骤（含选中的脚本与签名来源，不做预热） |
| `--sign-sha1` / `--sign-subject` / `--warmup` | 指定指纹 / 按 Subject 选证书 / 预热 PIN |
| `--skip-sign` / `--allow-unsigned` | 不签名（同时剥离凭据变量） / 无证书仍继续 |
| `--expect-arch x64\|arm64` / `--strict` | 架构断言 / 校验出现 SKIP 也算失败 |

完整选项（`--no-finalize`、`--no-verify`、`--name-prefix`、`--timestamp-url`、
`--allow-cross-build` 等）见 `node <SKILL_DIR>/scripts/build.mjs --help`——脚本头注释是唯一真相来源，
本文档不复制，避免再次漂移。

**默认安全姿态**：`--platform win` 时若证书存储里没有可用证书、项目也没声明不签名，
脚本会在构建**之前**以退出码 2 停止 —— 避免“构建成功但产物未签名、仍被当成可分发”。
确实不签名时用 `--allow-unsigned`，或在 `.electron-release.json` 里写 `signing.windows.method: "none"`。

**它解决的问题**（细节依次见 §5.7 / §5.8 / §5.10 / §5.9）：① 打包脚本只在部分分支存在 →
优先平台专属脚本，再退通用脚本、裸 builder；② 裸 builder 不做收尾 → 统一由本脚本按清单
`files[]` 收齐、ASCII 改名、改写清单、逐条校验 sha512；③ `npm run` / `npx` 在本机失效 →
**只在 shim 类报错**时回退 `node cli.js`，项目自身编译报错或子脚本缺失**不回退**（否则会把上一次
旧产物打进包）；④ Windows rcedit 被实时防护锁定 → 解析原始命令行退避补写，再 `--prepackaged`
只续跑分发目标。

**Windows 签名参数注入**：`build.mjs` 会解析出证书后自动追加
`--c.win.signtoolOptions.certificateSha1=<指纹>` 与
`--c.win.signtoolOptions.rfc3161TimeStampServer=<URL>`，npm 脚本、`node cli.js` 回退、
`--prepackaged` 续跑三条路径都会带上同一组参数。**不需要改项目的 `package.json`。**

项目脚本里若显式写了 `--publish always` / `--publish onTag`，脚本会打印「会触发远端发布」的
警告（不改写项目命令）。需要完全隔离时，用 `--skip-build` 只做收尾，或改走 `--no-finalize`。


Windows 上一次成功构建的真实输出长这样（可用来对照是否走到兜底分支）：

```
▸ 构建：npm run build:win
! npm 脚本不可用（npm run build:win），回退到 node cli.js
✗ rcedit 被实时防护短暂锁定，进入退避补写
  ✓ rcedit 补写成功（第 2 次尝试）
▸ 续跑分发目标：--prepackaged dist\win-unpacked
✓ idea-note-Setup-1.1.1.exe  94MB
```

**手动等价流程**：先看 `package.json#scripts` —— 有平台脚本（`dist:win` / `build:mac` / `package`）
就优先用它；只有 `build` 说明只编译，**收尾必须自己做**；都没有则 `npx electron-builder --<平台>`。
最常用的两条命令：

```bash
# 只看会做什么（含选中的脚本、证书来源）
node <SKILL_DIR>/scripts/build.mjs --platform win --dry-run <项目>

# 真正构建（自动预检证书 → 注入签名参数 → 构建 → 收尾 → 产物校验）
node <SKILL_DIR>/scripts/build.mjs --platform win --expect-arch x64 <项目>
```

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
node <SKILL_DIR>/scripts/verify-win-artifact.mjs \
  --dir release --expect-version <版本> [--expect-arch x64] \
  [--allow-unsigned] [--strict]
```

Windows 侧不要只确认"清单存在"——签名时序错误、混入旧批次、架构不符都不会让构建失败，
只会在客户端更新或启动时暴露。必须跑上面的脚本做产物级断言。
`build.mjs --platform win` 已在收尾后**自动调用它**：任何 FAIL（或 `--strict` 下的 SKIP）
都会让本次构建以非 0 退出，不需要再手工跑一遍。

两个容易误判的点：

- **不要对 NSIS 安装包直接比对 `--expect-arch`**。NSIS 引导程序**恒为 32 位**，
  x64 应用打出来的 `Setup.exe` 也是 x86 PE —— 直接比对必然报「实际 x86 ≠ 期望 x64」。
  脚本已识别 `NullsoftInst` 标记，自动改为校验 `win-unpacked` 里的载荷 exe
  （输出形如 `NSIS 引导 x86（正常）+ 载荷 x64`）。若收尾目录里没有 unpacked 目录，
  该行记 **SKIP**（`!`）而不是 PASS —— 此时 `--expect-arch` 一次都没比对过，
  记 PASS 就等于把「没校验」显示成对勾。发布门禁加 `--strict` 会因此失败。
- **不签名的项目加 `--allow-unsigned`**。默认 `NotSigned` 记 FAIL（这是对的：构建成功 ≠ 能分发），
  但 `identity: null` / 内部工具场景需要显式接受，让它变 SKIP，便于在 CI 里把
  「其他项」当硬门禁。
- **发布门禁要加 `--strict`**。默认语义是 `exit 0 = 无 FAIL`，SKIP 不影响退出码；
  `--strict` 下「有 SKIP」也返回 `3`。否则签名校验因策略限制没跑起来时，
  CI 仍会全绿（详见 `references/windows.md` §7）。

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

三条路径选一条。`certificateSha1` 一旦设置即独占来源，**不会**回退 PFX / `WIN_CSC_LINK`：

| 路径 | 关键配置 | 适用 |
|---|---|---|
| 证书存储 | `signtoolOptions.certificateSha1`（或 `certificateSubjectName`） | 构建机已导入含私钥的证书 |
| PFX 文件 | `signtoolOptions.certificateFile` + 密码，或 `WIN_CSC_LINK` + `WIN_CSC_KEY_PASSWORD` | CI / 临时构建机 |
| 云签名器 | 同「证书存储」，证书由 SimplySign 等挂进 `Cert:\CurrentUser\My` | 私钥在云端 HSM |

证书来源的五级解析顺序（命令行 → 环境变量 → 项目配置 → `package.json` → 存储中唯一可用证书）、
SimplySign 登录态与 PIN 缓存、`After Private Key filter, 0 certs were left` 的两种成因、
`publisherName` 与 RFC3161 时间戳要求，见 `references/windows.md` §5.2–§5.6。

**一键流程（不改项目 `package.json`，不把指纹写进任何脚本）**：

```bash
node <SKILL_DIR>/scripts/preflight-win-sign.mjs <项目> --warmup   # 首次/换机：验证登录态 + 预热 PIN
node <SKILL_DIR>/scripts/build.mjs --platform win --expect-arch x64 <项目>   # 解析证书→注入参数→构建→收尾→校验
```

**三条硬约束**（违反任一条：构建能过，客户端更新必挂）：

1. 签名必须由 electron-builder 在生成 blockmap / `latest.yml` **之前**完成。构建后重签会改变哈希，
   清单 sha512 与产物不一致。
2. `publisherName` 必须与证书 Subject 完全一致（建议完整 DN，不要只写 CN）。
3. 必须在 Windows 宿主构建，见 §5.5。

云签名器额外要求：客户端保持登录（掉线即私钥不可用）、PIN 缓存开启并预热（否则卡在
`Submitting digest for signing...`，表现为**无响应**而非报错）、用 64 位 signtool。
未签名的 exe 会触发 SmartScreen；新证书即使已签名，信誉积累期仍会提示——都是预期行为。

---

## 5. 风险与已知坑

### 5.1 产物不可复现

同版本两次构建 sha512 不同（时间戳、asar 顺序、zip 元数据）。
**清单必须与当次产物成对发布，禁止复用旧资产目录。**

### 5.2 清单改写会破坏结构（高频事故）

逐行文本替换会把缩进错位的 `sha512`/`size` 并进 `url`，产出客户端无法解析的清单
（表现为「检查更新永远失败」或「下载后校验不通过」）。必须 YAML 解析 → 改 → 序列化：
统一实现是 `scripts/lib/manifest.mjs`，机制说明见 `references/mechanism.md` §3.3。

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

纯 JS 依赖可尝试 Wine + NSIS（非官方路径，需实测）；**含原生模块一律不可**：
`@electron/rebuild` 在 `rebuilder.platform !== process.platform` 时直接抛错。
更隐蔽的是**部分成功**——有 prebuild 的模块拿到 win32 二进制，没有的回退 node-gyp 失败；
失败还会把 `node_modules/<native>/build/Release/*.node` 换成 PE DLL，同一份 `node_modules`
回 macOS 立即不可用。

发布用途的 Windows 包一律在 Windows 宿主构建；非 Windows 宿主应**快速失败并说明原因**，
而不是"试一下"。机制细节见 `references/windows.md` §1。

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
stat -f '%Sm' dist/package/latest-mac.yml   # macOS
# 清单时间早于本次构建开始时间 → 旧批次，必须重建
```

`build.mjs` 会自动判断并在必要时重建收尾目录。

### 5.9 Windows：rcedit `Unable to commit changes`

打包末尾写 exe 版本资源失败，日志为 `Fatal error: Unable to commit changes`——**与证书无关**，
却常被误判成签名问题。根因是实时防护（火绒 / 电脑管家 / Defender）对刚写入的大 exe 瞬时独占。

处置（`build.mjs --platform win` 已内置）：从日志抠出 rcedit **原始命令行**（不要硬编码参数）→
按 `[0, 8, 8, 10, 12, 15, 20, 25]` 秒退避重试（每次先 `open(exe,'r+')` 探测占用）→ 成功后用
`--prepackaged` 只续跑 nsis/zip，**不要整包重跑**（会重新拷贝 exe，必然再触发一次锁）。

对照实验、判断依据与「加入信任区」的彻底解法见 `references/windows.md` §5.7。

### 5.10 node_modules 跨平台拷贝 → `npm run` / `npx` 全部失效

`node -v` 正常，但 `'electron-builder' 不是内部或外部命令`：`.bin` 里的 shim 与
`electron/dist/` 都是**平台相关**的。判据：`ls node_modules/.bin | grep -c '\.cmd$'` 为 0。

只打包可绕过 shim 用 `node node_modules/electron-builder/cli.js --win`（`build.mjs` 已按报错特征
自动回退）；要长期用则在 Windows 上 `npm ci`（会重写 `node_modules`，mac 侧那份随即失效）。
脚本内 `spawnSync('npm')` 需 `shell:true`（Node ≥18.20 禁止无 shell 执行 `.cmd`）。
细节见 `references/windows.md` §1.1。

### 5.11 缺 `author` → 发布者回落 `GitHub, Inc.`

构建**不失败**，只打一行 `author is missed`，但 exe 的 `CompanyName` / `LegalCopyright`
与卸载项发布者全是 Electron 默认值。**必须在打包前补** `"author"`——该值会进 rcedit 参数，
事后单改 exe 会与 NSIS 侧不一致。

核对（Windows）：`(Get-Item .\release\win-unpacked\MyApp.exe).VersionInfo | Format-List`，
`FileVersion` 应为 package.json 版本、`CompanyName` 应为 author。成因与配置面见
`references/windows.md` §3.0。

### 5.12 校验脚本也会说谎：必须验证「脚本真的跑了」

真实事故：入口判定写成 `resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)`。
macOS 下同形可用；Windows 下 `pathname` 是 `/C:/…`，永不相等 → `main()` 不执行、进程 **exit 0**，
于是「校验通过」其实是「什么都没校验」，比校验失败危险得多。现已改为 `fileURLToPath` +
`realpathSync` 归一，并加「疑似入口却未匹配 → exit 2」的硬报错。

规则（任何自写校验脚本都适用）：入口用 `fileURLToPath`；**成功路径必须至少有输出**；
新写/改写的脚本先用一个**已知不合格**的产物跑一遍，确认它真的会 FAIL。事故复盘见
`references/windows.md` §7.2。

---

## 6. 人工介入（不可自动化）

> 每项都需人工操作或明确口头确认；AI 不得代为执行含凭据或远端写操作的动作。
> Windows 侧的判定细节见 `references/windows.md` §10。

| # | 事项 | 触发 / 前置 | 关键约束 |
|---|---|---|---|
| M1 | 注入发布凭据 | 首次发布、换服务器或密钥 | 凭据不得进 `package.json` / `.yml` / 任何入库文件；域名被本地代理劫持时 `host` 填真实 IP |
| M2 | 平台登录鉴权 | 发 Release 前 | `gh auth login`；账号需 Write 及以上权限，**不得绕过**权限检查 |
| M3 | 确认版本号 | 发布前 | 必须严格递增；tag 已存在就换更高版本，**不删**已发布 tag |
| M4 | 证书主体确认 | 启用签名前 | 主体须为本人/本组织且有分发授权；不借用他人证书 |
| M5 | 环境差异确认 | 跨平台构建 / 换构建机 / 新机器首发 | 本机能否构建、证书是否就位、更新源是否可达、命名与清单是否匹配；不具备就**停止并告知** |
| M6 | 发布放行 | 任何远端写操作**之前** | 版本号、sha512 配对、目标地址、将出现的新 tag / Release 全部确认（不可逆） |
| M7 | 云签名器登录 / PIN | SimplySign 等 / 首次在打包机签名 | 先手工签一次完成 OTP/PIN（缓存约 3h）；卡在 `Submitting digest for signing...` 即预热未完成 |

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
[架构] Windows: 安装包引导 x86（NSIS 正常）/ 载荷 x64；找不到 unpacked 时写「载荷未确认，需补验」（SKIP，不得写通过）
[签名] macOS: Developer ID / adhoc / 未签名；Windows: Authenticode 有效 / 无效 / 未签名
[时间戳] 有 / 无 / 不适用（Windows 无时间戳时证书过期即失效）
[公证] 已公证 / 未公证 / 未配置（仅 macOS）
[staple] 已装订 / 未装订 / 不适用（仅 macOS）
[产物校验] 通过 / 未通过（含失败项与 SKIP 项），并注明校验脚本是否真的执行（§5.12）
[兜底记录] 本次是否走到 npm shim 回退 / rcedit 补写（§5.9、§5.10）
[人工确认项] 列出未完成的人工步骤
```

**任何一项无法确认时写"未确认"，不得留空或写成成功。**

Windows 未签名产物要额外明说一句：**首次安装会被 SmartScreen 拦截，需手动"仍要运行"；
升级推的新包同样会被拦**——这不是 bug，是没买证书的必然结果。

---

## 9. 附录

| 文件                                    | 用途                                          | 依赖              |
| ------------------------------------- | ------------------------------------------- | --------------- |
| `scripts/probe.sh`                    | 项目画像探测（推荐入口，自动回退）                           | bash，可无 Node    |
| `scripts/probe.mjs`                   | 项目画像探测核心实现（含发布者 `author` 缺失告警）              | Node 16+，零依赖    |
| `scripts/preflight-win-sign.mjs`      | Windows 签名前置检查：证书可见性/私钥/过期、来源判定、`--warmup` 预热 PIN | Node 16+，Windows |
| `scripts/build.mjs`                   | 一键构建：签名预检 → 选命令 → 构建（注入签名参数）→ 收尾 → 产物校验；含 npm shim 回退与 rcedit 锁定兜底 | Node 16+ |
| `scripts/verify-artifact.sh`          | 产物验证：签名 / 公证 / staple / 清单配对（macOS 为主）      | bash + macOS 工具 |
| `scripts/verify-win-artifact.mjs`     | Windows 产物验证：清单 / sha512 / PE（NSIS 看载荷）/ blockmap / Authenticode；`--allow-unsigned`；入口自检 | Node 16+，零依赖 |
| `scripts/manifest-cli.mjs`            | 清单 ↔ 产物配对校验 CLI（`verify-artifact.sh` 调用；输出 ✓/✗/! 行，`--json` 可结构化） | Node 16+，零依赖 |
| `scripts/lib/manifest.mjs`            | 清单解析/序列化的唯一实现：`parseManifest` / `dumpManifest` / `createCodec` / `sha512File`（被 build / verify-win / manifest-cli 复用） | Node 16+，零依赖 |
| `scripts/lib/windows-sign.mjs`        | 证书枚举、签名来源解析、builder 参数拼装、预热（被 preflight/build 复用） | Node 16+，Windows |
| `scripts/lib/project-config.mjs`      | 读取 `.electron-release.json`                     | Node 16+      |
| `scripts/lib/powershell.mjs`          | 受限沙箱下用临时文件取回 PowerShell 结果（避开管道 EPERM）      | Node 16+，Windows |
| `scripts/install.sh`                  | 链接到各 agent 的技能目录                            | bash            |
| `tests/smoke.mjs`                     | 可复跑自测：清单配对 / 退出码 / ASCII 改名 / 清单改写 / 跨脚本契约（合成夹具，3 秒） | Node 16+，零依赖，不联网 |
| `references/mechanism.md`             | 机制速查：公证流程、凭据、entitlements 模板、清单结构、平台差异、坑位清单 | —               |
| `references/windows.md`               | Windows 分册：平台边界、依赖跨平台、十阶段流水线、NSIS 默认值、签名时序、rcedit 锁、云签名器、故障树 | —               |
| `assets/project-config.template.json` | 项目级配置模板                                     | —               |

**验证环境**：electron-builder 25.1.8 / @electron/notarize 2.5.0 / Electron 33.4.11 /  
macOS 15.7.8 / Windows 11 (26200) / Node 22。

改完脚本先跑 `node tests/smoke.mjs`（合成夹具，10 项契约断言，不联网、不碰真实项目）；
它通过只说明脚本自身没坏，不替代真实项目的端到端打包。

Windows 侧已用真实项目跑通 `build.mjs --platform win` 端到端（含 npm shim 回退、rcedit 退避补写、
`--prepackaged` 续跑、ASCII 改名 + blockmap + latest.yml 配对）。
签名注入链路（证书存储 → builder 参数 → 三路径回退）已用合成产物验证到
「校验脚本能区分已签名/未签名」；**真实证书 + SimplySign PIN 交互需在打包机上验证**，
无证书时应如实报告"未验证"，不要写成通过。
其他版本的机制细节（尤其公证字段默认值）**需读该项目的 node_modules 源码确认**，不要照搬本文档。
