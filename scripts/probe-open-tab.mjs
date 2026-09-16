// 找出官方右侧栏"打开标签页"的调用范例与签名。
//
//   node scripts/probe-open-tab.mjs
//
// 上一个探查确认了 sidebar-right 暴露了 openTab / openContent / openResourceIn 等动作，
// 但要知道**怎么调用**，就得找现成的调用点。文档预览与交付物列表都会打开右侧栏，
// 它们就是范例——照着调用比猜契约可靠。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'runtime', 'node_modules', '@deepseek-ai')
const NEEDLE = /(openTab|openContent|openResourceIn|openTabIn|openRightbar)\s*\(/gu

/** 递归收集所有客户端代码文件。 */
function collect(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) files.push(...collect(path))
    else if (entry === 'client.js' || entry === 'index.js') files.push(path)
  }
  return files
}

const hits = []
for (const file of collect(root)) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(NEEDLE)) {
    // 取调用点前后各若干字符作为上下文。
    const start = Math.max(0, match.index - 200)
    const snippet = text.slice(start, Math.min(text.length, match.index + 260))
    hits.push({ pkg: file.split(/[\\/]/u).slice(-3)[0], name: match[1], snippet })
  }
}

console.log(`找到 ${hits.length} 处"打开标签页"调用`)
console.log('')
const seen = new Set()
for (const hit of hits) {
  const key = `${hit.pkg}|${hit.name}`
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`--- ${hit.pkg}  ${hit.name}( ---`)
  // 只打与调用直接相关的行，去掉纯噪声。
  const lines = hit.snippet.split('\n').filter((l) => l.trim() !== '')
  for (const line of lines.slice(-8)) console.log(`    ${line.trim().slice(0, 150)}`)
  console.log('')
}
