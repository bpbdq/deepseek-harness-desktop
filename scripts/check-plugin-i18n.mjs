// 检查插件客户端里是否还有面向用户的硬编码文案（注释与字典本身除外）。
//
//   node scripts/check-plugin-i18n.mjs [文件路径]
//
// 存在的理由：本地化最容易漏掉一两处，而漏掉的那处在英文界面下就会突然冒出中文，
// 很难在代码评审里看出来。这个脚本把"有没有漏"变成可自动检查的结论。
import { readFileSync } from 'node:fs'

const file = process.argv[2] ?? 'plugins/dsh-client-ui-gitbar/lib/client.js'
const lines = readFileSync(file, 'utf8').split('\n')

/** 字典定义所在区间：这两块里的中文是数据，不是硬编码文案。 */
const dictionaryBlocks = []
let inDict = false
lines.forEach((line, index) => {
  if (/^\s*const (zh|en) = \{/u.test(line)) inDict = true
  else if (inDict && /^\s*\}/u.test(line)) {
    dictionaryBlocks.push(index)
    inDict = false
  }
})

/** 判断某行是否落在字典块内。 */
function inDictionary(lineIndex) {
  // 字典从 `const zh/en = {` 到独占一行的 `}`。收集起止后做区间判断。
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*const (zh|en) = \{/u.test(lines[i])) continue
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*\}/u.test(lines[j])) {
        if (lineIndex >= i && lineIndex <= j) return true
        break
      }
    }
  }
  return false
}

const HAN = /[\u4e00-\u9fff]/u
const findings = []

lines.forEach((line, index) => {
  const trimmed = line.trim()
  // 注释里的中文是说明，不是界面文案。
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
  if (inDictionary(index)) return
  if (!HAN.test(line)) return
  findings.push({ line: index + 1, text: trimmed.slice(0, 100) })
})

console.log(`检查 ${file}`)
if (findings.length === 0) {
  console.log('  没有面向用户的硬编码中文文案')
  process.exit(0)
}
console.log(`  发现 ${findings.length} 处可疑文案：`)
for (const item of findings) console.log(`    L${item.line}: ${item.text}`)
process.exit(1)
