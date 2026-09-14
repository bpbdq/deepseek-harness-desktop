// 点掉内测声明并进入一个会话，然后检查 gitbar 徽章是否渲染。
//
//   node scripts/cdp-open-session.mjs
//
// 为什么要走到会话里：`conversation.input.right` 是 **session 作用域**的槽，输入框
// 只在会话内存在。因此"徽章没出现"可能只是"还没进会话"，必须先排除这一层再判断
// 插件本身的问题。
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
  if (message.result?.exceptionDetails) {
    entry.reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
    return
  }
  entry.resolve(message.result?.result?.value)
})

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', () => reject(new Error('WebSocket 错误')))
})

/** 在页面里求值。 */
function evaluate(expression) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    )
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('求值超时'))
      }
    }, 20000)
  })
}

/** 按可见文本点击第一个匹配的元素。 */
async function clickByText(text) {
  return evaluate(`
    (() => {
      const target = ${JSON.stringify(text)};
      // 只匹配真正可点的元素。之前把 div 也纳入候选，结果匹配到外层包裹元素，
      // 点上去毫无效果——报告 clicked 但界面没变，误导性很强。
      const nodes = [...document.querySelectorAll('button, [role=button], a')];
      const hit = nodes.find((el) => (el.innerText || '').trim() === target);
      if (!hit) return 'not-found:' + nodes.map((n) => (n.innerText || '').trim()).filter(Boolean).join('/');
      hit.click();
      return 'clicked';
    })()
  `)
}

console.log('[1] 点"继续"关闭内测声明:', await clickByText('继续'))
await new Promise((r) => setTimeout(r, 1500))

// 首次启动会依次出现 API Key 配置与模式选择，都跳过——本探针只关心输入框工具栏，
// 不需要一个可用的模型。这些步骤只在第一次运行时存在。
for (const label of ['稍后配置', '保存并继续', '标准模式']) {
  const result = await clickByText(label)
  if (result === 'clicked') console.log(`[2] 点"${label}":`, result)
  await new Promise((r) => setTimeout(r, 2000))
}

console.log('[3] 点"新会话":', await clickByText('新会话'))
await new Promise((r) => setTimeout(r, 3000))

// 必须选一个工作区，输入框工具栏才会真正渲染——空工作区时工具栏是空的，
// 徽章自然不会出现。这一步不能省，否则会把"还没选工作区"误判成插件没生效。
const wsResult = await evaluate(`
  (() => {
    const trigger = [...document.querySelectorAll('button, [role=button]')]
      .find((el) => (el.innerText || '').includes('选择工作区'));
    if (!trigger) return 'no-trigger';
    trigger.click();
    return 'opened';
  })()
`)
console.log('[4] 打开工作区选择:', wsResult)
await new Promise((r) => setTimeout(r, 1500))

const picked = await evaluate(`
  (() => {
    const items = [...document.querySelectorAll('[role=menuitem], [role=option], button, li')];
    const hit = items.find((el) => (el.innerText || '').trim() === 'dshDesktop');
    if (!hit) {
      return 'not-found:' + items.map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 12).join('/');
    }
    hit.click();
    return 'clicked';
  })()
`)
console.log('[5] 选中 dshDesktop:', picked)
await new Promise((r) => setTimeout(r, 4000))

const report = await evaluate(`
  (() => {
    const text = document.body.innerText;
    const trailing = document.querySelector('[class*=trailing]');
    return {
      bodyLength: text.length,
      trailingText: trailing ? trailing.innerText.replace(/\\n+/g, ' | ') : null,
      hasBranchWord: /\\b(master|main)\\b/.test(text),
      // gitbar 的按钮 title 以 "Git: " 开头，用它判断徽章是否渲染。
      gitTitles: [...document.querySelectorAll('[title]')]
        .map((e) => e.getAttribute('title'))
        .filter((t) => t && t.startsWith('Git:')),
      composerPresent: Boolean(document.querySelector('textarea, [contenteditable=true]')),
    };
  })()
`)
console.log('[6] 结果:', JSON.stringify(report, null, 2))
socket.close()
