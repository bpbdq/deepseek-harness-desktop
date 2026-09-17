// 在调试协议里定位应用页面。
//
// 只按 type==='page' 与回环地址匹配，**不按标题匹配**：界面加载失败时标题会变成
// 请求 URL（而非应用名），按标题找会得到"找不到页面"，把真正的问题掩盖成脚本问题。
export async function findAppPage(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const page = list.find(
    (t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/u.test(String(t.url)) && !String(t.url).includes('devtools'),
  )
  return page
}

/**
 * 连上页面并返回求值函数。
 * @param port - 调试端口。
 * @returns `{ evaluate, close }`；找不到页面时抛出。
 */
export async function connect(port) {
  const page = await findAppPage(port)
  if (page === undefined) {
    throw new Error(`找不到应用页面（端口 ${port}）`)
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
  return {
    evaluate: (expression) =>
      new Promise((resolve) => {
        const id = nextId++
        pending.set(id, resolve)
        socket.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        )
      }),
    close: () => socket.close(),
  }
}
