// 在指定页面里求值一个表达式并打印结果。
//
//   node scripts/cdp-eval.mjs <标题关键字> "<JS 表达式>"
//
// 与 cdp-read.mjs 的区别：那个读 DOM 文本，这个能查任意状态（API 是否注入、
// 变量取值、错误对象），排查"为什么页面没渲染出预期内容"时更有用。
const keyword = process.argv[2] ?? '更新'
const expression = process.argv[3] ?? '1'

// 端口可用 DSH_CDP_PORT 覆盖：默认 9222 常被上一个未退出的实例占着，
// 此时 Electron 会报 "Cannot start http server for devtools" 而我们却连到了旧实例。
const port = process.env.DSH_CDP_PORT ?? '9222'
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()

// 先按标题找；找不到就退回"回环地址上的页面"。
//
// 为什么需要退回：界面加载失败时页面 title 会变成请求 URL（而非应用名），按标题找会
// 报"找不到页面"，把真正的问题掩盖成脚本问题——排查加载失败时这一点尤其要命。
const page =
  list.find((t) => t.type === 'page' && String(t.title).includes(keyword)) ??
  list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/u.test(String(t.url)))
if (page === undefined) {
  console.error(`找不到页面（标题关键字 "${keyword}"，也没有回环地址页面）`)
  for (const t of list.filter((t) => t.type === 'page')) console.error(`  ${t.title}  ${t.url}`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const value = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP 超时')), 15000)
  socket.addEventListener('open', () => {
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      }),
    )
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    if (message.result?.exceptionDetails) {
      resolve(`抛错: ${message.result.exceptionDetails.text} ${message.result.exceptionDetails.exception?.description ?? ''}`)
      return
    }
    resolve(message.result?.result?.value)
  })
  socket.addEventListener('error', (error) => {
    clearTimeout(timer)
    reject(new Error(String(error.message ?? error)))
  })
})
socket.close()

console.log(`=== ${page.title} ===`)
console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
