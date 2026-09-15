// 激进瘦身后实测压缩体积——用来判定"30MB 以内"是否可达，以及必须放弃什么。
//
//   node scripts/measure-aggressive.mjs
//
// 相比上一版多剔除的东西（都是运行期确实用不到的）：
//   * .pdb 调试符号（node-pty 的 conpty 符号就有 ~10MB，纯调试用途）
//   * 测试夹具（例如 domino 的 html5lib-tests.json 2.2MB）
//   * 非 win32-x64 的二进制（含 node-pty 的 arm64 OpenConsole）
//   * LICENSE/CHANGELOG 等文本
// 输出 .pruned2/ 供检查，不修改原 runtime。
import { cpSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createBrotliCompress, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const SOURCE = 'runtime'
const TARGET = '.pruned2'

/** 按文件名剔除。 */
const DROP_FILE = [
  /\.map$/u,
  /\.d\.ts$/u,
  /\.d\.mts$/u,
  /\.ts$/u,
  /\.mts$/u,
  /\.md$/u,
  /\.markdown$/u,
  /\.flow$/u,
  // 调试符号：运行期完全用不到。
  /\.pdb$/u,
  /\.ilk$/u,
  /\.exp$/u,
  /\.lib$/u,
  // 许可证与变更日志：体积不小且每个包都带一份。
  /^LICENSE$/iu,
  /^LICENCE$/iu,
  /^LICENSE\.(txt|md)$/iu,
  /^CHANGELOG(\..*)?$/iu,
  /^HISTORY(\..*)?$/iu,
  /^AUTHORS(\..*)?$/iu,
  // 测试与示例目录里的常见单文件夹具。
  /^html5lib-tests\.json$/u,
]

/** 按路径片段剔除整个目录。 */
const DROP_DIR = [
  `${join('node', 'node_modules')}`,
  'win32-arm64',
  'darwin',
  'linux-x64',
  'linux-arm64',
  'linux-arm',
  `${join('third_party', 'conpty', '1.25.260303002', 'win10-arm64')}`,
]

/** 统计目录大小。 */
function statDir(root) {
  let bytes = 0
  let files = 0
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        bytes += statSync(path).size
        files += 1
      }
    }
  }
  walk(root)
  return { bytes, files }
}

rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })

let removedBytes = 0
let removedFiles = 0
let keptBytes = 0
let keptFiles = 0

function copyPruned(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const sourcePath = join(from, entry.name)
    const targetPath = join(to, entry.name)
    if (entry.isDirectory()) {
      if (DROP_DIR.some((fragment) => sourcePath.endsWith(fragment))) {
        const stats = statDir(sourcePath)
        removedBytes += stats.bytes
        removedFiles += stats.files
        continue
      }
      copyPruned(sourcePath, targetPath)
      continue
    }
    if (!entry.isFile()) continue
    const size = statSync(sourcePath).size
    if (DROP_FILE.some((pattern) => pattern.test(entry.name))) {
      removedBytes += size
      removedFiles += 1
      continue
    }
    cpSync(sourcePath, targetPath)
    keptBytes += size
    keptFiles += 1
  }
}

copyPruned(SOURCE, TARGET)

console.log(`剔除: ${(removedBytes / 1048576).toFixed(1)} MB / ${removedFiles} 个文件`)
console.log(`保留: ${(keptBytes / 1048576).toFixed(1)} MB / ${keptFiles} 个文件`)
console.log('')

const tarPath = join(process.cwd(), '.aggr.tar')
const outPath = join(process.cwd(), '.aggr.br')
execFileSync('tar', ['-cf', tarPath, '-C', TARGET, '.'], { stdio: 'ignore' })
const tarSize = statSync(tarPath).size
const started = Date.now()
await pipeline(
  createReadStream(tarPath),
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: tarSize,
    },
  }),
  createWriteStream(outPath),
)
console.log(`tar: ${(tarSize / 1048576).toFixed(1)} MB`)
console.log(`brotli q11: ${(statSync(outPath).size / 1048576).toFixed(1)} MB  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
rmSync(tarPath, { force: true })
rmSync(outPath, { force: true })
