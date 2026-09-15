// 实测 zstd 各压缩级别在运行时分发包上的体积与耗时，与 brotli q11 对比。
//
//   node scripts/measure-codecs.mjs [目录]
//
// brotli q11 压得最小但单线程、188MB 要 10 分钟；zstd 支持高压缩级别，需要实测才知道
// 用哪个更划算——这直接影响构建时长与安装包体积。
import { createReadStream, createWriteStream, rmSync, statSync } from 'node:fs'
import { createBrotliCompress, createZstdCompress, constants } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const dir = process.argv[2] ?? '.pruned2'
const tarPath = join(process.cwd(), '.codecs.tar')
execFileSync('tar', ['-cf', tarPath, '-C', dir, '.'], { stdio: 'ignore' })
const tarSize = statSync(tarPath).size
console.log(`源: ${dir}   tar: ${(tarSize / 1048576).toFixed(1)} MB`)
console.log('')

/**
 * 压一次并报告体积与耗时。
 * @param label - 展示名。
 * @param make - 返回压缩流。
 */
async function measure(label, make) {
  const out = join(process.cwd(), '.codecs.out')
  rmSync(out, { force: true })
  const started = Date.now()
  await pipeline(createReadStream(tarPath), make(), createWriteStream(out))
  console.log(
    `${label.padEnd(20)} ${(statSync(out).size / 1048576).toFixed(1).padStart(5)} MB   ${((Date.now() - started) / 1000).toFixed(1)}s`,
  )
  rmSync(out, { force: true })
}

for (const level of [15, 19, 22]) {
  try {
    await measure(`zstd level ${level}`, () => createZstdCompress({ level }))
  } catch (error) {
    console.log(`zstd level ${level}: 失败 ${String(error.message).slice(0, 70)}`)
  }
}

await measure('brotli q11', () =>
  createBrotliCompress({
    params: {
      [constants.BROTLI_PARAM_QUALITY]: 11,
      [constants.BROTLI_PARAM_LGWIN]: 24,
      [constants.BROTLI_PARAM_SIZE_HINT]: tarSize,
    },
  }),
)

rmSync(tarPath, { force: true })
