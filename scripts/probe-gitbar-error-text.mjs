// 触发一次必然失败的分支切换，并读出菜单里的本地化提示。
//
//   node scripts/probe-gitbar-error-text.mjs
//
// 为什么需要：错误提示的本地化只有在真触发一次失败时才看得到。这里点一个当前分支
// 之外的分支——工作区有未提交改动，git 会拒绝，于是走错误渲染分支。
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

console.log('语言:', await evaluate(`JSON.stringify({ lang: navigator.language, htmlLang: document.documentElement.lang })`))

/** 菜单是否打开（按标题文案判断，中英都认）。 */
const MENU_OPEN = `
  Boolean([...document.querySelectorAll('div')].find((el) => {
    const text = (el.innerText || '').trim();
    return (text.startsWith('Switch branch') || text.startsWith('切换分支')) && el.offsetParent !== null;
  }))
`

// 归一化到"菜单关闭"，否则下面那一次点击会把它关掉而不是打开。
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`)
await wait(600)
console.log('归一化后菜单打开:', await evaluate(MENU_OPEN))

// 打开菜单
await evaluate(`
  (() => {
    const chip = [...document.querySelectorAll('button')].find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
    if (chip) chip.click();
    return true;
  })()
`)
await wait(1200)
console.log('点击徽章后菜单打开:', await evaluate(MENU_OPEN))

// 点一个非当前分支的本地分支（切换会因未提交改动被 git 拒绝）
const clicked = await evaluate(`
  (() => {
    const menu = [...document.querySelectorAll('div')].find((el) => {
      const text = (el.innerText || '').trim();
      return (text.startsWith('Switch branch') || text.startsWith('切换分支')) && el.offsetParent !== null;
    });
    if (!menu) return 'no-menu';
    const buttons = [...menu.querySelectorAll('button')].filter((b) => !b.disabled && b.innerText.trim() !== '');
    // 第一个按钮是菜单标题栏之外的第一个分支项。
    const target = buttons[0];
    if (!target) return 'no-target';
    const label = target.innerText.trim();
    target.click();
    return label;
  })()
`)
console.log('点击的分支:', clicked)
await wait(3500)

// 读出菜单里的提示文本
const text = await evaluate(`
  (() => {
    const menu = [...document.querySelectorAll('div')].find((el) => {
      const t = (el.innerText || '').trim();
      return (t.startsWith('Switch branch') || t.startsWith('切换分支')) && el.offsetParent !== null;
    });
    return menu ? menu.innerText : '(菜单已关闭——可能切换成功了，没有错误可看)';
  })()
`)
console.log('')
console.log('=== 菜单内容 ===')
console.log(text)
socket.close()
