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
//   DSH_NODE_MIRROR    默认 npmmirror
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'runtime', 'node')
const VERSION = process.env.DSH_NODE_VERSION ?? 'v24.17.0'
const MIRROR = process.env.DSH_NODE_MIRROR ?? 'https://registry.npmmirror.com/-/binary/node'
const OFFICIAL = 'https://nodejs.org/dist'

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

const binaryRelative = NODE_BINARIES[platform]
const extension = ARCHIVE_EXTENSIONS[platform]
if (binaryRelative === undefined || extension === undefined) {
  console.error(`[stage-node] 不支持的平台: ${platform}（可用: win32 / darwin / linux）`)
  process.exit(1)
}

const ARCHIVE_NAME = `node-${VERSION}-${platform}-${arch}.${extension}`
const EXTRACTED_DIR = `node-${VERSION}-${platform}-${arch}`

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

/** 流式下载，避免 30MB 包整体进内存。 */
async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  if (response.body === null) throw new Error(`empty body for ${url}`)
  await pipeline(response.body, createWriteStream(destination))
}

/**
 * 用 Node 官方发布的 SHASUMS256.txt 校验下载。
 *
 * 校验和元数据始终从官方站点取（即使二进制来自镜像），这样被篡改的镜像
 * 无法同时替换文件和它们的校验值。
 * @returns 计算出的摘要；取不到校验和清单时返回 undefined。
 */
async function verify(archive, binarySource) {
  let expected
  for (const host of [OFFICIAL, binarySource]) {
    try {
      const response = await fetch(`${host}/SHASUMS256.txt`)
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

let source = MIRROR
try {
  console.log(`[stage-node] 下载 Node ${VERSION} (${platform}-${arch}) <- ${source}`)
  await download(`${source}/${VERSION}/${ARCHIVE_NAME}`, archivePath)
} catch (error) {
  console.warn(`[stage-node] 镜像失败 (${error.message})，改用官方源 ${OFFICIAL}`)
  source = OFFICIAL
  await download(`${source}/${VERSION}/${ARCHIVE_NAME}`, archivePath)
}

const digest = await verify(archivePath, source)
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
  JSON.stringify({ version: VERSION, platform, arch, source, downloadedAt: new Date().toISOString() }, null, 2) + '\n',
)
console.log(`[stage-node] 已内置 Node ${VERSION} -> runtime/node/${basename(binaryRelative)}`)
