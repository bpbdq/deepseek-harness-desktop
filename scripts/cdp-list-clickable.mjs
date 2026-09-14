// 把页面上所有可点元素及其文本打出来，用于定位"某个菜单项该点哪里"。
//
//   node scripts/cdp-list-clickable.mjs [标题关键字] [过滤关键字]
//
// 排查点击类问题时，先看清候选集合比反复猜选择器有效得多。
const keyword = process.argv[2] ?? 'DeepSeek Harness'
const filter = process.argv[3]

const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面:', keyword)
  process.exit(1)
}

const socket = new WebSocket(page.webSocketDebuggerUrl)
const value = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP 超时')), 20000)
  socket.addEventListener('open', () =>
    socket.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `
            (() => {
              const out = [];
              for (const el of document.querySelectorAll('button, [role=button], [role=menuitem], [role=option], li, a')) {
                const text = (el.innerText || '').replace(/\\n+/g, ' ').trim();
                if (text === '') continue;
                const rect = el.getBoundingClientRect();
                out.push({
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role') || '',
                  text: text.slice(0, 40),
                  visible: rect.width > 0 && rect.height > 0,
                  y: Math.round(rect.top),
                });
              }
              return out;
            })()
          `,
          returnByValue: true,
        },
      }),
    ),
  )
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== 1) return
    clearTimeout(timer)
    resolve(message.result?.result?.value ?? [])
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('WebSocket 错误'))
  })
})
socket.close()

const rows = Array.isArray(value) ? value : []
const shown = filter === undefined ? rows : rows.filter((r) => r.text.includes(filter))
console.log(`可点元素 ${rows.length} 个${filter === undefined ? '' : `，含"${filter}"的 ${shown.length} 个`}:`)
for (const row of shown.slice(0, 40)) {
  console.log(`  ${row.visible ? '可见' : '隐藏'} y=${String(row.y).padStart(4)} ${row.tag}${row.role ? `[${row.role}]` : ''}  ${row.text}`)
}
