// 探查官方右侧栏的"打开标签页"接口，用于让审查面板以侧边栏标签呈现。
//
//   node scripts/probe-rightbar-api.mjs
//
// 需求希望审查用官方自带的侧边栏，而不是自制浮层。要做到这点必须知道：
//   1. 侧边栏暴露了哪个服务/动作可以用来打开标签页
//   2. 标签页的形状（id / contentId / kind 等）
//   3. actions 参数里有什么可用
// 这些不能靠猜，因为槽位的注入契约是运行期决定的。
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(process.cwd(), 'runtime', 'node_modules', '@deepseek-ai')

/** 读一个包的客户端代码。 */
function clientOf(pkg) {
  const path = join(root, pkg, 'lib', 'client.js')
  try {
    if (!statSync(path).isFile()) return undefined
  } catch {
    return undefined
  }
  return readFileSync(path, 'utf8')
}

for (const pkg of ['dsh-client-ui-sidebar-right']) {
  const text = clientOf(pkg)
  if (text === undefined) {
    console.log(`${pkg}: 没有客户端代码`)
    continue
  }
  console.log(`=== ${pkg}（${text.length} 字符）===`)

  // 它提供的服务
  const provides = [...text.matchAll(/ctx\.provide\(\s*["']([^"']+)["']/gu)].map((m) => m[1])
  console.log(`  provide: ${[...new Set(provides)].join(', ') || '(无)'}`)

  // 它注册的槽位
  const slots = [...text.matchAll(/slots\.(register|inject)\(\s*["']?([^"',)]*)/gu)].map((m) => `${m[1]}:${m[2]}`)
  console.log(`  槽位: ${[...new Set(slots)].join(', ') || '(无)'}`)

  // 与"打开/激活标签"相关的导出名
  const openers = [...text.matchAll(/(open[A-Z]\w*|activate\w*|showPane\w*|openPane\w*|setActive\w*|pushTab\w*|addTab\w*)/gu)]
    .map((m) => m[1])
  console.log(`  可能的打开动作: ${[...new Set(openers)].slice(0, 20).join(', ') || '(无)'}`)

  // actions 的形状：找 inject 里返回的键
  const injectBlocks = [...text.matchAll(/inject:\s*(?:\([^)]*\)|\w+)\s*=>\s*\(\{([\s\S]{0,400}?)\}\)/gu)]
  for (const block of injectBlocks.slice(0, 6)) {
    const keys = [...block[1].matchAll(/(?:^|[,{\s])([A-Za-z_$][\w$]*)\s*[:,]/gu)].map((m) => m[1])
    if (keys.length > 0) console.log(`  inject 键: ${[...new Set(keys)].join(', ')}`)
  }
  console.log('')
}

// store 的定义：标签页状态放在哪里，动作叫什么
const text = clientOf('dsh-client-ui-sidebar-right')
if (text !== undefined) {
  console.log('=== 标签页状态与动作 ===')
  for (const pattern of [
    /byTab\s*[:=]/gu,
    /(openTab|closeTab|activateTab|selectTab|setTab|open\w*Tab)\s*[:(]/gu,
    /tabs\s*:\s*\[/gu,
    /contentId/gu,
  ]) {
    const hits = [...text.matchAll(pattern)].length
    console.log(`  ${String(pattern).padEnd(46)} ${hits} 处`)
  }

  // 找 createStore / defineStore 之类的调用，看动作名
  const storeCalls = [...text.matchAll(/(?:create\w*Store|defineStore|createStore)\(([\s\S]{0,600}?)\)\s*[;,)]/gu)]
  for (const call of storeCalls.slice(0, 3)) {
    const names = [...call[1].matchAll(/([a-zA-Z_$][\w$]*)\s*\(/gu)].map((m) => m[1])
    console.log(`  store 内定义的动作: ${[...new Set(names)].slice(0, 24).join(', ')}`)
  }
}
