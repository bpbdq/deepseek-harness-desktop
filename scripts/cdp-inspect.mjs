// 用 CDP 读取页面的结构化状态，供排查"某块 UI 为什么没渲染"。
//
//   node scripts/cdp-inspect.mjs [标题关键字]
//
// 与 cdp-eval.mjs 的区别：表达式写在这个文件里（不经 shell），因此可以放心使用
// 引号与中文——把 JS 内联进 PowerShell 参数已经被证明不可靠（引号会被拆开）。
const keyword = process.argv[2] ?? 'DeepSeek Harness'

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面:', keyword)
  for (const t of list.filter((x) => x.type === 'page')) console.error(`  ${t.title}  ${t.url}`)
  process.exit(1)
}

/** 在页面里求值。 */
async function evaluate(expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时')), 20000)
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
        reject(new Error(message.result.exceptionDetails.exception?.description ?? message.result.exceptionDetails.text))
        return
      }
      resolve(message.result?.result?.value)
    })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 错误'))
    })
  }).finally(() => socket.close())
}

const report = await evaluate(`
  (() => {
    const text = document.body.innerText;
    // 找出输入框工具栏的右侧容器：官方类名里含 trailing。
    const trailing = document.querySelector('[class*=trailing]');
    const buttons = [...document.querySelectorAll('button')].map((b) => (b.innerText || '').trim().slice(0, 24));
    return {
      bodyLength: text.length,
      hasComposerPlaceholder: text.includes('描述你想构建的内容') || text.includes('描述'),
      trailingFound: trailing !== null,
      trailingText: trailing ? trailing.innerText.replace(/\\n+/g, ' | ').slice(0, 300) : null,
      containsBranchName: /\\b(master|main)\\b/.test(text),
      buttonLabels: buttons.slice(0, 30),
      headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => (h.innerText || '').trim().slice(0, 40)).slice(0, 10),
    };
  })()
`)

console.log(JSON.stringify(report, null, 2))
