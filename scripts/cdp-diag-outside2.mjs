// 逐步验证"点击外部关闭"到底在哪一步失效。
//
//   node scripts/cdp-diag-outside2.mjs
//
// 单独派发 mousedown / mouseup / click，逐一看菜单状态，避免把三种事件混在一起
// 而分不清是谁触发的关闭或重开。
const keyword = 'DeepSeek Harness'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
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

const MENU = `Boolean([...document.querySelectorAll('div')].find((el) => (el.innerText || '').trim().startsWith('切换分支') && el.offsetParent !== null))`
const CHIP = `[...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'))`

// 关闭再打开，拿到确定状态
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
await wait(500)
await evaluate(`(${CHIP}).click(), true`)
await wait(700)
console.log('点徽章后菜单打开:', await evaluate(MENU))

// 1) 只 mousedown
await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true`)
await wait(700)
console.log('  仅 mousedown 后:', await evaluate(MENU))

// 2) 若还开着，再单独 click
if ((await evaluate(MENU)) === true) {
  await evaluate(`document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })), true`)
  await wait(700)
  console.log('  再单独 click 后:', await evaluate(MENU))
}

// 3) 若还开着，试试在 document 上派发（而不是 body）
if ((await evaluate(MENU)) === true) {
  await evaluate(`document.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })), true`)
  await wait(700)
  console.log('  在 document 上 mousedown 后:', await evaluate(MENU))
}

// 4) 若还开着，点一个真实存在的其它按钮（模型选择器）
if ((await evaluate(MENU)) === true) {
  const result = await evaluate(`
    (() => {
      const other = [...document.querySelectorAll('button')]
        .find((el) => (el.getAttribute('title') || '').startsWith('DeepSeek'));
      if (!other) return 'no-other-button';
      other.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      return 'dispatched';
    })()
  `)
  await wait(700)
  console.log(`  对其它按钮 mousedown (${result}) 后:`, await evaluate(MENU))
}

socket.close()
