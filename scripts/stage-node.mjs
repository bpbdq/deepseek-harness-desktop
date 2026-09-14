// 构建机辅助脚本：把便携版 Node 下载到 runtime/node/。
//
// 为什么要在 Electron 之外再内置一份 Node？
//
//   Electron 33 自带 Node 20，而 dsh 运行时调用了 Node 22.13+/24 才有的 API：
//     node:zlib.createZstdCompress      会话日志的 zstd 帧
//     node:util.getSystemErrorMessage   子进程错误映射
//     node:module.stripTypeScriptTypes  code-runtime worker
//
// 固定一份已知可用的 Node 也让智能体运行时与 Electron 的发布节奏解耦：
// Electron 升级不会突然弄坏 harness，新版 harness 也能自由要求更新的 Node。
//
// 用法：
//   node scripts/stage-node.mjs                        当前平台的 Node
//   node scripts/stage-node.mjs darwin arm64           指定平台与架构（交叉准备）
//   node scripts/stage-node.mjs linux x64
//
// 环境变量：
//   DSH_NODE_VERSION   默认 v24.17.0
//   DSH_NODE_MIRROR    覆盖镜像源；默认官方 nodejs.org
//
// 下载源的选择是有意为之的：**官方源优先**。GitHub Actions runner 在海外，
// nodejs.org 又快又稳；而国内镜像在 runner 上会很慢甚至超时，然后才回退，
// 白白浪费几分钟再失败。国内构建机想用镜像请显式设置 DSH_NODE_MIRROR。
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'runtime', 'node')
const VERSION = process.env.DSH_NODE_VERSION ?? 'v24.17.0'
const OFFICIAL = 'https://nodejs.org/dist'
const MIRROR = process.env.DSH_NODE_MIRROR ?? OFFICIAL

/** 单个 HTTP 请求的超时（毫秒）。没有它，一个卡住的连接会静默耗掉几分钟。 */
const FETCH_TIMEOUT_MS = Number(process.env.DSH_FETCH_TIMEOUT_MS ?? 120_000)

const platform = process.argv[2] ?? process.platform
const arch = process.argv[3] ?? process.arch

/** 可执行文件在该平台发行包里的相对路径。 */
const NODE_BINARIES = {
  win32: 'node.exe',
  darwin: 'bin/node',
  linux: 'bin/node',
}

/** Node 官方发行包的扩展名：Windows 用 zip，macOS/Linux 用 tar。 */
const ARCHIVE_EXTENSIONS = {
  win32: 'zip',
  darwin: 'tar.gz',
  linux: 'tar.xz',
}

/**
 * Node 官方发行包文件名里的平台标识。
 *
 * 注意 **不是** Node 自己的 `process.platform`：Windows 在那里叫 `win32`，
 * 但在发行包文件名里是 `win`。拼错过一次，后果是三个平台全部 404：
 *   node-v24.17.0-win-x64.zip    正确
 *   node-v24.17.0-win32-x64.zip  错误
 * 而 `alreadyStaged()` 只看版本号，所以本机装过一次后这个错会被静默掩盖。
 */
const ARCHIVE_PLATFORMS = {
  win32: 'win',
  darwin: 'darwin',
  linux: 'linux',
}

const binaryRelative = NODE_BINARIES[platform]
const extension = ARCHIVE_EXTENSIONS[platform]
const archivePlatform = ARCHIVE_PLATFORMS[platform]

/**
 * 自检模式：只打印解析出的文件名并校验，不下载任何东西。
 *
 *   node scripts/stage-node.mjs --names
 *
 * 存在的理由：归档名拼错时，本机只要装过一次 `alreadyStaged()` 就会短路成功，
 * 错误被完全掩盖，只有 CI 上（干净 checkout）才暴露。这个自检让命名可以在本地
 * 零成本验证。
 */
