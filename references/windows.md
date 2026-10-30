# Windows 打包与签名机制

> 本文是 `electron-release` 的 Windows 分册。mac 相关机制见 `mechanism.md`。
> 所有具体值（appId、证书指纹、产物名）都是示例，**以 `probe.mjs` 的探测结果为准**。

---

## 1. 平台边界：什么时候必须用 Windows 宿主

| 项目特征 | macOS/Linux 上能否产出可用的 Windows 包 |
|---|---|
| 纯 JS 依赖，无原生模块 | 可（Wine + NSIS），但属于非官方路径，需实测 |
| 含 `better-sqlite3` / `bufferutil` / `utf-8-validate` / `node-screenshots` 等原生模块 | **不可** |
| 使用了 `@electron/rebuild` | **不可**（源码级拒绝） |

`@electron/rebuild` 的 node-gyp 分支在 `rebuilder.platform !== process.platform` 时直接抛错。
更隐蔽的是**部分成功**：有预编译的模块（如 `better-sqlite3`）会拿到 win32 二进制，没有匹配
prebuild 的（如 `bufferutil`，其 `prebuilds/win32-x64/bufferutil.node` 命名不符合 prebuildify
期望的 `electron.napi.node` / `node.napi.node` / `electron.abi<ABI>.node`）才回退 node-gyp 并失败。

**失败副作用**：交叉构建会把 `node_modules/<native>/build/Release/*.node` 替换成 PE DLL，
导致同一份 `node_modules` 在 macOS 上立刻不可用。恢复方式是按项目脚本重建（例如
`npm run native:sqlite:electron`）。

> 结论：发布用途的 Windows 包，一律在 Windows 宿主构建。构建脚本应在非 Windows 宿主上
> **快速失败并说明原因**，而不是"试一下"。

---

## 2. 十阶段流水线

不同项目顺序可能不同，但职责划分一致。以下假设构建脚本名为 `dist:win`。

| # | 阶段 | 典型命令 | 判据 |
|---|---|---|---|
| 0 | 环境前置 | — | Windows 10/11 x64、Node ≥20、Python（若编排脚本用它）、Git、证书 |
| 1 | 安装依赖 | `npm ci` | `postinstall` 若含原生 ABI 切换，必须执行 |
| 2 | 生产依赖完整性 | `npm ls --omit=dev` | 打包只带 `dependencies`；devDependencies 会被剪掉 |
| 3 | 原生 ABI 对齐 | 项目脚本（如 `native:sqlite:electron`） | 必须按 **Electron ABI** 编译，不是 Node ABI |
| 4 | 子模块/附带应用构建 | 项目脚本 | 产物目录必须与 `extraResources.from` 对齐 |
| 5 | 应用编译 | `electron-vite build` / `vite build` | 主/preload/renderer 三份产物齐全 |
| 6 | 打包 | `electron-builder --win nsis --x64 --publish never` | `--publish never` 阻断自动上传 |
| 7 | 签名 | electron-builder 内部 `signIf` | **必须早于 blockmap / latest.yml** |
| 8 | 更新元数据 | 自动生成 `.blockmap` + `latest.yml` | `sha512` 基于**已签名**字节 |
| 9 | 产物校验 | `verify-win-artifact.mjs` | 见 §7 |
| 10 | 发布 | 项目自定 | 与构建解耦，失败可单独重跑 |

### 2.1 为什么要 `npm ls --omit=dev`

electron-builder 只收集 `dependencies`。如果某包只在 `devDependencies` 里、却被主进程
运行时 `import`，构建能过、安装后必崩。这类问题叫"幽灵依赖"，建议在 CI 或 preflight 里
做静态扫描（扫描 `import`/`require` 与 `package.json` 声明是否一致）。

### 2.2 原生模块的两个必查项

