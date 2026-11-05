# Electron 打包与发布机制速查

> 本文记录的是**机制事实**（读源码/实测得出），不是流程建议。流程见主 SKILL.md。
> 验证环境：electron-builder 25.1.8 / app-builder-lib 25.1.8 / @electron/notarize 2.5.0 /
> Electron 33.4.11 / macOS 15.7.8 / Node 22。

---

## 1. 签名与公证：最容易误判的部分

### 1.1 公证可能被静默跳过

`app-builder-lib/out/macPackager.js` 的 `notarizeIfProvided()` 逻辑：

```
if (notarize === false)        → 记 info 日志，跳过（明确关闭）
if (!getNotarizeOptions(...))  → 记 warn 日志，跳过（拿不到凭据）★危险★
otherwise                      → 执行 notarize
```

**凭据不全时构建仍然成功退出**。日志里只有一行 `warn`，构建产物是未公证的。
必须做产物级断言（`scripts/verify-artifact.sh`），不能看构建退出码。

### 1.2 凭据两套，互斥

`getNotarizeOptions()` 只认环境变量：

| 方案 | 变量 |备注 |
|---|---|---|
| Apple ID + 专用密码 | `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` + `APPLE_TEAM_ID` | 需在 App Store Connect 生成**专用密码**（不是登录密码） |
| App Store Connect API Key | `APPLE_API_KEY` + `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` | `APPLE_API_KEY` 指向 `.p8` 文件路径 |

`notarize.teamId` 字段已废弃，会打warn，要用 `APPLE_TEAM_ID`。

### 1.3 notarize 的完整动作链

`@electron/notarize` 2.5.0 `notarize()`：

```
checkSignatures(appPath)              → 未签名直接抛错，不浪费上传时间
isNotaryToolAvailable()               → 需 Xcode 13+ 或显式给 notarytoolPath
notarizeAndWaitForNotaryTool(...)     → 提交 + 轮询等待（可能几分钟到几十分钟）
stapleApp(appPath)                    → xcrun stapler staple，promise-retry 3 次
```

### 1.4 dmg 不会被 staple ★

`notarize()` 的 `appPath` 是 `.app`。**dmg 是之后才生成的产物，不在公证范围内**。
后果：用户挂载 dmg 安装，若 dmg 本身未 staple，部分 macOS 版本仍会拦截。

处置：打包后手动补一次

```bash
xcrun stapler staple dist/*.dmg
xcrun stapler validate dist/*.dmg
```

### 1.5 hardenedRuntime 与 entitlements

公证要求开启 Hardened Runtime。electron-builder 的相关字段：

| 字段 | 说明 |
|---|---|
| `mac.hardenedRuntime` | 开启后代码签名带 `runtime` flag |
| `mac.entitlements` | 主app 权限文件，默认读 `build/entitlements.mac.plist` |
| `mac.entitlementsInherit` | 子进程（Helper/Framework）权限，默认 `build/entitlements.mac.inherit.plist` |
| `mac.entitlementsLoginHelper` | 登录助手专用 |
| `mac.gatekeeperAssess` | 是否做 Gatekeeper 预评估；未公证产物评估失败会中断构建，正式包建议 `false` |

⚠️ **Electron 20+ arm64 硬性要求**：缺 `com.apple.security.cs.allow-jit` 会在
Hardened Runtime 下**启动即崩**（JIT 权限被拒）。最小可用 entitlements：

```xml
<!-- build/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

```xml
<!-- build/entitlements.mac.inherit.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict>
</plist>
```

---

## 2. 签名身份的选择

```bash
security find-identity -v -p codesigning
```

| 证书类型 | 用途 |
|---|---|
| `Apple Development: xxx` | 仅本机开发调试，**不可分发** |
| `Mac Developer Distribution` | App Store / MAS 用 |
| `Developer ID Application` | **开发者官网/第三方分发用**，需付费 Program |

`mac.identity: null` / `false` =显式跳过签名。这是很多项目的选择：
安装时 Gatekeeper 会拦，需用户手动放行。**必须提前告知用户**，否则会被当成 bug。

指定证书：

```json
{ "mac": { "identity": "Developer ID Application: Your Name (TEAMID)" } }
```

或让 electron-builder 自己从钥匙串选（本机构建默认如此）：

```bash
# 钥匙串里只有一张可用证书时什么都不用配；
# 有多张时（如 Apple Development 与 Developer ID 并存）用 CSC_NAME 指定
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
```

`.p12` 方案（CI / Docker 等无钥匙串环境，避免把证书写进配置）：

```bash
export CSC_LINK=/path/to/cert.p12     # 也支持 base64 内联
export CSC_KEY_PASSWORD=***
```

**钥匙串场景下 `CSC_LINK` / `CSC_KEY_PASSWORD` 不需要**，两个变量只在
证书以文件形式分发时才有意义。

---

## 3. electron-updater 清单机制

### 3.1 清单从哪来

electron-builder 构建时自动生成 `latest.yml`（win）/ `latest-mac.yml`（mac），
路径取自 `build.publish`（或 `build.directories.output` 下的同名文件）。
mac 的会写进 app 内的 `resources/app-update.yml`。

### 3.2 清单结构

```yaml
version: 1.1.1
files:
  - url: idea-note-1.1.1.dmg
    sha512: <base64>
    size: 122733243
  - url: idea-note-1.1.1.dmg.blockmap
    sha512: <base64>
    size: 130176
