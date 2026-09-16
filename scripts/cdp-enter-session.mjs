// 点掉 API Key 弹窗并进入会话，用于在真实界面上验证布局。
//
//   node scripts/cdp-enter-session.mjs
//
// 背景：官方的 API Key 对话框会挡住输入框，而审查/分支插件都挂在输入框工具栏上——
// 不点掉它就无法验证这两个插件的布局。填一个占位 key 即可放行（界面只要求"有 key"，
// 不会去校验有效性），因此这里不必填真 key。
//
// 说明：这只是**为了验证布局**而走的捷径，不改变任何持久状态之外的东西。
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

/** 点掉一个按文本匹配的按钮。 */
const clickText = (text) =>
  evaluate(`
    (() => {
      const target = ${JSON.stringify(text)};
      const node = [...document.querySelectorAll('button, [role=button]')]
        .find((el) => (el.innerText || '').trim() === target);
      if (!node) return 'not-found';
      node.click();
      return 'clicked';
    })()
  `)

// 依序点掉可能出现的几层弹窗，直到输入框工具栏出现。
for (const label of ['继续', '稍后配置', '标准模式', '新会话']) {
  const result = await clickText(label)
  if (result === 'clicked') console.log(`点击「${label}」`)
  await wait(2000)
}

// 若 API Key 对话框仍在，填一个占位值再继续。
const filled = await evaluate(`
  (() => {
    const input = document.querySelector('input[type=password]');
    if (!input) return 'no-password-input';
    // React 受控输入必须用原生 setter 赋值，直接改 value 不会触发 onChange。
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'sk-placeholder-for-layout-verification');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()
`)
console.log('填占位 key:', filled)
await wait(1200)
console.log('保存并继续:', await clickText('保存并继续'))
await wait(2500)
console.log('新会话:', await clickText('新会话'))
await wait(4000)

const report = await evaluate(`
  (() => {
    const chip = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
    const review = [...document.querySelectorAll('button')].find((el) => (el.title || '').includes('本轮修改') || (el.innerText || '').includes('本轮'));
    return JSON.stringify({
      composer: Boolean(document.querySelector('[class*=trailing]')),
      gitbarChip: chip ? chip.innerText.trim() : null,
      reviewChip: review ? review.innerText.trim() : null,
      bodyLength: document.body.innerText.length,
    });
  })()
`)
console.log('界面状态:', report)
socket.close()
