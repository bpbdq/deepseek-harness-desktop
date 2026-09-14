// 找出官方 bundle patch 里"新增插件"（用 name 而非覆盖 config）的写法。
//
//   node scripts/inspect-patch.mjs <bundle 包名> [关键字]
//
// 背景：`dsh.bundle.patch` 指向的 patch 文件里，行有两大类——用 `id` 覆盖既有行的
// config，或用 `name` 挂一个新插件。我自己写的 patch 只用了 `name`，却静默无效，
// 所以需要从官方 patch 里找可用的样例，而不是继续猜格式。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = process.argv[2] ?? '@deepseek-ai/dsh-base'
const keyword = process.argv[3]

const runtime = join(process.cwd(), 'runtime', 'node_modules')
const path = join(runtime, ...pkg.split('/'), 'cordis.patch.yml')
const text = readFileSync(path, 'utf8')
const lines = text.split('\n')

console.log(`=== ${pkg}/cordis.patch.yml（${lines.length} 行）===`)

/** 收集所有顶层行块：以 `- ` 开头，直到下一个 `- ` 或文件结束。 */
const blocks = []
let current = null
for (const line of lines) {
  if (/^- /u.test(line)) {
    if (current !== null) blocks.push(current)
    current = [line]
  } else if (current !== null) {
    current.push(line)
  }
}
if (current !== null) blocks.push(current)

console.log(`顶层行块数: ${blocks.length}`)

/** 每块用的键（id / name / config / …）。 */
const keysOf = (block) =>
  block
    .slice(1)
    .filter((line) => /^\s{2}[a-zA-Z]/u.test(line))
    .map((line) => line.trim().split(':')[0])

const withName = blocks.filter((block) => keysOf(block).includes('name'))
const withId = blocks.filter((block) => keysOf(block).includes('id'))
console.log(`  含 id 的块: ${withId.length}`)
console.log(`  含 name 的块: ${withName.length}`)
console.log('')
console.log('含 name 的块（最多 5 个）:')
for (const block of withName.slice(0, 5)) {
  console.log('---')
  for (const line of block) console.log(line)
}

if (keyword !== undefined) {
  console.log('')
  console.log(`=== 含关键字 "${keyword}" 的块 ===`)
  for (const block of blocks) {
    if (block.join('\n').includes(keyword)) {
      console.log('---')
      for (const line of block) console.log(line)
    }
  }
}
