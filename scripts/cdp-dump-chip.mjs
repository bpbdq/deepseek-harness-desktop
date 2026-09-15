// 把页面上包含 gitbar 痕迹的元素结构打出来，用于定位徽章的真实 DOM 形态。
//
//   node scripts/cdp-dump-chip.mjs
const keyword = 'DeepSeek Harness'
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
const page = list.find((t) => t.type === 'page' && String(t.title).includes(keyword))
if (page === undefined) {
  console.error('找不到页面')
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
              const out = { titles: [], probableChip: [], menus: [] };
              // 1) 所有 title 属性值（看徽章到底写了什么 title）
              for (const el of document.querySelectorAll('[title]')) {
                out.titles.push({ tag: el.tagName.toLowerCase(), title: (el.getAttribute('title') || '').slice(0, 80) });
              }
              // 2) 含分支名的元素（徽章里应含 develop-v7.0.0-yuheng）
              for (const el of document.querySelectorAll('button, span, div')) {
                const text = (el.innerText || '').trim();
                if (text === 'develop-v7.0.0-yuheng' || /^develop-v7\\.0\\.0-yuheng\\s/.test(text)) {
                  out.probableChip.push({ tag: el.tagName.toLowerCase(), text: text.slice(0, 60), cls: el.className });
                }
              }
              // 3) 可能的菜单容器
              for (const el of document.querySelectorAll('div')) {
                const text = (el.innerText || '');
                if (text.startsWith('切换分支')) out.menus.push({ text: text.slice(0, 90), visible: el.offsetParent !== null });
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
    resolve(message.result?.result?.value)
  })
  socket.addEventListener('error', () => {
    clearTimeout(timer)
    reject(new Error('WebSocket 错误'))
  })
})
socket.close()

console.log('=== title 属性 ===')
for (const row of value.titles.slice(0, 20)) console.log(`  ${row.tag}  ${row.title}`)
console.log('')
console.log('=== 含分支名的元素 ===')
for (const row of value.probableChip.slice(0, 10)) console.log(`  ${row.tag}  "${row.text}"  cls=${row.cls}`)
console.log('')
console.log('=== 菜单 ===')
for (const row of value.menus.slice(0, 5)) console.log(`  可见=${row.visible}  ${row.text}`)