| 项 | 检查方式 |
|---|---|
| 是否必须 `asarUnpack` | 需要 `dlopen` 的 `.node` 必须在 asar 外；漏了会在运行时报 `Cannot find module` |
| 二进制架构是否匹配 | 见 §7 的 PE 架构检查；x64 安装包里混入 arm64 `.node` 时，安装成功但启动崩 |

### 2.3 什么时候需要 C++ 编译工具链

electron-builder 默认重建原生模块（`npmRebuild !== false`），但**是否真的编译**取决于模块类型：

| 类型 | 判定依据 | 行为 |
|---|---|---|
| `prebuild-install` | `scripts.install` 含 `prebuild-install` | 优先下载 Electron 对应预编译，失败才回退编译 |
| `node-gyp-build` | `scripts.install` 为 `node-gyp-build` | **直接 `node-gyp rebuild --build-from-source`，不读 `prebuilds/`** |
| 平台包 | `optionalDependencies` 里的 `*-win32-x64-msvc` 等 | 无需编译 |

源码依据：`@electron/rebuild/lib/module-type/node-gyp/node-gyp.js:74-83`。

⇒ 判断要不要装 VS Build Tools（C++ 工作负载）与 Python：

```bash
node -e "for (const m of Object.keys(require('./package.json').dependencies)) { try { const p = require('./node_modules/' + m + '/package.json'); if (p.scripts && p.scripts.install) console.log(m, '→', p.scripts.install) } catch {} }"
```

输出里出现 `node-gyp-build` 或含 `node-gyp rebuild` 的模块，在 Windows 上需要编译器。
典型例子：`bufferutil` / `utf-8-validate` 即使自带 `prebuilds/win32-x64/*.node`，也属于这一类
——`prebuilds` 目录存在不等于会被使用，`@electron/rebuild` 不读它。

---

## 3. 配置面（`package.json#build`）

| 字段 | 作用 | 易错点 |
|---|---|---|
| `appId` | 更新身份、注册表、安装标识 | 换项目必须改；改了等于换应用 |
| `productName` | 安装目录名、快捷方式、`artifactName` 前缀 | 含空格/中文会影响路径与脚本 glob |
| `directories.output` | 产物目录 | 发布脚本常硬编码该路径，改名要同步 |
| `files` | 应用代码白名单 | **不用于排除生产依赖**；依赖由 builder 按 `dependencies` 单独收集 |
| `asarUnpack` | 解包原生模块 | 用 `**/*` 覆盖整个模块目录更稳 |
| `extraResources` | 附带应用/资源 | `${os}` 取值是 `win`/`mac`/`linux`，**不是 `darwin`** |
| `fileAssociations` | 文件关联 | `perMachine=false` 时注册到 HKCU |
| `protocols` | 深链协议 | 同上 |
| `win.target` | `nsis` / `portable` / `msi` | 多目标会改变产物与清单结构 |
| `win.artifactName` | 产物命名 | 发布脚本常按 `*setup*.exe` glob，改名要同步 |
| `win.signtoolOptions` | 签名参数 | 见 §5；旧版可能在 `win` 顶层，需按实际版本确认 |

### 3.1 `${os}` 宏的取值来源

```
app-builder-lib/out/platformPackager.js
  expandMacro(pattern, arch, appInfo, { os: this.platform.buildConfigurationKey })

app-builder-lib/out/core.js
  Platform.MAC     = new Platform("mac", "mac", "darwin")   // key = mac
  Platform.WINDOWS = new Platform("windows", "win", "win32") // key = win
```

⇒ `native-extensions/${os}` 在 macOS 上取 `native-extensions/mac`，**不是** `darwin`。
Windows 上取 `win`，与 `process.platform`（`win32`）不同。

---

## 4. NSIS 默认行为（未配置 `nsis` 块时）

