// 用 CDP 对 gitbar 徽章做真实 DOM 交互测试。
//
//   node scripts/test-gitbar-ui.mjs
//
// 为什么需要它：`点击外部应关闭菜单` 是 DOM 事件行为，用临时仓库那种方式测不了。
// 这里通过 CDP 派发**真实事件**（mousedown/click），断言菜单的显隐，因此验证的是
// 真实组件而不是复制出来的逻辑。
//
// 前置：dev 应用在跑且开了 --remote-debugging-port=9222，工作区指向一个 git 仓库。
const keyword = 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面，先启动 dev 应用（--remote-debugging-port=9222）')
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
    entry.reject(
      new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text),
    )
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
      JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }),
    )
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('求值超时'))
      }
    }, 20000)
  })
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
/** 断言并打印。 */
function check(label, actual, expected) {
  const ok = String(actual) === String(expected)
  if (!ok) failures += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${actual}${ok ? '' : ` (期望 ${expected})`}`)
}

/** 按可见文本点击（只匹配真正可点的元素）。 */
async function clickByText(text) {
  return evaluate(`
    (() => {
      const target = ${JSON.stringify(text)};
      const node = [...document.querySelectorAll('button, [role=button], a')]
        .find((el) => (el.innerText || '').trim() === target);
      if (!node) return 'not-found';
      node.click();
      return 'clicked';
    })()
  `)
}

// ---- 准备：走完首次弹窗并进入会话 ------------------------------------------
//
// 用 --setup 才执行。默认跳过：这些点击（尤其是目录选择器里的确认按钮）可能命中
// 会触发应用重启的动作，把测试打断在一个半途状态里。DOM 行为测试应当在已经就绪的
// 界面上跑。
if (process.argv.includes('--setup')) {
  for (const label of ['继续', '稍后配置', '保存并继续', '标准模式', '新会话']) {
    const result = await clickByText(label)
    if (result === 'clicked') console.log(`[setup] 点击「${label}」`)
    await wait(2200)
  }
  await wait(2500)
}

// ---- 定位徽章 ---------------------------------------------------------------
//
// 徽章是容器里那个 title 以 "Git: " 开头的按钮。用 closest 的容器定位，
// 因为它才是"点击外部"判定的作用域。
const findChip = `
  (() => {
    const node = [...document.querySelectorAll('button')]
      .find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
    return node === undefined ? null : node;
  })()
`
const chipExists = await evaluate(`Boolean(${findChip})`)
console.log('')
console.log('徽章是否渲染:', chipExists)
if (!chipExists) {
  const body = await evaluate('document.body.innerText.replace(/\\n+/g, " | ").slice(0, 400)')
  console.log('页面文本:', body)
  console.log('')
  console.log('无法继续：徽章未渲染。若界面停在开始页，先手动进一个会话；或用 --setup。')
  socket.close()
  process.exit(1)
}

/** 菜单是否可见：菜单标题文本是否存在且可见。 */
const menuOpen = `Boolean([...document.querySelectorAll('div')].find((el) => (el.innerText || '').trim().startsWith('切换分支') && el.offsetParent !== null))`

// ---- 0. 归一化到"菜单关闭"的已知状态 ---------------------------------------
//
// 不能假设测试开始时菜单是关的：应用可能刚重启、或上一次交互留下了打开状态。
// 先强行关掉并确认，否则后面每条断言都会因初始状态不同而误判。
await evaluate(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  true
`)
await wait(600)
const normalized = await evaluate(menuOpen)
console.log('')
console.log('归一化后菜单状态（应为 false）:', normalized)
if (normalized === 'true' || normalized === true) {
  // 兜底：直接点徽章把它关掉。
  await evaluate(`(${findChip}).click()`)
  await wait(600)
}

// ---- 1. 点徽章应打开菜单 ----------------------------------------------------
check('1) 初始菜单关闭', await evaluate(menuOpen), 'false')
await evaluate(`(${findChip}).click()`)
await wait(700)
check('   点徽章后菜单打开', await evaluate(menuOpen), 'true')

// ---- 2. 点页面其他地方（真实 mousedown + click）应关闭 ----------------------
await evaluate(`
  (() => {
    // 点在页面左上角的空白区域：真实派发 mousedown 与 click，模拟用户操作。
    const target = document.querySelector('body');
    const opts = { bubbles: true, cancelable: true, clientX: 5, clientY: 5, button: 0 };
    target.dispatchEvent(new MouseEvent('mousedown', opts));
    target.dispatchEvent(new MouseEvent('mouseup', opts));
    target.dispatchEvent(new MouseEvent('click', opts));
    return true;
  })()
`)
await wait(700)
check('2) 点外部后菜单关闭', await evaluate(menuOpen), 'false')

// ---- 3. 再点徽章应能重新打开（确认没被卡住）--------------------------------
await evaluate(`(${findChip}).click()`)
await wait(700)
check('3) 可重新打开', await evaluate(menuOpen), 'true')

// ---- 4. Esc 应关闭 ----------------------------------------------------------
await evaluate(`
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  true
`)
await wait(700)
check('4) Esc 关闭菜单', await evaluate(menuOpen), 'false')

// ---- 5. 点菜单内部不应关闭 --------------------------------------------------
await evaluate(`(${findChip}).click()`)
await wait(700)
await evaluate(`
  (() => {
    // 点菜单标题那一行（在容器内部），menu 应保持打开。
    const header = [...document.querySelectorAll('div')]
      .find((el) => (el.innerText || '').trim() === '切换分支');
    if (!header) return 'no-header';
    const opts = { bubbles: true, cancelable: true, button: 0 };
    header.dispatchEvent(new MouseEvent('mousedown', opts));
    header.dispatchEvent(new MouseEvent('mouseup', opts));
    return 'clicked';
  })()
`)
await wait(700)
check('5) 点菜单内部保持打开', await evaluate(menuOpen), 'true')

socket.close()
console.log('')
console.log(failures === 0 ? '全部通过' : `${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
