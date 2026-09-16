// 往 dev 环境的 workspace 注册表里写入一条**完整合法**的记录，用于验证项目级面板。
//
//   node scripts/seed-dev-workspace.mjs <仓库路径>
//
// 为什么需要：项目级面板按"当前项目"取数据，而 dev 实例既没有会话也没有已登记的工作区，
// 于是面板只能显示"选择要查看的项目"——功能对不对无从验证。
//
// schema 来自 dsh-workspace 的 workspaceRecord（缺任何字段都会让 dsh 启动时报
// "stored record does not match its schema"，之前手工写少了 title/sessionIds 就踩过）：
//   path, title, sessionIds[], createdAt, updatedAt
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const workspace = process.argv[2] ?? 'E:\\workspace\\mmsm-amis'
const home = join(process.cwd(), '.dev-home', 'home', 'storages')
mkdirSync(home, { recursive: true })

const file = join(home, 'workspace.json')
const now = new Date().toISOString()

let payload
try {
  payload = JSON.parse(readFileSync(file, 'utf8'))
} catch {
  payload = { unit: { name: 'workspace', version: 2 }, global: {}, tables: { workspaces: {} } }
}

// 补齐结构，避免缺字段导致启动失败。
payload.unit = payload.unit ?? { name: 'workspace', version: 2 }
payload.global = { initialized: true, workspaceIds: [], archivedSessionIds: [], ...(payload.global ?? {}) }
payload.tables = payload.tables ?? {}
payload.tables.workspaces = {
  dev1: {
    path: workspace,
    title: workspace.split(/[\\/]/u).pop() ?? workspace,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  },
}
payload.global.workspaceIds = ['dev1']

writeFileSync(file, JSON.stringify(payload, null, 2) + '\n')
console.log(`已写入工作区记录: ${workspace}`)
console.log(`  ${file}`)