| 选项 | 默认 | 实际含义 |
|---|---|---|
| `oneClick` | `true` | **静默一键安装，用户无法选择目录** |
| `perMachine` | `false` | 装到 `%LOCALAPPDATA%\Programs\<productName>`，无需管理员 |
| `allowToChangeInstallationDirectory` | `false` | 仅在 `oneClick:false` 时有意义 |
| `createDesktopShortcut` | `true` | 自动建桌面快捷方式 |
| `createStartMenuShortcut` | `true` | 自动建开始菜单项 |
| `deleteAppDataOnUninstall` | `false` | 卸载保留用户数据 |

源码证据（`app-builder-lib/out/targets/nsis/NsisTarget.js`）：

```js
const oneClick = options.oneClick !== false;      // :137
const isPerMachine = options.perMachine === true; // :146
if (options.allowToChangeInstallationDirectory) {
  if (oneClick) throw new InvalidConfigurationError(
    "allowToChangeInstallationDirectory makes sense only for assisted installer (please set oneClick to false)");
}                                                  // :444-446
```

**企业部署/需要选目录时**，必须显式：

```json
{ "nsis": { "oneClick": false, "allowToChangeInstallationDirectory": true, "perMachine": false } }
```

只设 `allowToChangeInstallationDirectory` 而忘了 `oneClick:false`，构建会**直接报错**。

---

## 5. Windows 签名

### 5.1 时序：签名必须先于更新元数据（硬约束）

`NsisTarget.js`：

```js
await this.executeMakensis(...)                                  // :300 生成 installer
await Promise.all([packager.signIf(installerPath), ...])         // :301 签名
updateInfo = await createBlockmap(installerPath, ...)            // :308 之后才算 sha512
await emitArtifactBuildCompleted({ file, updateInfo })           // :313 写 latest.yml
```

⇒ `latest.yml.files[].sha512` 必然基于**已签名**字节。
**任何"构建完再用脚本重签"的流程都是错的**：重签会改变哈希，客户端校验必失败。

### 5.2 证书来源三选一

electron-builder 的决策顺序（`codeSign/windowsSignToolManager.js:48-95`）：

| 优先级 | 配置 | 结果 |
|---|---|---|
| 1 | `signtoolOptions.certificateSubjectName` 或 `certificateSha1` | 从 Windows 证书存储查找，**直接 return** |
| 2 | `signtoolOptions.certificateFile` | 用 PFX 文件 |
| 3 | 环境变量 `WIN_CSC_LINK` | 导入临时证书 |

⚠️ **`certificateSha1` 一旦设置即独占来源**，不会回退 PFX / `WIN_CSC_LINK`。
两条路只能选一条；混用会导致"配了 PFX 却不生效"。

### 5.3 SimplySign / 云签名器（虚拟智能卡）

**云签名客户端本身不签名。** SimplySign（Certum）这类工具通过虚拟智能卡把云证书暴露到
`Cert:\CurrentUser\My`（`HasPrivateKey=True`），私钥由 KSP/CSP 动态提供；真正执行仍是
`signtool.exe`。

因此与 `certificateSha1` 方案天然兼容——builder 生成 `/sha1 <thumbprint>`，正是这类工具
推荐的方式，不需要 PFX。

| 约束 | 不满足的后果 | 应对 |
|---|---|---|
| 客户端保持登录 | 私钥不可用 → `After Private Key filter, 0 certs were left` | 打包前检查登录态与证书可见性 |
| PIN / 手机确认 | 一次构建会签 app exe、installer、uninstaller，可能多次确认；无人值守时**卡住而非报错** | 开 PIN 缓存（SimplySign 约 3 小时） |
| 进程位数匹配 | 32 位 signtool 可能访问不到 64 位 KSP | 用 electron-builder 自带的 `windows-10/x64/signtool.exe` |
| 证书续期 | thumbprint 变化 | 同步更新配置/环境变量 |

**必须做的一步：把 PIN 确认前移到构建之前。**

