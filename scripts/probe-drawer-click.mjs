// 诊断：为什么点击入口按钮后抽屉没打开。
//
//   node scripts/probe-drawer-click.mjs
//
// `.click()` 只派发 click 事件，而真实点击是 mousedown -> mouseup -> click。抽屉的
// "点击外部关闭"监听 mousedown（捕获阶段），两者的交互可能与合成点击不同。这里对比
// 两种派发方式的结果，判断问题出在哪一环。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes('DeepSeek Harness'))
if (page === undefined) {
  console.error('找不到页面')
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

/** 复位成关闭状态。 */
async function reset() {
  await evaluate(`localStorage.removeItem('dsh.review.panelOpen'), location.reload(), true`)
  await wait(9000)
}

const STATE = `JSON.stringify({ stored: localStorage.getItem('dsh.review.panelOpen'), drawer: Boolean(document.querySelector('aside[style*=fixed]')) })`

console.log('=== 方式一：只派发 click（合成点击）===')
await reset()
await evaluate(`(document.querySelector('[data-review-trigger]')?.click(), true)`)
await wait(1500)
console.log(`  ${await evaluate(STATE)}`)

console.log('')
console.log('=== 方式二：完整事件序列（mousedown + mouseup + click）===')
await reset()
await evaluate(`
  (() => {
    const el = document.querySelector('[data-review-trigger]');
    if (!el) return 'no-trigger';
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return 'dispatched';
  })()
`)
await wait(1500)
console.log(`  ${await evaluate(STATE)}`)

console.log('')
console.log('=== 方式三：只派发 mousedown（看它是否会关闭）===')
await reset()
await evaluate(`localStorage.setItem('dsh.review.panelOpen','1'), location.reload(), true`)
await wait(9000)
console.log(`  打开后: ${await evaluate(STATE)}`)
await evaluate(`
  (() => {
    const el = document.querySelector('[data-review-trigger]');
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    return 'mousedown';
  })()
`)
await wait(1200)
console.log(`  仅 mousedown 后: ${await evaluate(STATE)}`)

socket.close()
