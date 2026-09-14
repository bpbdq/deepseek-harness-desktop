# dsh-desktop · DeepSeek Harness 桌面客户端

**中文（当前）| [English documentation](README.en.md)**

把 **DeepSeek Harness（`dsh`）** 做成一个装完即用的桌面应用。

终端用户**不需要安装 Node.js，也不需要 npm**：装好打开就能用完整功能。官方 Web UI 被原样复用，所以 `dsh web` 有的一切都在——工具、沙箱、会话、后台任务、子代理、工作流、技能、MCP——桌面外壳另外补上它才能提供的东西：真正的窗口、关窗后仍在跑任务的托盘、系统密钥链存凭据、以及自动更新。

[![release](https://img.shields.io/badge/release-GitHub%20Releases-blue)](../../releases)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

---

## 目录

- [为什么是这个设计](#为什么是这个设计)
- [功能](#功能)
- [下载安装](#下载安装)
- [界面与用法](#界面与用法)
- [架构](#架构)
- [更新机制](#更新机制)
- [凭据存储](#凭据存储)
- [从源码构建](#从源码构建)
- [打包](#打包)
- [版本管理](#版本管理)
- [项目结构](#项目结构)
- [已知限制](#已知限制)
- [故障排查](#故障排查)

---

## 为什么是这个设计

三条来自官方 `@deepseek-ai/dsh` 包的事实决定了整个架构。这些是查证结果，不是偏好：

| 事实 | 出处 | 结论 |
|---|---|---|
| `desktop` 这个 profile 名**是留给 Electron 应用的** | `dsh/README.md:20`；`dsh/lib/bin.js:29` 明确拒绝该名字 | 我们就是官方预设的 `desktop` profile 拥有者。**不修改、不 fork `dsh`。** |
| `loadProfileDirectory()` 的存在意义是 *"application-owned profiles whose package project and lifecycle belong to that application"* | `@deepseek-ai/dsh-app-boot` | 应用通过公开 API 启动插件树，**从不调用 `dsh` 命令行**。 |
| `dsh web` 支持 `--no-open` 与 `--port 0` | `@deepseek-ai/dsh-web-app/lib/startup.js` | 外壳自己掌管窗口，并让操作系统分配空闲端口。 |

另外运行时需要 **Node 22.13+/24**（`zlib.createZstdCompress`、`util.getSystemErrorMessage`、`module.stripTypeScriptTypes`），比 Electron 33 自带的 Node 20 新。因此应用内置一份固定版本的便携 Node，而不是借用 Electron 的。见[架构](#架构)。

---

## 功能

**完整继承官方能力**（因为复用的就是官方 Web UI 本身）：

- 全部工具：文件读写、搜索、PowerShell / Bash、Web 搜索抓取、子代理、工作流、Ralph 循环、目标、技能、MCP
- 文件系统沙箱与权限模式
- 会话持久化与恢复、后台任务、计划任务
- **右侧栏**：文件树 + 文档预览（Markdown / 代码 / 图片 / PDF / HTML），点文件行号可直接跳转
- **Open In…**：一键把工作区在编辑器 / 终端 / 文件管理器中打开
- 中英文界面（跟随系统语言）

**外壳额外提供**：

- 真正的桌面窗口，几何尺寸记忆
- **托盘常驻**：关窗后目标、后台任务、子代理继续运行
- 自动查找并安装新版智能体运行时，失败自动回退
- 凭据经操作系统密钥链加密（DPAPI / Keychain / libsecret）
- 单独的 Harness 主目录，与命令行版 `dsh` 完全隔离、可共存
- 原生目录选择器、原生菜单、单实例、外部链接交给系统浏览器

---

## 下载安装

到 [Releases](../../releases) 下载对应平台的文件。

| 平台 | 文件 | 说明 |
|---|---|---|
| **Windows** | `DeepSeek Harness-<版本>-x64.exe` | NSIS 安装程序，可选安装目录 |
| **Windows** | `DeepSeek Harness-<版本>-x64.msi` | 适用于企业批量部署 / 组策略 |
| **Linux** | `DeepSeek Harness-<版本>-x64.AppImage` | 免安装，`chmod +x` 后直接运行 |
| **Linux** | `DeepSeek Harness-<版本>-x64.deb` | Debian / Ubuntu |
| **Linux** | `DeepSeek Harness-<版本>-x64.rpm` | Fedora / RHEL / openSUSE |
| **macOS** | `DeepSeek Harness-<版本>-x64.dmg` | Intel 芯片 |
| **macOS** | `DeepSeek Harness-<版本>-arm64.dmg` | Apple 芯片（M 系列） |

### macOS 首次打开

macOS 产物**未签名**（发布流程未配置 Apple 开发者证书），Gatekeeper 会拦截。首次打开请：

**右键点击应用 → 打开 → 在弹窗里再次点「打开」**

之后就能正常双击启动了。如果提示「已损坏」，执行一次：

```bash
xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness.app"
```

### 安装界面语言

安装界面的语言按平台能力区分，不是统一的：

| 平台 | 安装界面 | 语言 |
|---|---|---|
| Windows `setup.exe` | NSIS 安装向导 | **简体中文** |
| Windows `.msi` | Windows Installer 向导 | 英文（见下） |
| Linux `.deb` / `.rpm` / AppImage | 无界面，`dpkg -i` / 直接运行 | 不适用 |
| macOS `.dmg` | 无界面，拖拽到「应用程序」 | 不适用 |

**只有 Windows 的 NSIS 安装程序有可本地化的安装向导**，它已固定为简体中文，由
`electron-builder.yml` 的两个选项控制：

```yaml
nsis:
  language: 2052               # LCID 十进制，不是语言名
  installerLanguages: [zh_CN]  # 语言名，映射到 NSIS 自带的 SimpChinese
```

MSI 目前仍是英文：electron-builder 的 MsiTarget 不提供语言选项，其拉取的 WiX
工具链只含 `WixUIExtension.dll`、不含本地化 `.wxl` 文件。中文 MSI 需要自建 WiX
UI 扩展，暂未实现。

> 这是**安装程序**的语言；安装后的应用界面是另一套机制，跟随系统语言（中英文），
> 由 `src/main/i18n.ts` 控制。

### 首次启动要做什么

应用会引导你填入 **API Key**。填入后即可开始使用。

凭据用操作系统密钥链加密后存在本应用自己的数据目录里，**不会**写进明文的 `.credentials.yaml`。

---

## 界面与用法

### 右侧栏（文件查看与审查）

会话标题栏**右上角**有个展开按钮（左栏收起图标的镜像），点它打开右侧栏。里面可以：

- 浏览当前工作区的**文件树**
- 点文件直接**预览**：Markdown、代码（带语法高亮）、图片、PDF、HTML
- 从对话里的文件链接或工具行号引用直接跳进右侧栏对应位置

> 右侧栏是**会话作用域**的：没有会话时按钮和面板都不渲染，这是官方设计。

### 顶部菜单

| 菜单 | 内容 |
|---|---|
| 文件 | **打开文件夹…**（`Ctrl+O`）、**最近打开**、**项目信息…**（`Ctrl+I`）、在文件管理器中打开工作区、复制工作区路径、重新加载、强制重新加载、开发者工具、退出 |
| 编辑 | 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 |
| 视图 | 缩放、全屏 |
| **更新** | **检查智能体运行时更新…**（`Ctrl+Shift+U`）、当前版本号 |
| 帮助 | 检查智能体运行时更新… |

### 切换项目（工作区）

**文件 → 打开文件夹…**（`Ctrl+O`）选一个目录，即可把它作为新工作区打开；也可以用
**文件 → 最近打开** 快速切回之前的项目（最多 8 条，已删除的目录会自动从列表移除，
重名时用父目录消歧）。

两个实用入口：

- **在文件管理器中打开工作区** —— 不想手抄路径时用
- **复制工作区路径** —— 把这个路径粘到终端里用

**切换工作区会重启应用**，这是刻意的取舍：工作区是在服务端启动时传入的，中途
更换需要重建整棵插件树（约 11 秒），而重启走的是同一条已验证的启动路径，不存在
"半个进程还在用旧工作区"的中间态。会话已持久化，重启后可继续之前的对话。
切换前会明确询问，不会静默刷新界面。

### 项目信息与 Git 分支

**文件 → 项目信息…**（`Ctrl+I`），或托盘的「项目信息…」，会打开一个只读面板，显示：

- **Git 分支**，含未提交改动条数与相对上游的领先 / 落后（`master*  ↑2 ↓1`）
- 工作区路径
- 智能体运行时版本，以及它来自**内置**还是**已下载的更新**
- 内置 Node 与 Electron 版本
- Harness 主目录与应用数据目录

当前工作区的分支还会显示在**窗口标题栏**上，例如
`DeepSeek Harness — master*`，一眼就能看出在哪个分支上工作。

> 不是 git 仓库、或机器上没有 git 时，面板显示「不是 git 仓库」而不是报错——
> 这属于正常状态。探测走的是 `git` 子进程，每条命令都有 5 秒超时，不会拖住界面。

### 托盘

关闭窗口不会退出应用——窗口隐藏到托盘，**后台任务继续运行**。托盘右键菜单：

- 打开 DeepSeek Harness
- 重启智能体运行时
- 检查运行时更新…
- 退出（真正的退出）

---

## 架构

```
Electron 主进程                              dsh 服务端子进程
──────────────────────────                   ─────────────────────────
单实例锁                                      cwd            = 用户工作区
窗口 / 托盘 / 菜单 / 深链                     DSH_HOME       = <userData>/home
凭据解密（系统密钥链）                        profile        = desktop
运行时更新器                                  bundles        = dsh-base + dsh-web-app
      │                                             │
      │  spawn（内置 Node）                          │  loadProfileDirectory()
      └────────────────────────────────────────────►│  healProfilesModuleFallback()
                                                    │  boot() + provideCmdline()
      ◄──── stdout: "dsh web: http://127.0.0.1:PORT/?token=…"
      ◄──── stdout: "[dsh-desktop] ready"
      │
      └─ BrowserWindow 只加载一次带 token 的 URL → 服务端写入签名 Cookie
         并 302 到干净的 "/" → 此后界面凭 Cookie 认证
```

**所有执行智能体代码的东西都在子进程里。** 主进程只是外壳，所以智能体崩溃或 OOM 不会带走窗口，窗口隐藏时目标 / 循环 / 后台任务 / 子代理都继续运行。

### 认证握手

每个服务端进程生成一个随机启动 token。服务端**只**在 `GET /` 上接受它，用它换取一个绑定 authority 的签名 Cookie，然后重定向到干净的 `/`。因此窗口只加载一次带 token 的 URL，地址栏里永远不会留下凭据。不带 Cookie 直接请求 `/` 会返回 `401`——那是防护在正常工作。

### 运行时目录布局

```
resources/                     安装包释放，位于 app.asar 之外
  runtime/                     完整的 @deepseek-ai/dsh 依赖树
    node_modules/@deepseek-ai/dsh
    node/                      固定版本的便携 Node
    runtime.json               记录 stage 的版本与来源
  server/server.mjs            启动脚本（见 src/server/）

app.asar
  dist/main/…                  编译后的外壳
  dist/preload/…
  node_modules/npm/            解包存放，使运行时更新无需系统 npm
```

`runtime/` **必须**放在 `app.asar` 之外：harness 启动时会创建真实的目录联接（junction）、会 spawn 原生目录选择器等辅助进程、还会按路径加载原生插件——这些在 asar 虚拟文件系统里都不成立。

**启动脚本必须从 `<runtime>/server.mjs` 运行**，不能从 `resources/server/` 运行。Node 解析裸模块名是从**脚本自己所在目录**向上找 `node_modules` 的，放在 `resources/server/` 时查找链会走到盘根，直接 `ERR_MODULE_NOT_FOUND`。主进程在 spawn 前把它复制到运行时根目录，这也顺带覆盖了"下载来的新运行时里没有启动脚本"这种情况。

`DSH_HOME` 默认是 `<userData>/home`，与命令行版的 `~/.dsh` **刻意分开**，两者可以共存而不互相污染会话与凭据。

---

## 更新机制

刻意分成两条独立的轨道：

| 轨道 | 更新对象 | 方式 |
|---|---|---|
| **运行时** | `@deepseek-ai/dsh` 及其 bundle | 应用查询 npm registry，把新版本装进 `<userData>/runtime/<版本>/`，然后原子切换 `current` 目录联接 |
| **外壳** | 本 Electron 应用自身 | `electron-updater` 走 GitHub Releases |

分开的原因：`dsh` 迭代很快（`0.1.5-rc.1`、`rc.2`……）。把运行时混进安装包里，意味着每个补丁版本都要用户重装整个应用。

### 在哪里触发更新

两条轨道共用一个入口：**菜单栏 → 更新 → 检查更新…**（`Ctrl+Shift+U`），
或托盘右键 →「检查更新…」。

窗口立刻打开并显示「正在检查」，两条检查**并行**进行、结果各自推送：

| 分节 | 展示内容 |
|---|---|
| **智能体运行时** | 已安装版本、该通道最新版本、运行时来源（内置 / 已下载）、所用源、通道、安装位置 |
| **应用外壳** | 已安装版本、最新已发布版本 |

有可用更新时，对应分节下方会出现操作按钮（运行时是「更新运行时并重启」，外壳是
「下载并安装」，下载时显示百分比进度）。

**应用外壳无法检查时会说明原因**，而不是只显示一句「无法检查」。开发模式下运行的
未打包应用没有 `app-update.yml`，因此自更新不可用，窗口里会直接写明这一点。

> 启动时**不再**自动静默检查外壳更新。此前那会在启动后偷偷弹一个对话框，用户既不
> 知道是谁触发的、也不知道何时检查的。现在两条轨道都只在用户主动打开更新时检查；
> 唯一的例外是 `autoInstallOnAppQuit`——已经下载完成的更新会在退出时安装，避免
> 用户点了下载却因为忘记重启而一直用旧版本。

### 安全设计

新版本先装进临时目录，校验通过后再改名就位——下载中断不会留下一个"看起来能用"的运行时。如果更新后的运行时启动失败，应用会删掉 `current` 联接、回退到内置运行时、并重启。

`profiles/node_modules` 在每次启动时自动重建，所以切换运行时后**不需要任何重装步骤**。

### 通道

默认跟随 `latest`。可以改成本应用设置目录下 `settings.json` 里的 `channel` 字段：

```json
{ "channel": "next" }
```

可选值：`latest`、`next`、`alpha`。

---

## 凭据存储

API Key 用 Electron 的 `safeStorage` 加密（Windows 走 DPAPI，macOS 走 Keychain，Linux 走 libsecret）：随机 32 字节数据密钥由系统密钥链包裹，凭据表用 AES-256-GCM 密封存入 `<userData>/credentials/sealed.bin`。

投递给 harness 不需要自定义 provider。`dsh` 的凭据解析有固定优先级，其中**启动环境变量优先**：

```
启动环境变量  >  存储文件  >  项目 .env  >  主目录 .env
```

所以外壳解密后把值通过环境变量传给子进程，行为与 `DEEPSEEK_API_KEY=… dsh` 完全一致，并在设置界面里正确地显示为只读。

若系统加密不可用（例如缺少 libsecret 的 Linux），存储会报告不可用，而**不会**静默降级成明文；此时 `$DSH_HOME` 下官方的文件式 provider 仍可正常工作。

---

## 从源码构建

**打包机**需要 Node.js 20+ 与 npm（终端用户不需要）。

```bash
git clone <本仓库地址>
cd dsh-desktop
npm install
npm run icon       # 生成占位图标 build/icon.png（见下）
npm run stage      # 准备内置运行时、便携 Node，并链接开发期依赖
npm run dev        # 编译并启动未打包的应用
```

> **关于图标**：`build/icon.png` 被 `.gitignore` 排除，因为仓库里不该塞占位资源。
> 打包前必须先执行一次 `npm run icon`；正式发布请把它换成你的品牌图标
> （256×256 或更大的 PNG，或 ico/icns）。

单独执行各步骤：

```bash
npm run stage:runtime                  # @deepseek-ai/dsh@latest
npm run stage:runtime -- next          # 跟随 dist-tag：latest | next | alpha
npm run stage:runtime -- 0.1.5-rc.2    # 固定到指定版本
npm run stage:node                     # 固定版本的便携 Node（按当前平台）
npm run stage:node darwin arm64        # 交叉准备其它平台的 Node
npm run build                          # 只编译 TypeScript
npm run typecheck                      # 只做类型检查
```

### 开发期状态隔离

`DSH_DESKTOP_HOME` 可以覆盖每用户数据目录（harness 主目录、窗口几何、凭据、已下载的运行时都在里面）：

```powershell
$env:DSH_DESKTOP_HOME="$PWD\.dev-home"
npm run dev
```

不加这个变量时，开发运行和已安装版本会共用同一个目录（因为二者的 `package.json` 名字相同），互相覆盖状态。

### 国内构建机的镜像配置

`.npmrc` 已经把 registry 指向镜像。但**两个 electron-builder 的镜像提示不是合法的 npm 配置项**（npm 会对未知键告警），要用环境变量传：

```powershell
$env:ELECTRON_MIRROR='https://registry.npmmirror.com/-/binary/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR='https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
npm run dist
```

`scripts/stage-node.mjs` 识别 `DSH_NODE_MIRROR` 与 `DSH_NODE_VERSION`，`scripts/stage-runtime.mjs` 识别 `DSH_STAGE_REGISTRY`。

---

## 打包

### 用 bat 一键打包（Windows 构建机）

```bat
build.bat            打包 Windows（setup.exe + .msi）
build.bat linux      打包 Linux（AppImage + .deb）
build.bat all        打包 Windows + Linux
build.bat mac        显示 macOS 打包说明
build.bat clean      清理 dist 与当前版本目录后完整打包 Windows
build.bat help       完整用法
```

环境变量：

```bat
set SKIP_STAGE=1     跳过运行时准备（已 stage 过，可省数分钟）
set SKIP_INSTALL=1   跳过 npm install
```

#### 产物按版本分目录

每个版本一个目录，**文件名里不带版本号**：

```
release/
  1.0.0/
    DeepSeek Harness-x64.exe          ← NSIS 安装程序
    DeepSeek Harness-x64.exe.blockmap
    DeepSeek Harness-x64.msi
    latest.yml                        ← electron-updater 的元数据
  1.0.1/
    …
  latest.txt                          ← 指向最新版本目录名
```

这样同平台多版本可以并存，升级时不会互相覆盖，文件名也不会随版本号反复变动
（对外下载链接更稳定）。

`build.bat clean` **只清当前版本目录**，不动其它版本——那正是分目录的意义。

### 各平台的可构建性（已实测，非推测）

| 目标 | 能否在 Windows 上构建 | 原因 |
|---|---|---|
| `setup.exe`（NSIS） | ✅ | |
| `.msi` | ✅ | 需要 WiX，electron-builder 会自动下载 |
| `.AppImage` | ❌ | 需要 Linux 版 `mksquashfs`，报错 `appimage-12.0.1/linux-x64/mksquashfs: file does not exist` |
| `.deb` / `.rpm` | ❌ | 需要 `fpm`，报错 `fpm: executable file not found in %PATH%` |
| `.dmg` / `.zip`（macOS） | ❌ | 需要 `hdiutil` / `codesign` / `productbuild`，只在 macOS 上存在 |

**Linux 与 macOS 产物无法在 Windows 上生成**——这是构建工具链缺失，不是配置问题。
因此 `build.bat linux` 与 `build.bat mac` 会**立即停止**并打印替代方案，
而不是先下载几百 MB 再失败。

两种获得 Linux / macOS 产物的方式：

1. 在 Linux（或 WSL）上 `npm run dist:linux`，在 macOS 上 `npm run dist:mac`
2. 用 GitHub Actions 工作流——**推荐**，一次把三个平台都打出来

### GitHub Actions

`.github/workflows/release.yml` 在三个平台各自的 runner 上并行打包：

- **windows-latest** → `setup.exe` + `.msi`
- **ubuntu-latest** → `AppImage` + `.deb` + `.rpm`
- **macos-latest** → `x64` 与 `arm64` 的 `.dmg` + `.zip`

触发方式：

```bash
# 打标签即自动打包并创建草稿 Release
git tag v1.0.0
git push origin v1.0.0
```

也可以在 Actions 页面手动触发（只打包，产物作为 artifact 上传，不创建 Release）。

**运行状态**：可以在 [Actions](../../actions) 页面查看三平台构建进度。

**已配置**：`publish.owner` / `publish.repo` 已指向本仓库，推 `v*` 标签即可直接发布。

**若要启用签名**（可选），配置这些仓库密钥：

| 密钥 | 用途 |
|---|---|
| `MAC_CERT_P12` / `MAC_CERT_PASSWORD` | macOS 代码签名证书 |
| `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` | macOS 公证 |

未配置证书时产物可正常使用，但 Windows SmartScreen 和 macOS Gatekeeper 会给出警告。

---

## 版本管理

版本号只写在 `package.json` 里（`package-lock.json` 会同步，否则 `npm ci` 会失败），
`electron-builder` 从那里读取，产物目录名也用它。

### 打包会自动递增

**每次 `build.bat` 都会自动 +1**，所以连续打包得到的是各自独立的版本目录：

```
build.bat   →  1.0.0 → release/1.0.0/
build.bat   →  1.0.1 → release/1.0.1/
build.bat   →  1.0.2 → release/1.0.2/
```

递增规则：补丁号到 `.9` 之后进位到次版本并把补丁归零。

```
1.0.0 → 1.0.1 → … → 1.0.8 → 1.0.9 → 1.1.0 → 1.1.1 → …
```

**不改版本号重新打包**：加 `--no-bump`（改了打包配置后想按原版本重验时用）。

```bat
build.bat win --no-bump
```

**调试期不会被反复吃掉版本号**：同一版本在 5 分钟内的重复打包不会再次递增。
需要强制递增时用 `version.bat next --force`。

### 手动管理

```bat
version.bat             显示当前版本与下一个版本
version.bat next        递增（受 5 分钟节流限制）
version.bat next --force 强制递增
version.bat list        列出发布序列
version.bat 1.0.3       显式设置
```

核查三处版本是否一致（不一致会让 CI 的 `npm ci` 失败）：

```bat
node scripts\check-version.mjs
```

一次典型的本地打包与发布流程：

```bat
build.bat                          :: 自动递增版本并打包，产物在 release\<新版本>\
git add -A && git commit -m "release v1.0.1"
git tag v1.0.1 && git push origin v1.0.1
```

推送标签后，GitHub Actions 会在三个平台打包并**直接发布** Release（不是草稿）。
CI 里的版本号取自标签所在提交的 `package.json`，所以标签名应与它一致。

> 注意：`build.bat` 会自动递增版本号，因此**本地打包得到的版本**通常就是你要
> 打标签的那个版本号；打完标签后不要再本地打包，否则版本会继续 +1 而标签仍指向
> 旧版本。

---

## 项目结构

| 路径 | 作用 |
|---|---|
| `src/main/index.ts` | 生命周期：单实例、装配、托盘、更新对话框、IPC |
| `src/main/i18n.ts` | 外壳本地化目录（跟随系统语言） |
| `src/main/dsh-server.ts` | 生成并监管服务端子进程；解析就绪信号 |
| `src/main/window.ts` | `BrowserWindow`、token 握手、导航围栏、几何记忆 |
| `src/main/paths.ts` | 开发态与打包态的运行时 / 工具链解析 |
| `src/main/updater.ts` | registry 查询、版本化安装、联接切换、回退 |
| `src/main/credentials.ts` | 基于 `safeStorage` 的密封凭据存储 |
| `src/main/tray.ts` | 托盘菜单与关闭到托盘 |
| `src/preload/preload.ts` | 最小 `contextBridge` 暴露面 |
| `src/server/server.mjs` | 启动链，由子进程执行 |
| `scripts/build.mjs` | 打包编排（bat 只是瘦封装） |
| `scripts/version.mjs` | 版本号管理 |
| `scripts/stage-runtime.mjs` | 把 `@deepseek-ai/dsh` 装到 `runtime/` |
| `scripts/stage-node.mjs` | 下载并校验便携 Node（跨平台） |
| `scripts/link-runtime.mjs` | 开发期链接，使工程内可解析运行时 |
| `scripts/generate-icon.mjs` | 零依赖 PNG 图标生成器 |
| `build.bat` / `version.bat` | 一键打包 / 版本管理 |

### 诊断脚本

构建机辅助工具，不随包发布。它们存在是因为本 README 里的每条结论都是**验证过**的，而不是假设的：

| 脚本 | 用途 |
|---|---|
| `scripts/test-i18n.cjs` | 断言语言映射与中英键位对齐 |
| `scripts/probe-web.mjs` | 不启动 GUI，直接验证运行时能否服务 |
| `scripts/probe-ui.mjs` | 通过 CDP 读取真实 DOM 控件、点击、求值 |
| `scripts/probe-locale.cjs` | 打印 Electron 语言相关 API 的实际取值 |
| `scripts/probe-tray.cjs` | 验证托盘图标 PNG 可加载且 `Tray` 可构造 |
| `scripts/capture-window.cjs` | 截图窗口，用于验证布局结论 |

---

## 已知限制

- **Windows / macOS / Linux 三平台的构建配置都已就绪，但只在 Windows 上端到端验证过。** Linux 与 macOS 产物由 CI 生成，尚未在真机安装验证。
- **应用外壳自更新尚未在真机上端到端验证。** 代码路径已接线、元数据文件也已随 Release 发布，但要真正验证需要"发布新版本 → 旧版本自动升级"的完整往返，这需要两个真实发布版本。**已经修掉的一个前置障碍**：metadata 里的文件名必须与 Release 附件名逐字一致，此前因 `productName` 含空格而不一致（详见下文 productName 说明）。
- **`productName` 为 `dsh-desktop`，因此安装位置与可执行文件名不含空格。** 早期版本（v1.0.0）用的是 `DeepSeek Harness`，安装目录为 `%LOCALAPPDATA%\Programs\DeepSeek Harness\`；现在同一位置变成 `…\Programs\dsh-desktop\`。升级前请先卸载旧版本，否则会留下两个安装。改名是必需的：只有文件名里没有空格，electron-builder 生成的 metadata 与 GitHub 上的附件名才会逐字相同，自动更新才能找到下载文件。面向用户显示的名称（快捷方式、窗口标题）不受影响，仍是「DeepSeek Harness」。
- **运行时更新依赖 npm。** 应用内置了 npm（约 5 MB）并由 Electron 自带的 Node 驱动它。不自己实现 semver 解析与 peer 提升，是因为错误依赖树会产生"能启动但行为异常"的应用，风险不值得。
- **内置的 `desktop` profile 无法通过命令行定制。** `dsh --profile desktop` 被官方刻意拒绝；要定制请改 `$DSH_HOME/profiles/desktop/cordis.patch.yml`，运行时热重载。
- **右侧栏的状态仅存于内存。** 刷新后每个会话回到收起状态（官方行为）。
- **`stage:runtime` 默认跟随 `latest` 通道。** 镜像上 `latest` 可能比 `next` 旧，需要新版请显式指定 `npm run stage:runtime -- next`。
- **首次构建需要网络**，要下载 Electron、便携 Node 与 `@deepseek-ai/dsh`（合计约 700 MB），之后复用缓存。

---

## 故障排查

**弹窗提示 `Error launching app`，路径看起来像 JavaScript 源码。**
Electron 没有 `-e` 参数——那是 Node 的。执行 `npx electron -e "…"` 会让 Electron 把源码文本当成*应用路径*，加载失败后弹出该对话框。请改用脚本文件（`npx electron scripts/probe-*.cjs`）。该对话框是 Windows 原生消息框，**不随父进程退出而关闭**：杀掉父进程不会关掉它。

**开发运行立即退出、退出码 0、没有任何输出。**
单实例锁被已在运行的副本占用。每个用户数据目录只允许一个实例，而且 **`DSH_DESKTOP_HOME` 不会改变锁的作用域**——Electron 在我读取该覆盖变量之前就已从 `app.getPath('userData')` 推导出锁。关掉已安装的应用（或它的托盘图标）再试。

**打包报 `remove …\resources\app.asar: The process cannot access the file because it is being used by another process`。**
Windows Defender 或搜索索引服务在测试运行后仍持有刚写入的 asar。通常会自动释放；若没有，改用其它输出目录（`directories.output`），或等一会儿再删 `release/win-unpacked`。

**应用能打开但智能体运行时启动失败。**
`dsh-desktop` 把子进程非零退出视为启动失败，并显示子进程最后的输出。优先检查两件事：启动脚本是否与运行时的 `node_modules` 同级（见[运行时目录布局](#运行时目录布局)），以及内置 Node 是否过旧。

**`.bat` 文件里出现乱码或 `'xxx' is not recognized as an internal or external command`。**
`cmd.exe` 按字节读取 `.bat`，会把多字节 UTF-8 字符拆开当成命令。因此本项目的 `.bat` 文件**保持纯 ASCII**，所有中文输出都由 `scripts/*.mjs` 打印。修改 bat 时请遵守这一点。

---

## 许可证

MIT。

本项目打包了 MIT 许可的官方 DeepSeek Harness 运行时，上游项目：<https://github.com/deepseek-ai/deepseek-harness>
