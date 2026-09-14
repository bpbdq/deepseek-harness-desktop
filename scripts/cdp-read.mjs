// 通过 CDP 读取某个页面的渲染结果，用来验证窗口内容（而不是靠截图猜）。
//
//   node scripts/cdp-read.mjs [标题关键字] [CSS 选择器]
//
// 本项目里更新窗口、项目信息窗口都是渲染进程页面，用 CDP 读 DOM 比截图可靠得多：
// 能拿到精确文本、能断言、不受分辨率与缩放影响。
const keyword = process.argv[2] ?? '更新'
const selector = process.argv[3] ?? 'body'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error(`找不到标题包含 "${keyword}" 的页面。当前有：`)
  for (const t of list.filter((t) => t.type === 'page')) console.error(`  ${t.title}  ${t.url}`)
  process.exit(1)
}

// 直接用 CDP 的 Runtime.evaluate，避免引入 ws 依赖：用 HTTP 拿到 webSocketDebuggerUrl
// 后仍需 WebSocket，这里改用 Node 内置的 WebSocket（Node 22+ 全局可用）。
const socket = new WebSocket(page.webSocketDebuggerUrl)
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP 超时')), 15000)
  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `(() => {
            const el = document.querySelector(${JSON.stringify(selector)});
            return el ? el.innerText : '(选择器未匹配)';
          })()`,
          returnByValue: true,
        },
      }),
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    resolve(message.result?.result?.value ?? JSON.stringify(message))
  })
  socket.addEventListener('error', (error) => {
    clearTimeout(timer)
    reject(new Error(String(error.message ?? error)))
  })
})
socket.close()

console.log(`=== ${page.title} :: ${selector} ===`)
console.log(result)
