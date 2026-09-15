// 诊断"点击外部关闭"为什么没生效。
//
//   node scripts/cdp-diag-outside.mjs
//
// 检查三件事：
//   1. 徽章按钮向上数几层能到带 ref 的容器（我用 display:inline-flex + position:relative 标记它）
//   2. 菜单 DOM 是否真的在那个容器内部（若在外部，contains 判定就会误判）
//   3. 对 body 派发 mousedown 时，容器对 event.target 的 contains 结果
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
              const chip = [...document.querySelectorAll('button')]
                .find((el) => (el.getAttribute('title') || '').startsWith('Git:'));
              if (!chip) return { error: 'chip not found' };

              // 向上列出祖先链，看哪一层像我设的容器（position:relative + inline-flex）
              const chain = [];
              let node = chip;
              for (let i = 0; i < 8 && node; i += 1) {
                const style = getComputedStyle(node);
                chain.push({
                  tag: node.tagName.toLowerCase(),
                  cls: (node.className || '').toString().slice(0, 40),
                  position: style.position,
                  display: style.display,
                  slot: node.getAttribute('data-slot') || '',
                });
                node = node.parentElement;
              }

              // 找菜单容器，并判断它是否在徽章的某个祖先内
              const menu = [...document.querySelectorAll('div')]
                .find((el) => (el.innerText || '').trim().startsWith('切换分支'));
              let menuInsideChain = null;
              if (menu) {
                let cursor = menu.parentElement;
                let depth = 0;
                while (cursor && depth < 10) {
                  if (chain.some((c, index) => index > 0 && cursor === chip.parentElement)) break;
                  cursor = cursor.parentElement;
                  depth += 1;
                }
                // 直接判断：菜单是否是徽章父容器的后代
                const container = chip.parentElement;
                menuInsideChain = container ? container.contains(menu) : null;
              }

              // 对 body 派发 mousedown，看容器对 target 的 contains 结果
              const container = chip.parentElement;
              let containsBody = null;
              if (container) {
                const evt = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
                Object.defineProperty(evt, 'target', { value: document.body, configurable: true });
                containsBody = container.contains(document.body);
              }

              return {
                chain,
                menuFound: Boolean(menu),
                menuInsideChipContainer: menuInsideChain,
                chipContainerIsBody: container === document.body,
                bodyContainsChip: document.body.contains(chip),
                containsBody,
              };
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
console.log(JSON.stringify(value, null, 2))
