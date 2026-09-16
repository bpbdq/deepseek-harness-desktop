// 列出官方各客户端包注册的槽位，用于挑选"审查"面板该挂在哪里。
//
//   node scripts/list-slots.mjs [关键字]
//
// 背景：需求希望审查面板用官方自带的侧边栏呈现，而不是自制浮层。要做到这一点必须先知道
// 官方暴露了哪些槽位（尤其是侧边栏与变更概览相关的），而不是凭猜测硬塞。
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const filter = process.argv[2]
const root = join(process.cwd(), 'runtime', 'node_modules', '@deepseek-ai')

/** 递归找出所有 client.js。 */
function findClients(dir) {
  const found = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    if (entry === 'lib') {
      const client = join(path, 'client.js')
      try {
        if (statSync(client).isFile()) found.push({ pkg: dir.split(/[\\/]/u).pop(), path: client })
      } catch {
        // 没有客户端半边。
      }
      continue
    }
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) found.push(...findClients(path))
  }
  return found
}

const rows = []
for (const { pkg, path } of findClients(root)) {
  const text = readFileSync(path, 'utf8')
  // 槽位注册形如 ctx.slots.register({ name: "...", id: "...", order: n }, Component)
  const pattern = /slots\.register\(\s*\{[\s\S]{0,240}?name:\s*["']([^"']+)["'][\s\S]{0,160}?id:\s*["']([^"']+)["']/gu
  for (const match of text.matchAll(pattern)) {
    rows.push({ pkg, slot: match[1], id: match[2] })
  }
  // 也捕捉 inject 形式（注入既有槽位）的用法。
  const injectPattern = /slots\.inject\(\s*["']([^"']+)["']/gu
  for (const match of text.matchAll(injectPattern)) {
    rows.push({ pkg, slot: match[1], id: '(inject)' })
  }
}

const unique = [...new Map(rows.map((r) => [`${r.slot}|${r.pkg}`, r])).values()].sort((a, b) =>
  a.slot.localeCompare(b.slot),
)

console.log(`共 ${unique.length} 条槽位注册`)
console.log('')
for (const row of unique) {
  if (filter !== undefined && !row.slot.includes(filter) && !row.pkg.includes(filter)) continue
  console.log(`  ${row.slot.padEnd(40)} ${row.pkg.padEnd(44)} ${row.id}`)
}
