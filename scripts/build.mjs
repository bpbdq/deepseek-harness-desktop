// 打包编排。
//
//   node scripts/build.mjs win       Windows：setup.exe + .msi
//   node scripts/build.mjs msi       只打包 .msi
//   node scripts/build.mjs linux     Linux：AppImage + deb（需 Linux/WSL）
//   node scripts/build.mjs all       Windows + Linux
//   node scripts/build.mjs mac       macOS：dmg + zip（需 macOS）
//   node scripts/build.mjs clean     clean 后完整打包 Windows
//   node scripts/build.mjs help      完整用法
//
// 环境变量：
//   SKIP_STAGE=1     跳过运行时准备（已 stage 过，可省数分钟）
//   SKIP_INSTALL=1   跳过 npm install
//
// 编排逻辑放在 Node 而非批处理：cmd 按字节解析 .bat，会把多字节 UTF-8 字符
// 拆成非法命令。因此 .bat 只做转发。
//
// 各平台可构建性（已实测）：
//   Windows  setup.exe / .msi       本机可构建
//   Linux    AppImage / deb / rpm   需 Linux 版 mksquashfs 与 fpm，本机不可
//   macOS    dmg / zip              需 hdiutil / codesign，只在 macOS 上存在
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const RUNTIME_ANCHOR = join(ROOT, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

// npm 与 npx 的 CLI 入口。用 process.execPath + npm-cli.js 而不是 npm.cmd：
// Node 在 Windows 上拒绝用 execFileSync 直接 spawn .cmd/.bat（CVE-2024-27980 的
// 缓解措施），会抛 EINVAL；而改用 `shell: true` 又会触发 DEP0190 参数转义警告。
// 走 JS 入口两者都能避开，且跨平台一致。
const NPM_CLI = join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js')
const NPX_CLI = join(ROOT, 'node_modules', 'npm', 'bin', 'npx-cli.js')
const EB_CLI = join(ROOT, 'node_modules', 'electron-builder', 'cli.js')

/** 当前是否在 Windows 上运行。 */
const onWindows = process.platform === 'win32'

/**
 * 运行一条 node 命令，失败即抛出。
 * @param args - 传给 `node` 的完整参数，第一个是脚本路径。
 * @param label - 人类可读的步骤说明。
 */
function runNode(args, label) {
  console.log(`\n[build] ${label}`)
  execFileSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
}

/**
 * 运行 npm 子命令。
 *
 * 全新克隆时 `node_modules/npm` 还不存在（它就是被安装的东西），此时退回
 * shell 调用 npm.cmd —— bootstrap 这一步无法避免 shell。
 */
function runNpm(args, label) {
  if (existsSync(NPM_CLI)) {
    runNode([NPM_CLI, ...args], label)
    return
  }
  console.log(`\n[build] ${label}`)
  execFileSync(onWindows ? 'npm.cmd' : 'npm', args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...(onWindows ? { shell: true } : {}),
  })
}

/** 运行 electron-builder，优先用直接入口。 */
function runElectronBuilder(args, label) {
  if (existsSync(EB_CLI)) {
    runNode([EB_CLI, ...args], label)
    return
  }
  runNode([NPX_CLI, 'electron-builder', ...args], label)
}

/** 读取 package.json 的版本。 */
function version() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

/**
 * 打印产物大小，并写一个 `release/latest.txt` 指向最新版本目录。
 *
 * 产物按版本分目录存放（`release/<版本>/`），文件名里不带版本号；这里只扫当前
 * 版本目录，避免把历史版本的产物也列进来。
 */
function reportArtifacts() {
  const current = version()
  const versionDir = join(ROOT, 'release', current)
  if (!existsSync(versionDir)) return
  const wanted = /\.(exe|msi|AppImage|deb|rpm|dmg|zip|blockmap|yml)$/iu
  const files = readdirSync(versionDir).filter((name) => wanted.test(name))

  // latest.txt 让"最新版本是哪个"不用猜，脚本和用户都能直接看。
  try {
    writeFileSync(join(ROOT, 'release', 'latest.txt'), `${current}\n`, 'utf8')
  } catch {
    // 便利文件，写不了不影响产物。
  }

  if (files.length === 0) return

  console.log('\n[build] ------------------------------------------------------------')
  console.log(`[build]  产物  release/${current}/`)
  console.log('[build] ------------------------------------------------------------')
  for (const name of files) {
    const size = statSync(join(versionDir, name)).size
    const mb = (size / 1048576).toFixed(1).padStart(7)
    console.log(`[build] ${mb} MB   ${name}`)
  }
}

/** 说明为什么 macOS 包不能在这里构建。 */
function macExplanation() {
  console.log(`
[build] ============================================================
[build]  macOS 打包无法在 Windows/Linux 上完成
[build]
[build]  原因：electron-builder 需要 hdiutil / codesign / productbuild，
[build]        这三个工具只存在于 macOS。
[build]
[build]  两种正确做法：
[build]    1. 在 Mac 上执行  npm run dist:mac
[build]    2. 用仓库的 GitHub Actions 工作流
[build]       (.github/workflows/release.yml)，会自动用 macos runner
[build]       产出 x64 与 arm64 的 .dmg 与 .zip
[build]
[build]  签名与公证需要 Apple 开发者证书；未配置时产物未签名，
[build]  macOS 用户首次打开需右键 → 打开。
[build] ============================================================
`)
}

/**
 * 说明为什么 Linux 包不能在 Windows 上构建。
 *
 * 这是构建工具链缺失，已实测：
 *   AppImage -> 需要 Linux 版 mksquashfs
 *   deb/rpm  -> 需要 fpm
 * 二者都是 Linux 可执行文件，Windows 上无法运行。
 */
