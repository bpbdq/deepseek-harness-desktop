// 实测内置运行时的解包：耗时、文件数、校验和，并验证解出来的运行时能启动。
//
//   node scripts/test-unpack.mjs
//
// 这是本轮改动里最容易写错的一处（二进制归档的边界解析），所以单独可测；顺带量出耗时，
// 用来决定启动时要不要显示解包进度。
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRuntimeUnpacked, reusableUnpacked } from '../dist/main/runtime-unpack.js'

const ARCHIVE = join(process.cwd(), 'build', 'runtime.br')
if (!existsSync(ARCHIVE)) {
  console.error(`缺少归档 ${ARCHIVE}，先运行 node scripts/compress-runtime.mjs`)
  process.exit(1)
}

const archiveMb = statSync(ARCHIVE).size / 1048576
console.log(`归档: ${archiveMb.toFixed(1)} MB`)

const scratch = mkdtempSync(join(tmpdir(), 'dsh-unpack-'))
let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

try {
  // 1) 首次解包
  let lastPercent = -1
  const started = Date.now()
  const first = await ensureRuntimeUnpacked(ARCHIVE, scratch, (done, total) => {
    const percent = Math.floor((done / Math.max(total, 1)) * 100)
    if (percent !== lastPercent && percent % 20 === 0) lastPercent = percent
  })
  const seconds = (Date.now() - started) / 1000

  console.log('')
  console.log(`首次解包: ${seconds.toFixed(1)}s  文件 ${first.files} 个`)
  check('标记为已解包', first.unpacked, 'true')
  check('node 可执行文件存在', existsSync(join(first.dir, 'runtime', 'node', 'node.exe')), 'true')
  check(
    'dsh 锚点存在',
    existsSync(join(first.dir, 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')),
    'true',
  )
  check(
    '插件随包（gitbar）',
    existsSync(join(first.dir, 'runtime', 'node_modules', 'dsh-client-ui-gitbar', 'package.json')),
    'true',
  )

  // 2) 二次调用应复用，不再解包
  const againStarted = Date.now()
  const second = await ensureRuntimeUnpacked(ARCHIVE, scratch)
  const againSeconds = (Date.now() - againStarted) / 1000
  check('二次调用复用', second.unpacked, 'false')
  console.log(`二次调用: ${againSeconds.toFixed(2)}s（应远小于首次）`)
  check('复用确实很快', againSeconds < 2, 'true')
  check('reusableUnpacked 认可', reusableUnpacked(first.dir, ARCHIVE) !== undefined, 'true')

  // 3) 完整性：解出来的 node.exe 与非压缩源一致（抽查关键文件）
  const sourceNode = join(process.cwd(), 'runtime', 'node', 'node.exe')
  if (existsSync(sourceNode)) {
    const hash = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
    check('node.exe 内容一致', hash(join(first.dir, 'runtime', 'node', 'node.exe')), hash(sourceNode))
  }

  // 4) 解出来的运行时能真正启动
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync(join(first.dir, 'runtime', 'node', 'node.exe'), ['-e', 'console.log("node ok", process.version)'], {
    encoding: 'utf8',
    timeout: 30000,
  })
  check('解出的 node 可运行', out.trim().startsWith('node ok'), 'true')
  console.log(`       ${out.trim()}`)
} catch (error) {
  failures += 1
  console.error('测试异常:', String(error.message).slice(0, 400))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