```powershell
# 对上一次构建的 exe 签一次，触发 PIN/手机确认（之后走缓存）
signtool sign /sha1 "<THUMBPRINT>" /fd sha256 `
  /tr http://timestamp.digicert.com /td sha256 `
  .\release\win-unpacked\<app>.exe
```

不预热时，electron-builder 会卡在 `Submitting digest for signing...`，表现为"构建无响应"，
而不是报错——这是无人值守场景最容易误判的失败形态。

### 5.4 `After Private Key filter, 0 certs were left` 的两种成因

| 情形 | 特征 | 处理 |
|---|---|---|
| A. 本地 PFX 导入但私钥缺失 | `Issued to: ()` 空 subject；`certutil -store My` 的 `PrivateKey` 为空 | 重新导入含私钥的 pfx |
| B. 云签名器 KSP 未就绪 | 证书 `HasPrivateKey=True`，但只在客户端登录会话内可签 | 重新登录 / 预热 PIN / 换 64 位 signtool |

两者输出完全相同，不能只凭报错文本判断。

### 5.5 `publisherName` 与 electron-updater

`publisherName` 用于客户端校验更新包签名（`electron-updater/out/windowsExecutableCodeSignatureVerifier.js:70-82`）：

- 必须与签名证书 Subject **完全一致**（建议写完整 DN，而不是只写 CN）
- 只写 CN 时会有告警 `Please add your full Distinguished Name`
- 中文 DN 需注意编码：PowerShell 侧已 `chcp 65001`（`:14`），但自定义校验脚本可能踩坑

未配置 `publisherName` 时，builder 会回退到证书 `commonName`（`windowsSignToolManager.js:27-28`）；
显式配置可避免证书自动发现带来的不确定性。

### 5.6 时间戳

```json
{ "signtoolOptions": {
    "signingHashAlgorithms": ["sha256"],
    "rfc3161TimeStampServer": "http://timestamp.digicert.com"
} }
```

不带时间戳的签名在证书过期后即失效。常用端点：

| 服务 | 地址 |
|---|---|
| DigiCert | `http://timestamp.digicert.com`（通用，不要求证书同源） |
| Sectigo | `http://timestamp.sectigo.com` |
| Certum | `http://time.certum.pl` |

---

## 6. 更新元数据

Windows 的清单是 `latest.yml`（macOS 是 `latest-mac.yml`）。由 builder 自动生成，包含：

```yaml
version: 1.2.3
files:
  - url: MyApp-Setup-1.2.3.exe
    sha512: <base64>
    size: 123456
path: MyApp-Setup-1.2.3.exe
sha512: <base64>
releaseDate: '2026-10-29T00:00:00.000Z'
```

要点：

1. `version` 必须等于 `package.json` 的 version，否则客户端不触发升级。
2. `files[].sha512` 与 `path` 必须指向同一批产物。
3. 清单必须与产物**成对发布**——构建不可复现，同版本两次构建 sha512 不同。
4. 改写 `url` 时必须用 YAML 解析，禁止逐行文本替换（见 `mechanism.md` §3.3）。

---

## 7. 产物校验

```bash
node <SKILL_DIR>/scripts/verify-win-artifact.mjs --dir release --expect-version 1.2.3
```

| # | 检查项 | 失败含义 |
|---|---|---|
| 1 | 清单存在且可解析 | 更新链路无从谈起 |
| 2 | 清单 version == 期望版本 | 客户端不会升级 |
| 3 | `files[].url` 对应产物存在 | 清单指向不存在的文件 |
| 4 | 产物体积 == 清单 size | 产物被替换或清单过期 |
| 5 | 产物 sha512 == 清单 sha512 | **签名晚于元数据 / 混入旧批次** |
| 6 | `path` == `files[0].url` | 清单内部不一致 |
| 7 | PE 头合法 + 架构符合预期 | 误打 32 位 / arm64 |
| 8 | blockmap 存在且与 exe 同批 | 差量更新不可用；或产物混批 |
| 9 | Authenticode 有效 + 含时间戳 | 未签名 / 证书链问题 / 证书过期后失效 |

