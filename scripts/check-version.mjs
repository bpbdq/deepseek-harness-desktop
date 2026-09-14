// 打印各处的版本号，确认三者一致。
//
//   node scripts/check-version.mjs
//
// package.json 与 package-lock.json 不一致时，CI 的 `npm ci` 会抱怨甚至拒绝执行，
// 所以这个一致性值得一条命令就能看清。
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))

const rows = [
  ['package.json              ', manifest.version],
  ['package-lock.json         ', lock.version],
  ['package-lock packages[""] ', lock.packages?.['']?.version],
]

for (const [label, value] of rows) console.log(`  ${label} : ${value}`)

const values = new Set(rows.map(([, value]) => value))
if (values.size === 1) {
  console.log(`\n一致：${manifest.version}`)
  process.exit(0)
}
console.error('\n不一致！npm ci 可能失败。')
process.exit(1)
