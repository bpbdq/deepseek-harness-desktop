// 测量"瘦身后的运行时"压缩后有多大——决定 30MB 目标是否可达。
//
//   node scripts/measure-pruned.mjs
//
// 背景：runtime 原始 314MB，gzip 后 86MB，远超目标。但其中大量文件在运行期用不到：
//   * .ts 源文件（dsh 只跑 .js）
//   * .map source map
//   * .d.ts 类型声明
//   * .md 文档
//   * 非当前平台的预编译二进制
//   * Node 自带的 npm（外壳自带一份 npm 用于更新，Node 里那份用不到）
// 先删再压，才能看出真实下限。
//
// 输出一份瘦身副本到 .pruned/，不修改原 runtime。
import { cpSync, createReadStream, createWriteStream, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const SOURCE = 'runtime'
const TARGET = '.pruned'

/** 该删除的文件（运行期用不到）。 */
const DROP_FILE = [/\.map$/u, /\.d\.ts$/u, /\.d\.mts$/u, /\.ts$/u, /\.mts$/u, /\.md$/u, /\.markdown$/u, /\.flow$/u]

/** 该删除的目录（按路径片段匹配）。 */
const DROP_DIR = [
  // Node 分发自带的 npm 与 corepack：外壳用自己那份 npm 做更新，这里用不到。
  `${join('node', 'node_modules')}`,
  // 非 win32-x64 的预编译二进制：本平台用不到。
  'win32-arm64',
  'darwin',
  'linux-x64',
  'linux-arm64',
  'linux-arm',
]

/** 统计。 */
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

console.log('复制并瘦身 …')
rmSync(TARGET, { recursive: true, force: true })
mkdirSync(TARGET, { recursive: true })

let removedBytes = 0
let removedFiles = 0
let keptBytes = 0
let keptFiles = 0

/** 递归复制，按规则跳过。 */
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

console.log('')
console.log(`剔除: ${(removedBytes / 1048576).toFixed(1)} MB / ${removedFiles} 个文件`)
console.log(`保留: ${(keptBytes / 1048576).toFixed(1)} MB / ${keptFiles} 个文件`)
console.log('')

/** 压缩整个目录并报告大小。 */
async function measure(label, makeCompressor) {
  const tarPath = join(process.cwd(), '.pruned-measure.tar')
  const outPath = join(process.cwd(), '.pruned-measure.out')
  rmSync(tarPath, { force: true })
  rmSync(outPath, { force: true })
  execFileSync('tar', ['-cf', tarPath, '-C', TARGET, '.'], { stdio: 'ignore' })
  const tarSize = statSync(tarPath).size
  const started = Date.now()
  await pipeline(createReadStream(tarPath), makeCompressor(), createWriteStream(outPath))
  const outSize = statSync(outPath).size
  console.log(`${label}`)
  console.log(`  tar ${(tarSize / 1048576).toFixed(1)} MB -> ${(outSize / 1048576).toFixed(1)} MB  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  rmSync(tarPath, { force: true })
  rmSync(outPath, { force: true })
  return outSize
}

await measure('gzip -9', () => createGzip({ level: 9 }))
await measure('brotli q11', () =>
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: keptBytes,
    },
  }),
)
