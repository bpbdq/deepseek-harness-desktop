// 查清「项目改动」面板当前是**怎么决定显示哪个工作区**的。
//
//   node scripts/probe-project-workspace-choice.mjs
//
// 用户反馈面板显示的是应用自己的仓库（F:\code\dshDesktop），而他在用的项目是另一个
// （mmsm-amis）。要修就不能靠猜优先级——先把取值链上每一环的实际值打出来。
import { readFileSync, existsSync } from 'node:fs'

const candidates = [
  `${process.env.APPDATA}\\dsh-desktop\\bundled-runtime\\runtime\\node_modules\\dsh-client-ui-review\\lib\\client.js`,
  'plugins/dsh-client-ui-review/lib/client.js',
]

const file = candidates.find((path) => existsSync(path))
if (file === undefined) {
  console.error('找不到 review 插件的客户端代码')
  process.exit(1)
}
console.log(`检查: ${file}`)
console.log('')

const text = readFileSync(file, 'utf8')

// 1) 决定工作区的那一行。
const line = /const workspace = picked[^\n]*/u.exec(text)
console.log(`决定工作区: ${line === null ? '(未找到)' : line[0].trim()}`)

// 2) 推断函数里各来源的顺序。
const fn = /function resolveProjectWorkspace\(props\)\s*\{/u.exec(text)
if (fn !== null) {
  const body = text.slice(fn.index, fn.index + 2000)
  const order = []
  if (body.includes('useSessions')) order.push('最近会话的 cwd')
  if (body.includes('useWorkspaces')) order.push('工作区列表第一项')
  if (body.includes('props?.workspace')) order.push('props.workspace')
  console.log(`推断顺序: ${order.join(' -> ') || '(空)'}`)
}

// 3) 是否向宿主问过工作区清单，以及问到的清单是否包含所有已登记工作区。
console.log(`调用 /roots: ${text.includes("call('roots'")}`)
console.log(`候选来源含 roots: ${text.includes('roots.length > 0 ? roots : fromHooks')}`)

// 4) 面板标题附近显示的工作区（用于自查）。
const pick = /options\.length > 1/u.test(text)
console.log(`仅在有多个候选时显示选择器: ${pick}`)
console.log('')

// 5) 宿主侧到底会返回哪些工作区。
const hostFile = file.replace('client.js', 'index.js')
const host = readFileSync(hostFile, 'utf8')
const usesShell = host.includes('DSH_DESKTOP_WORKSPACE')
const usesRegistry = host.includes('workspace.json')
console.log('宿主 /roots 的来源:')
console.log(`  外壳工作区（DSH_DESKTOP_WORKSPACE）: ${usesShell}`)
console.log(`  应用登记的工作区（workspace.json）: ${usesRegistry}`)
