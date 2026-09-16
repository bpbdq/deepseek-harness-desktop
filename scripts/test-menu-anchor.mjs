// 验证下拉面板贴着各自的入口显示，而不是飘到屏幕角落。
//
//   node scripts/test-menu-anchor.mjs
//
// 背景：把面板从 `absolute` 改成 `fixed` 是为了跳出输入框容器的裁剪（小窗口下曾被裁成
// 一条），但 `fixed` 不再跟随入口——偏移写成常量就会钉在角落。实测分支菜单就飘到了左下角。
// 因此这里的断言不是"面板在视口内"（那太弱），而是"面板与入口在位置上相关"。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const keyword = 'DeepSeek Harness'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error(`找不到页面（端口 ${PORT}）`)
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

const evaluate = (expression) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    )
  })
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

/**
 * 打开某个入口，量出入口与它面板的矩形，并判断两者的位置关系。
 * @param label - 展示名。
 * @param finder - 返回入口元素的表达式。
 * @param menuSelector - 面板选择器表达式。
 * @param side - 'above' 表示面板应在入口上方，'below' 表示在下方。
 */
async function verify(label, finder, menuSelector, side) {
  console.log('')
  console.log(`=== ${label} ===`)
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
  const clicked = await evaluate(`(() => { const el = ${finder}; if (!el) return 'not-found'; el.click(); return 'clicked' })()`)
  if (clicked === 'not-found') {
    console.log('  SKIP  入口不存在')
    return
  }
  await wait(1200)

  const raw = await evaluate(`
    (() => {
      const trigger = ${finder};
      const menu = ${menuSelector};
      if (!trigger || !menu) return JSON.stringify({ found: false, trigger: Boolean(trigger), menu: Boolean(menu) });
      const t = trigger.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      return JSON.stringify({
        found: true,
        trigger: { top: Math.round(t.top), bottom: Math.round(t.bottom), left: Math.round(t.left), right: Math.round(t.right) },
        menu: { top: Math.round(m.top), bottom: Math.round(m.bottom), left: Math.round(m.left), right: Math.round(m.right) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    })()
  `)
  const data = JSON.parse(raw)
  console.log(`  入口: ${JSON.stringify(data.trigger)}`)
  console.log(`  面板: ${JSON.stringify(data.menu)}`)

  check('面板已展开', data.found === true)
  // 核心断言：面板与入口在位置上相关。
  const horizontalOverlap = data.menu.right > data.trigger.left && data.menu.left < data.trigger.right
  check('与入口水平方向有重叠（未飘到别处）', horizontalOverlap)
  if (side === 'above') {
    // 面板应在入口上方：其底边不高于入口顶边 + 容差。
    check('面板位于入口上方', data.menu.bottom <= data.trigger.top + 12, `${data.menu.bottom} <= ${data.trigger.top}`)
  } else {
    check('面板位于入口下方', data.menu.top >= data.trigger.bottom - 12, `${data.menu.top} >= ${data.trigger.bottom}`)
  }
  check('面板不越出视口（上）', data.menu.top >= 0, String(data.menu.top))
  check('面板不越出视口（下）', data.menu.bottom <= data.viewport.h, `${data.menu.bottom} <= ${data.viewport.h}`)

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
  await wait(400)
}

// 分支菜单：在徽章上方展开。
await verify(
  '分支菜单',
  `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'))`,
  `[...document.querySelectorAll('div')].find((el) => (el.innerText || '').trim().startsWith('切换分支'))`,
  'above',
)

// 项目改动面板：在入口下方展开。
await verify(
  '项目改动面板',
  `[...document.querySelectorAll('button')].find((el) => /项目改动|选择要查看的项目/.test(el.getAttribute('title') || ''))`,
  `document.querySelector('aside[style*=fixed]')`,
  'below',
)

socket.close()
console.log('')
console.log(failures === 0 ? '位置关系全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
