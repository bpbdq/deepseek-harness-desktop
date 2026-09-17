// 复现并定位客户端 bundle 加载失败：直接请求那个 bundle URL，看服务端到底返回什么。
//
//   node scripts/probe-bundle-request.mjs
//
// 报错形如：
//   client-modules: bundle script /plugins/??<id 列表>&v=<revision> failed to load
// 它只说"加载失败"，不说是 404、500 还是被拒。这里把同一段路径直接请求一次，
// 拿到状态码与响应体，才能判断问题在服务端还是客户端。
const PORT = Number(process.env.DSH_CDP_PORT ?? 9333)
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes('DeepSeek Harness'))
if (page === undefined) {
  console.error(`找不到页面（端口 ${PORT}）`)
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

// 从页面文本里取出被拒绝的那个 URL。
const url = await evaluate(`
  (() => {
    const text = document.body.innerText || '';
    const m = /\\/plugins\\/\\?\\?[^\\s)]+/.exec(text);
    return m === null ? null : m[0];
  })()
`)
if (url === null) {
  console.log('页面上找不到 bundle URL（界面可能已正常加载）')
  socket.close()
  process.exit(0)
}
console.log(`bundle URL 长度: ${url.length}`)
console.log(`前 160 字符: ${url.slice(0, 160)}`)

// 用 fetch 直接请求它，拿到状态码与正文开头。
const outcome = await evaluate(`
  (async () => {
    try {
      const response = await fetch(${JSON.stringify(url)});
      const text = await response.text();
      return JSON.stringify({ status: response.status, contentType: response.headers.get('content-type'), length: text.length, head: text.slice(0, 300) });
    } catch (error) {
      return JSON.stringify({ error: String(error && error.message) });
    }
  })()
`)
console.log('')
console.log('直接请求的结果:')
console.log(`  ${outcome}`)

// 顺带问一次"不带 v 参数"的同一路径，看是否与缓存键有关。
const withoutRevision = url.replace(/&v=\\d+$/u, '')
if (withoutRevision !== url) {
  const without = await evaluate(`
    (async () => {
      try {
        const response = await fetch(${JSON.stringify(withoutRevision)});
        const text = await response.text();
        return JSON.stringify({ status: response.status, length: text.length, head: text.slice(0, 200) });
      } catch (error) {
        return JSON.stringify({ error: String(error && error.message) });
      }
    })()
  `)
  console.log('')
  console.log('去掉 &v= 后再请求:')
  console.log(`  ${without}`)
}

socket.close()