path: idea-note-1.1.1.dmg          # 主产物
sha512: <base64>                    # 主产物校验
releaseDate: '2026-09-21T08:39:57.000Z'
```

### 3.3 改写 url 的正确方式★

**必须 YAML 解析 → 修改 → 序列化。** 逐行文本替换会让缩进错位的
`sha512`/`size` 被并进 `url` 字符串，产出 electron-updater 无法解析的清单
（表现为「检查更新永远失败」或「下载后校验不通过」）。

需要把相对文件名改为绝对 URL（安装包在 GitHub、清单在自建服务器的场景）时：

```js
// 统一实现：scripts/lib/manifest.mjs（装了项目 js-yaml 就用它，没有则内置解析器）
import { createCodec } from './scripts/lib/manifest.mjs';
const { parse, dump } = createCodec([process.cwd()]);
const m = parse(fs.readFileSync('dist/latest-mac.yml', 'utf8'));
m.files = m.files.map(f => ({ ...f, url: `https://github.com/OWNER/REPO/releases/download/${TAG}/` + f.url }));
fs.writeFileSync(out, dump(m));
```

### 3.4 清单与产物必须成对发布★

**构建不可复现**：同一份源码、同一个版本号，两次构建的 sha512 不同
（构建时间戳、asar 顺序、zip 元数据等）。

因此：
- 清单必须与**当次构建**的产物成对发布
- 不要复用旧产物目录
- 不要手工编辑清单

### 3.5 客户端读取与覆盖

运行时可用`userData/update-config.json` 覆盖（仅 electron-updater 方案支持）：

```json
{ "provider": "generic", "url": "https://your-server/updates/", "autoDownload": false }
```

仅接受 `provider: generic` + `http(s)` URL，其余静默忽略。
开发模式（`app.isPackaged === false`）下自动更新必须禁用。

---

## 4. 分发模式对比

| 模式 | 安装包 | 清单 | 优点 | 缺点 |
|---|---|---|---|---|
| `github` | GitHub Release | GitHub Release | 一处托管，最简单 | 国内访问慢/不稳定 |
| `generic` | 任意静态托管 | 任意静态托管 | 完全可控 | 需自己管HTTPS 与目录 |
| `s3` / `spaces` / `b` 等 | 云存储 | 云存储 | 稳定 | 需云凭证 |

`generic` 的典型用法是「安装包放 GitHub（省流量费）+ 清单放国内服务器
（提升检查更新速度）」——清单很小但每次启动都要请求。

---

## 5. 目标平台差异

| 平台 | target | 产物 | 备注 |
|---|---|---|---|
| mac | `dmg` | `.dmg` | 图形安装器，适合首次安装 |
| mac | `zip` | `.zip` | **自动更新实际下载的就是 zip** |
| mac | `pkg` | `.pkg` | 支持安装脚本，可指定域 |
| win | `nsis` | `.exe` | 可配置是否可改安装目录 |
| win | `portable` | `.exe` | 免安装单文件 |
| win | `msi` | `.msi` | 企业部署 |
| linux | `AppImage` / `deb` / `rpm` / `snap` | 各自 | 自动更新支持有限 |

⚠️ **Windows 交叉构建**：纯 JS 项目可用 Wine（`electronuserland/builder:wine`）尝试，但属非官方路径；
**含原生模块的项目不可交叉构建**——`@electron/rebuild` 会直接拒绝，且失败可能把本地 `.node`
替换成 PE 二进制。详见 `windows.md` §1。

⚠️ **macOS zip 不含公证时 Gatekeeper 同样拦截**——自动更新推的 zip 若未公证，
升级后首次启动仍需手动放行。

---

## 6. 已知易踩点清单

| # | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 日志 `skipped macOS notarization` 但构建成功 | 凭据不全，静默跳过 | 补齐三个 `APPLE_*` |
| 2 | `The appleId property is required` | `APPLE_*` 只设了一部分 | 三件套齐备 |
| 3 | `Cannot use both password credentials and API key credentials at once` | 两套凭据同时存在 | 清掉一套 |
| 4 | `app is not signed` | `identity: null` 仍生效 | 去掉该字段，配好 `CSC_LINK` |
| 5 | `notarytool is not available` | Xcode < 13 | 装 CommandLineTools 或给 `notarytoolPath` |
| 6 | `Failed to staple` | 票据未就绪 | 隔几分钟重跑 `xcrun stapler staple` |
| 7 | dmg 被拦但 .app 正常 | dmg 未 staple | 手动 staple dmg |
| 8 | 启动即崩（JIT 相关） | 缺 `allow-jit` | 补 entitlements |
| 9 | 检查更新永远失败 | 清单格式被破坏 | 用 YAML 解析改写 |
| 10 | 校验失败但包看起来正常 | 清单与产物非同次构建 | 成对发布 |
| 11 | `gh` 建了 tag 但本地推不上去 | tag 顺序反了 | **tag 必须先于 Release 推送** |
| 12 | 版本号与 tag 不一致 | 手工打 tag 忘了同步版本 | 发版前核对 `git tag` 与 `package.json` |
| 13 | 更新源 404 但本地文件存在 | 服务器 root/alias 未指向部署目录，或清单名与 publish.url 拼接不一致 | `verify-artifact.sh --feed <url>` 会区分"服务器问题"与"代理问题" |
| 14 | 更新源时通时不通 | Clash fake-IP 池劫持 DNS，域名解析到 198.18.x（RFC 2544 保留段） | 查代理分流规则；发布配置里填真实服务器 IP |
| 15 | `--feed` 误判代理故障 | 只用默认路由 curl，未做对照 | 脚本已内置「代理 vs `--noproxy` 直连」双路对比，两路一致即为服务器侧问题 |
| 16 | 明明配置了 `identity: null`，包却是 ad-hoc 签名 | 新版 Electron 的 `app.asar`/helper 被 linker-signed（`flags=0x20002(adhoc,linker-signed)`），`codesign -dv` 看到的是 ad-hoc 而非"无签名" | 这仍等于**未签名**，Gatekeeper 同样会拦。脚本已能识别并报 `! ad-hoc 签名（非 Developer ID），仅本机可用，不可分发` |
| 17 | Gatekeeper 报 `code has no resources but signature indicates they must be present` | 解压/挂载后校验时签名与资源不匹配（常见于未公证包被当作已签名验证） | 以`codesign -dv` 判定的签名类型为准，Gatekeeper 报错文案仅作辅助 |
| 18 | `Brokered file token refused: modify backup failed` | **仅在 WorkBuddy 内**：沙箱注入的 `node-brokered-fs-shim.cjs` 拒绝 asar 打包时的备份写入，栈里出现 `asarUtil.ts writeAsarFile`。与项目配置无关 | `env -u NODE_OPTIONS npx electron-builder --mac`。注意 `npm run <script>` 内部步骤同样继承该变量，只剥外层无效 |
| 19 | 判断磁盘空间时误以为不足 | `df -h` 的读数受 APFS 快照影响，可能偏低数 GB | 权威读法 `diskutil info / \| grep -i free` → `Container Free Space`。另：构建 dmg 会挂载镜像，需额外空间比产物体积多算 1-2GB |
| 20 | 切分支后 `npm run package` 报 `Missing script` | 打包脚本（`release.sh`、`package`/`release` script）是某个 commit 引入的，**可能只在部分分支上存在**。裸 `electron-builder` 可用 | 先 `git merge-base --is-ancestor <脚本commit> HEAD` 确认脚本在本分支上；否则回退到 `npx electron-builder` |
| 21 | 切换分支后 `dist/` 里混着上一分支的产物 | `dist/` 不随git 分支隔离，不同分支的产物共存 | **核对产物 mtime 与本次构建时间是否同批次**；构建不可复现，混用会导致客户端 sha512 校验失败 |
| 22 | 裸 `electron-builder` 打完没有 ASCII 名与配对清单 | 收尾（stage_assets）通常封装在项目自带脚本里，回退路径不会执行 | 按 `dist/latest-mac.yml` 的 `files[]` 收齐（以清单为权威来源）、改名、YAML 改写 url、逐条校验 sha512；再 cross-check 原文件与副本 sha512 一致 |