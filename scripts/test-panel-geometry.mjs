// 测量审查面板与分支菜单的几何，断言它们完整落在视口内。
//
//   node scripts/test-panel-geometry.mjs
//
// 为什么需要它：面板此前用 `position: absolute` 挂在输入框工具栏的小容器里，被裁剪成
// 只露出顶部一条——这类缺陷用肉眼看截图才能发现，而几何是可以断言的：把视口调小、
// 打开面板、量它的边界矩形，就能确认是否越界。
//
// 覆盖两个尺寸：常规窗口与"小屏"（800×600，接近用户报告的场景）。
const keyword = 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面，先启动带 --remote-debugging-port=9222 的实例')
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  entry(message.result?.result?.value)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))

const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 找到两个插件各自的按钮。
 *
 * 审查入口的文本会随状态变化（"本轮暂无改动"或纯数字），因此按 title 精确匹配，
 * 而不是按文本包含关系——按文本匹配会同时命中分支徽章（它的文本也可能含同样的字）。
 */
const FIND = {
  review: `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '') === '在侧边栏查看')`,
  gitbar: `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'))`,
}

/**
 * 测量某个下拉面板的几何。
 *
 * 面板由插件渲染成"按钮的兄弟节点"，而 React 多子节点返回的是 Fragment——Fragment 的
 * `children` 不含子元素，所以不能用 querySelector 按结构找。这里用 childNodes 从按钮的
 * 父节点里挑出那个非按钮的元素节点，是唯一稳定的定位方式。
 * @param trigger - 展开面板的表达式（返回按钮元素）。
 */
async function measure(trigger) {
  // 先确保是关的，再打开——否则可能反向操作。
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
  await evaluate(`(${trigger})?.click(), true`)
  await wait(700)
  const raw = await evaluate(`
    (() => {
      const button = ${trigger};
      if (!button) return JSON.stringify({ found: false, why: 'no-button' });
      const panel = [...button.parentElement.childNodes].find((n) => n.nodeType === 1 && n !== button);
      if (!panel) return JSON.stringify({ found: false, why: 'no-panel' });
      const r = panel.getBoundingClientRect();
      const style = getComputedStyle(panel);
      return JSON.stringify({
        found: true,
        position: style.position,
        text: (panel.innerText || '').replace(/\\n+/g, ' | ').slice(0, 40),
        rect: { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    })()
  `)
  return JSON.parse(raw)
}

/** 对一个视口尺寸跑完整套断言。 */
async function verify(label, width, height) {
  console.log('')
  console.log(`=== ${label}（${width}×${height}）===`)
  await send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await wait(900)

  for (const [name, trigger] of Object.entries(FIND)) {
    const result = await measure(trigger)
    if (!result.found) {
      // 某些状态下按钮不存在（例如非 git 仓库）——记为跳过而不是失败。
      console.log(`  SKIP  ${name}: 未找到（${result.why}）`)
      continue
    }
    const { rect, viewport } = result
    console.log(`  ${name}: position=${result.position} rect=${JSON.stringify(rect)}`)
    console.log(`       内容: ${result.text}`)
    // 定位必须是 fixed：absolute 会被输入框卡片的可视区域裁掉（这正是修复前的缺陷）。
    check(`${name} 用视口定位（fixed）`, result.position, 'fixed')
    check(`${name} 左边界不越界`, rect.left >= 0, 'true')
    check(`${name} 上边界不越界`, rect.top >= 0, 'true')
    check(`${name} 右边界在视口内`, rect.right <= viewport.w, 'true')
    check(`${name} 下边界在视口内`, rect.bottom <= viewport.h, 'true')
    check(`${name} 宽度为正`, rect.width > 0, 'true')
    check(`${name} 高度为正`, rect.height > 0, 'true')
  }

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(300)
}

try {
  await verify('常规窗口', 1440, 900)
  await verify('小屏', 800, 600)
} finally {
  await send('Emulation.clearDeviceMetricsOverride')
  socket.close()
}

console.log('')
console.log(failures === 0 ? '几何全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
