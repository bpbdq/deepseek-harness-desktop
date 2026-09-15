// 测量 runtime 目录用不同算法压缩后的大小，用来判断"30MB 以内"是否可达。
//
//   node scripts/measure-compression.mjs [目录]
//
// 为什么要先量：体积目标决定了架构选择。如果压完仍是 80MB，那换外壳（Rust/Tauri）
// 才有意义；如果压完只有 20MB，那么"压缩运行时 + 首次启动解压"就能达标，不必换技术栈。
import { createReadStream, createWriteStream, readdirSync, rmSync, statSync } from 'node:fs'
import { createBrotliCompress, createGzip, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const dir = process.argv[2] ?? 'runtime'

/** 统计目录的原始大小与文件数。 */
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

const raw = statDir(dir)
console.log(`源目录: ${dir}`)
console.log(`  原始: ${(raw.bytes / 1048576).toFixed(1)} MB / ${raw.files} 个文件`)
console.log('')

/**
 * 用指定方式压缩整个目录树（先打成 tar 再压，模拟真实分发形态）。
 * @param label - 展示名。
 * @param makeCompressor - 返回一个 Transform 流。
 */
async function measure(label, makeCompressor) {
  const tarPath = join(process.cwd(), '.measure.tar')
  const outPath = join(process.cwd(), '.measure.out')
  rmSync(tarPath, { force: true })
  rmSync(outPath, { force: true })

  // 用系统 tar 打包（不落中间态到内存，几万个文件这样最省事）。
  execFileSync('tar', ['-cf', tarPath, '-C', dir, '.'], { stdio: 'ignore' })
  const tarSize = statSync(tarPath).size

  const started = Date.now()
  await pipeline(createReadStream(tarPath), makeCompressor(), createWriteStream(outPath))
  const outSize = statSync(outPath).size
  const seconds = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`${label}`)
  console.log(`  tar: ${(tarSize / 1048576).toFixed(1)} MB  ->  压缩后: ${(outSize / 1048576).toFixed(1)} MB  (${seconds}s)`)
  console.log(`  相对原始: ${((outSize / raw.bytes) * 100).toFixed(1)}%`)

  rmSync(tarPath, { force: true })
  rmSync(outPath, { force: true })
  return outSize
}

try {
  await measure('gzip -9', () => createGzip({ level: 9 }))
  await measure('brotli 默认(11)', () =>
    createBrotliCompress({
      params: {
        [constants.BROTLI_PARAM_QUALITY]: 11,
        [constants.BROTLI_PARAM_LGWIN]: 24,
        [constants.BROTLI_PARAM_SIZE_HINT]: raw.bytes,
      },
    }),
  )
} catch (error) {
  console.error('测量失败:', String(error.message).slice(0, 300))
}
