// 列出各槽位的类型（single / list / keyed）与其父槽，用于判断"能否再挂一个控件"。
//
//   node scripts/list-slot-kinds.mjs [关键字]
//
// 为什么需要：槽位分三种。往 single 槽注册会**顶掉**既有注册，甚至让整个界面加载失败
// （实际踩过：占用 conversation.composer.bar 导致 "Failed to load plugins"，因为官方
// 的 conversation 包也要注册它）。list 槽才能容纳多个注册。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const filter = process.argv[2]
const root = join(process.cwd(), 'runtime', 'node_modules', '@deepseek-ai')

/** 递归收集插件客户端代码。 */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const path = join(dir, entry)
    let stat
    try {
      stat = statSync(path)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...collect(path))
    else if (entry === 'client.js') out.push({ pkg: dir.split(/[\\/]/u).pop(), path })
  }
  return out
}

const rows = []
for (const { pkg, path } of collect(root)) {
  const text = readFileSync(path, 'utf8')

  // 形如： name: "x", ... kind: "y" ... scope: "z"
  for (const match of text.matchAll(/name:\s*["']([^"']+)["']([\s\S]{0,400}?)(?=\n\s{4}\}|\},|\)|\)\s*,)/gu)) {
    const name = match[1]
    const body = match[2]
    const kind = /kind:\s*["']([^"']+)["']/u.exec(body)?.[1] ?? 'single(默认)'
    const scope = /scope:\s*["']([^"']+)["']/u.exec(body)?.[1] ?? 'root(默认)'
    rows.push({ name, kind, scope, pkg })
  }

  // 作为 children 声明的槽位： `"child.name": { kind: ..., scope: ... }`
  for (const match of text.matchAll(/["']([a-zA-Z][\w.]*)["']\s*:\s*\{\s*kind:\s*["']([^"']+)["'][\s\S]{0,120}?scope:\s*["']([^"']+)["']/gu)) {
    rows.push({ name: match[1], kind: match[2], scope: match[3], pkg, via: 'children' })
  }
}

const unique = [...new Map(rows.map((r) => [`${r.name}|${r.kind}`, r])).values()].sort((a, b) => a.name.localeCompare(b.name))

console.log(`共 ${unique.length} 条`)
console.log('')
for (const row of unique) {
  if (filter !== undefined && !row.name.includes(filter)) continue
  if (row.kind !== 'list') continue
  console.log(`  ${row.name.padEnd(42)} ${row.kind.padEnd(6)} ${row.scope.padEnd(9)} ${row.pkg}`)
}
