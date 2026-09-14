// 读取页面控制台里的报错，用来定位"界面没渲染出来"。
//
//   node scripts/cdp-errors.mjs [标题关键字]
//
// 页面空白的常见原因是渲染进程抛错（模块图里某个 bundle 加载失败、注入的模块
// 不存在等），这类错误只出现在控制台里，读 DOM 是看不到的。
const keyword = process.argv[2] ?? 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面:', keyword)
  for (const t of list.filter((x) => x.type === 'page')) console.error(`  ${t.title}  ${t.url}`)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const collected = []

await new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, 6000)
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }))
    socket.send(JSON.stringify({ id: 2, method: 'Log.enable' }))
  })
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') {
      const d = message.params.exceptionDetails
      collected.push(`[exception] ${d.exception?.description ?? d.text}`)
    }
    if (message.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(message.params.type)) {
      const text = message.params.args.map((a) => a.description ?? a.value ?? '').join(' ')
      collected.push(`[console.${message.params.type}] ${text}`)
    }
    if (message.method === 'Log.entryAdded' && ['error', 'warning'].includes(message.params.entry.level)) {
      collected.push(`[log.${message.params.entry.level}] ${message.params.entry.text}`)
    }
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('WebSocket 错误'))
  })
}).finally(() => socket.close())

console.log(`=== ${page.title} 的控制台（捕获 ${collected.length} 条）===`)
for (const line of collected.slice(0, 40)) console.log(line.slice(0, 400))
if (collected.length === 0) console.log('(没有错误或警告)')