if (process.argv.includes('--names')) {
  console.log(`Node ${VERSION} 归档名解析自检：`)
  const checks = [
    ['win32', 'x64', 'win-x64.zip'],
    ['darwin', 'x64', 'darwin-x64.tar.gz'],
    ['darwin', 'arm64', 'darwin-arm64.tar.gz'],
    ['linux', 'x64', 'linux-x64.tar.xz'],
  ]
  let ok = true
  for (const [p, a, suffix] of checks) {
    const name = `node-${VERSION}-${ARCHIVE_PLATFORMS[p]}-${a}.${ARCHIVE_EXTENSIONS[p]}`
    const expected = `node-${VERSION}-${suffix}`
    const pass = name === expected
    if (!pass) ok = false
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${p}-${a}  ->  ${name}${pass ? '' : `  (expected ${expected})`}`)
  }
  process.exit(ok ? 0 : 1)
}

if (binaryRelative === undefined || extension === undefined || archivePlatform === undefined) {
  console.error(`[stage-node] 不支持的平台: ${platform}（可用: win32 / darwin / linux）`)
  process.exit(1)
}

const ARCHIVE_NAME = `node-${VERSION}-${archivePlatform}-${arch}.${extension}`
const EXTRACTED_DIR = `node-${VERSION}-${archivePlatform}-${arch}`

/**
 * 本机已装的 Node 是否正好是这个版本。
 *
 * 只在「为本机平台准备」时才做这个短路：交叉准备（例如在 macOS 上为 linux
 * 准备）必然要重新下载，因为架构不同。
 */
function alreadyStaged() {
  if (platform !== process.platform) return false
  const binary = join(OUT_DIR, binaryRelative)
  if (!existsSync(binary)) return false
  try {
    const current = execFileSync(binary, ['-p', 'process.versions.node'], { encoding: 'utf8' }).trim()
    return `v${current}` === VERSION
  } catch {
    return false
  }
}

if (alreadyStaged()) {
  console.log(`[stage-node] runtime/node 已提供 Node ${VERSION}，跳过`)
  process.exit(0)
}

/** 流式下载，避免 30MB 包整体进内存。超时由 AbortSignal 强制，不会静默挂住。 */
async function download(url, destination) {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  if (response.body === null) throw new Error(`empty body for ${url}`)
  await pipeline(response.body, createWriteStream(destination))
}

/**
 * 用 Node 官方发布的 SHASUMS256.txt 校验下载。
 *
 * 校验和元数据始终优先从官方站点取（即使二进制来自镜像），这样被篡改的镜像
 * 无法同时替换文件和它们的校验值。
 * @returns 计算出的摘要；取不到校验和清单时返回 undefined。
 */
async function verify(archive) {
  let expected
  // 官方源优先：runner 上它比镜像快，而镜像通常不发 SHASUMS256.txt。
  for (const host of [OFFICIAL, MIRROR]) {
    try {
      const response = await fetch(`${host}/SHASUMS256.txt`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) continue
      const line = (await response.text())
        .split('\n')
        .find((entry) => entry.trim().endsWith(`  ${ARCHIVE_NAME}`))
      if (line === undefined) continue
      expected = line.trim().split(/\s+/u)[0]
      break
    } catch {
      // 换下一个源
    }
  }
  if (expected === undefined) return undefined

  const actual = createHash('sha256').update(await readFile(archive)).digest('hex')
  if (expected !== actual) {
    throw new Error(`${ARCHIVE_NAME} 校验和不匹配\n  期望 ${expected}\n  实际 ${actual}`)
  }
  return actual
}

mkdirSync(join(ROOT, 'runtime'), { recursive: true })
const archivePath = join(ROOT, 'runtime', ARCHIVE_NAME)

// 官方源优先，镜像作为回退。两者相同时只试一次。
const sources = MIRROR === OFFICIAL ? [OFFICIAL] : [OFFICIAL, MIRROR]
let downloadedFrom
const failures = []
for (const source of sources) {
  try {
    console.log(`[stage-node] 下载 Node ${VERSION} (${platform}-${arch}) <- ${source}`)
    await download(`${source}/${VERSION}/${ARCHIVE_NAME}`, archivePath)
    downloadedFrom = source
    break
  } catch (error) {
    failures.push(`${source}: ${error.message}`)
    console.warn(`[stage-node] 该源失败: ${error.message}`)
  }
}
if (downloadedFrom === undefined) {
  console.error(`[stage-node] 所有下载源均失败:\n  ${failures.join('\n  ')}`)
  process.exit(1)
}

const digest = await verify(archivePath)
if (digest === undefined) {
  console.warn('[stage-node] 警告: 取不到 SHASUMS256.txt，校验和未验证')
} else {
  console.log(`[stage-node] sha256 校验通过 ${digest}`)
}

// 解包到 staging 再展平到 runtime/node/，让打包后的布局稳定为
// runtime/node/<binary>。
const staging = join(ROOT, 'runtime', '.node-staging')
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })

if (platform === 'win32') {
  // 用 .NET 的 ZipFile 而非 Expand-Archive：后者在部分环境下会静默失败，
  // 只解出第一个文件就退出。
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath}','${staging}')`,
    ],
    { stdio: 'inherit' },
  )
} else {
  // tar 在 macOS 与 Linux 上都有；扩展名由 tar 依据内容自动识别。
  execFileSync('tar', ['-xf', archivePath, '-C', staging], { stdio: 'inherit' })
}

const inner = join(staging, EXTRACTED_DIR)
if (!existsSync(inner)) {
  throw new Error(`解包后未找到 ${EXTRACTED_DIR}，下载包可能不完整`)
}

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(OUT_DIR, { recursive: true })
for (const entry of readdirSync(inner)) {
  renameSync(join(inner, entry), join(OUT_DIR, entry))
}
rmSync(staging, { recursive: true, force: true })
rmSync(archivePath, { force: true })

const installedBinary = join(OUT_DIR, binaryRelative)
if (platform !== 'win32') {
  // tar 通常保留权限，这里再确认一次：少了可执行位，打进的 .dmg/AppImage
  // 在目标机器上会直接启动失败。
  execFileSync('chmod', ['+x', installedBinary], { stdio: 'inherit' })
}

writeFileSync(
  join(OUT_DIR, 'node-runtime.json'),
  JSON.stringify(
    { version: VERSION, platform, arch, source: downloadedFrom, downloadedAt: new Date().toISOString() },
    null,
    2,
  ) + '\n',
)
console.log(`[stage-node] 已内置 Node ${VERSION} -> runtime/node/${basename(binaryRelative)}`)