第 9 项：Windows 上走 `Get-AuthenticodeSignature`；其他平台优先 `osslsigncode verify`，
都没有则标 `SKIP`（**不算通过**）。

退出码：`0` 全部通过；`1` 有失败项；`2` 参数/环境错误。

**不经脚本时的 PE 架构手工核验**（`0x8664` = x64 / `0x14c` = x86 / `0xaa64` = arm64）：

```bash
node -e "const b=require('fs').readFileSync('<path>/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node');console.log('machine=0x'+b.readUInt16LE(b.readUInt32LE(0x3c)+4).toString(16))"
```

### 7.1 无法脚本化的两项

| 项 | 为什么 | 建议 |
|---|---|---|
| 干净机安装实测 | 需要虚拟机/独立机器 | 人工 checklist：安装→启动→文件关联→深链→卸载 |
| SmartScreen 信誉 | 新证书需要积累下载量 | OV 证书前几周仍会提示；EV 可跳过等待期 |

---

## 8. 故障树

| 现象 | 根因 | 处置 |
|---|---|---|
| `After Private Key filter, 0 certs were left` | PFX 缺私钥，或云签名器 KSP 未就绪 | 见 §5.4 |
| 构建卡在 `Submitting digest for signing...` | 等待 PIN / 手机确认 | 开 PIN 缓存并预热（§5.3） |
| `npm run dist:win` 在 mac 上失败 | 交叉构建，原生模块拒绝 | 改用 Windows 宿主（§1） |
| 交叉构建后本机应用起不来 | 原生二进制被换成 PE | 重建对应 ABI（项目脚本） |
| 构建成功但客户端更新报哈希错误 | 签名晚于 blockmap/latest.yml | 让 builder 签名，删掉后置重签（§5.1） |
| 客户端不提示更新 | `latest.yml.version` 与 package.json 不一致 | 跑 `verify-win-artifact.mjs` 第 2 项 |
| 安装包能装但用户要求选目录 | 默认 `oneClick=true` | 显式 `oneClick:false` + `allowToChangeInstallationDirectory:true` |
| 更新被拒，提示 publisher 不匹配 | `publisherName` 与证书 Subject 不一致 | 写完整 DN，重发版本 |
| 应用启动崩，日志无业务错误 | 原生模块架构不符 / 未 `asarUnpack` | 查 PE 架构与 asarUnpack |
| 卸载后配置残留 | 默认 `deleteAppDataOnUninstall=false` | 按需显式设为 `true` |

---

## 9. 与 macOS 的差异对照

| 维度 | Windows | macOS |
|---|---|---|
| 签名工具 | `signtool`（builder 自带工具集） | `codesign` |
| 签名对象 | app exe + installer + uninstaller | 主 app + 嵌套 app + dmg（dmg 需手动 staple） |
| 凭据 | 证书存储 / PFX / 云签名器 | 钥匙串 / `.p12` + 公证凭据 |
| 公证 | 无 | 必须 `notarytool` + staple |
| 更新清单 | `latest.yml` | `latest-mac.yml` |
| 归档产物 | `.exe` + `.blockmap` | `.dmg` + `.zip` + `.blockmap` |
| 交叉构建 | 原生模块场景不可行 | 同 |
| 用户拦截 | SmartScreen（按证书信誉） | Gatekeeper（按签名+公证） |

---

## 10. 人工介入点

| 项 | 为什么必须人工 |
|---|---|
| 证书主体确认 | 用他人主体签名涉法律风险 |
| 云签名器登录 / OTP | 凭据在手机上，不应入库 |
| 首次 PIN 输入 | 交互式确认，无法自动化 |
| 干净机安装实测 | 需独立环境 |
| 发布放行 | 远端写操作不可逆 |
