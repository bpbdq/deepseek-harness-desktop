// 端到端验证项目级常驻面板：不进入任何会话，面板应当可用并能显示工作区的未提交改动。
//
//   node scripts/test-project-panel.mjs
//
// 需求是"进入项目就能点开侧边栏，不必先在对话里"。官方右侧栏做不到（其内容槽带
// scope: "session"，实测 openTabIn 在无会话时静默返回），因此这块面板是自绘的。
// 这个脚本断言它在**项目页**确实存在、可展开、并且有内容。
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
const check = (label, actual, expected) => {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 面板入口：项目页那个「项目改动」按钮。 */
const TRIGGER = `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '') === '项目改动')`

/** 面板本体：标题为「项目改动」的 aside。 */
const PANEL = `document.querySelector('aside[style*="position: fixed"]')`

console.log('=== 项目页状态 ===')
const before = JSON.parse(
  await evaluate(`
    (() => JSON.stringify({
      session: localStorage.getItem('dsh.sessions.current'),
      trigger: Boolean(${TRIGGER}),
      triggerLabel: (${TRIGGER}||{}).innerText || null,
      panel: Boolean(${PANEL}),
    }))()
  `),
)
console.log(`  ${JSON.stringify(before)}`)
check('没有当前会话（确认处在项目页）', before.session, 'null')
check('项目页出现了面板入口', before.trigger, 'true')

console.log('')
console.log('=== 点击展开 ===')
// 先确保是收起的，避免反向操作。
await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
await wait(9000)

const afterReload = JSON.parse(
  await evaluate(`(() => JSON.stringify({ trigger: Boolean(${TRIGGER}), panel: Boolean(${PANEL}) }))()`),
)
check('重载后入口仍在（默认收起）', afterReload.trigger, 'true')
check('默认不展开', afterReload.panel, 'false')

await evaluate(`(${TRIGGER})?.click(), true`)
await wait(1500)

const opened = JSON.parse(
  await evaluate(`
    (() => {
      const panel = ${PANEL};
      if (!panel) return JSON.stringify({ panel: false });
      const r = panel.getBoundingClientRect();
      return JSON.stringify({
        panel: true,
        text: (panel.innerText || '').replace(/\\n+/g, ' | ').slice(0, 120),
        rect: { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom) },
        viewport: { w: window.innerWidth, h: window.innerHeight },
      });
    })()
  `),
)
console.log(`  ${JSON.stringify(opened)}`)
check('面板已展开', opened.panel, 'true')
check('面板在视口内（左）', opened.rect.left >= 0, 'true')
check('面板在视口内（上）', opened.rect.top >= 0, 'true')
check('面板在视口内（右）', opened.rect.right <= opened.viewport.w, 'true')
check('面板在视口内（下）', opened.rect.bottom <= opened.viewport.h, 'true')
check('面板有内容（标题或文件列表）', /项目改动|个文件|没有未提交|没有改动|尚未|不是 git/.test(opened.text), 'true')

console.log('')
console.log('=== 收起 ===')
await evaluate(`
  (() => {
    const panel = ${PANEL};
    const close = panel ? [...panel.querySelectorAll('button')].find((b) => (b.getAttribute('title') || '') === '收起面板') : null;
    close?.click();
    return true;
  })()
`)
await wait(1200)
const closed = JSON.parse(await evaluate(`(() => JSON.stringify({ panel: Boolean(${PANEL}) }))()`))
check('收起后面板消失', closed.panel, 'false')

socket.close()
console.log('')
console.log(failures === 0 ? '项目级面板全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