function linuxExplanation() {
  console.log(`
[build] ============================================================
[build]  Linux 打包无法在 Windows 上完成
[build]
[build]  原因（已实测，非配置问题）：
[build]    AppImage -> 需要 Linux 版 mksquashfs
[build]                报错: appimage-12.0.1/linux-x64/mksquashfs: file does not exist
[build]    deb/rpm  -> 需要 fpm
[build]                报错: fpm: executable file not found in %PATH%
[build]    二者都是 Linux 可执行文件。
[build]
[build]  三种正确做法：
[build]    1. 用 GitHub Actions 的 ubuntu runner（推荐，见
[build]       .github/workflows/release.yml，会产出 AppImage + deb + rpm）
[build]    2. 在任意 Linux 机器上执行  npm run dist:linux
[build]    3. 在 WSL 里执行  npm run dist:linux
[build] ============================================================
`)
}

/** 完整用法。 */
function help() {
  console.log(`
DeepSeek Harness 桌面版 —— 打包

  build.bat                 打包 Windows（默认只出 setup.exe）
  build.bat win             同上
  build.bat msi             额外打包 .msi（慢，见下）
  build.bat linux           显示 Linux 打包说明（Windows 上无法执行）
  build.bat all             同 win（非 Windows 目标需 CI 或对应平台）
  build.bat mac             显示 macOS 打包说明
  build.bat clean           清理 dist 与 release/<当前版本> 后完整打包 Windows
  build.bat help            显示本说明

关于 MSI：运行时树约 25000 个文件，WiX 的 light 链接器要把每个文件编入数据库，
实测需要十几分钟（I/O 受限）。因此默认打包不包含它；企业批量部署需要时再
单独执行 build.bat msi。CI 里 MSI 也是独立一步。

环境变量：
  SKIP_STAGE=1              跳过运行时准备（已 stage 过，可省数分钟）
  SKIP_INSTALL=1            跳过 npm install

版本管理：
  version.bat               显示当前版本与下一个版本
  version.bat next          递增（1.0.0→1.0.1→…→1.0.9→1.1.0）
  version.bat list          列出发布序列
  version.bat 1.0.3         显式设置

各平台可构建性：
  Windows  setup.exe / .msi        可本机构建
  Linux    AppImage / deb / rpm    需 Linux 或 CI
  macOS    dmg / zip               需 macOS 或 CI

产物在 release\<版本>\ 目录下（每个版本一个目录，文件名里不带版本号）。
首次打包会下载 Electron、便携 Node 与 @deepseek-ai/dsh（约 700 MB），
需要网络；之后会复用缓存。
`)
}

const targets = {
  win: { label: 'Windows：NSIS setup.exe + MSI', args: ['--win', '--x64'] },
  msi: { label: 'Windows：仅 MSI', args: ['--win', 'msi', '--x64'] },
  linux: { label: 'Linux：AppImage + deb', args: ['--linux', '--x64'] },
  mac: { label: 'macOS：dmg + zip', args: ['--mac'] },
  all: { label: 'Windows + Linux', args: ['--win', '--linux', '--x64'] },
}

let target = (process.argv[2] ?? 'win').toLowerCase()

if (target === 'help' || target === '--help' || target === '-h') {
  help()
  process.exit(0)
}

if (target === 'clean') {
  // 只清当前版本目录，不碰 release/ 整体：产物按版本归档，整目录删除会把
  // 历史版本的安装包一起抹掉，那正是分目录要避免的事。
  const current = version()
  console.log(`[build] 清理 dist 与 release/${current} ...`)
  rmSync(join(ROOT, 'dist'), { recursive: true, force: true })
  rmSync(join(ROOT, 'release', current), { recursive: true, force: true })
  target = 'win'
}

const chosen = targets[target]
if (chosen === undefined) {
  console.error(`[build] 未知目标: ${target}`)
  console.error('[build] 可用: win | msi | linux | all | mac | clean | help')
  process.exit(1)
}

// 平台守卫：在 Windows 上构建 Linux/macOS 目标必然失败，而且是在下载几百 MB
// 之后才失败。提前拦住并给出可操作的方案，比让它跑一半崩掉有用。
// 判据是 electron-builder 的参数（`all` 会带上 --linux），而不是目标名。
const buildsForeignPlatform = chosen.args.includes('--linux') || chosen.args.includes('--mac')
if (onWindows && buildsForeignPlatform) {
  console.log(`[build] 版本: ${version()}`)
  console.log(`[build] 目标: ${target} —— 包含非 Windows 平台，本机无法构建`)
  if (chosen.args.includes('--mac')) macExplanation()
  else linuxExplanation()
  process.exit(1)
}

console.log(`[build] 版本: ${version()}`)
console.log(`[build] 目标: ${target}`)
console.log(`[build] Node: ${process.version}`)

// 依赖：全新克隆时需要先装。
if (process.env.SKIP_INSTALL !== '1' && !existsSync(join(ROOT, 'node_modules'))) {
  runNpm(['install'], '安装依赖（首次较慢）')
}

runNpm(['run', 'build'], '编译 TypeScript')

// 运行时：内置的 dsh 树 + 固定版本 Node。约 2-5 分钟，可跳过。
if (process.env.SKIP_STAGE !== '1') {
  runNpm(['run', 'stage'], '准备内置运行时（约 2-5 分钟）')
} else if (!existsSync(RUNTIME_ANCHOR)) {
  console.error('[build] 错误: runtime 尚未准备。请先不带 SKIP_STAGE 运行一次。')
  process.exit(1)
} else {
  console.log('[build] 跳过运行时准备 (SKIP_STAGE=1)')
}

runElectronBuilder(chosen.args, `打包 ${chosen.label}`)
reportArtifacts()
console.log(`\n[build] 完成。产物目录: release/${version()}/`)
