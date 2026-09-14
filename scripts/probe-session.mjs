// Create a session in the live UI so session-scoped chrome renders, then report
// the conversation header's controls. Diagnostic helper; not shipped.
//
//   node scripts/probe-session.mjs ["message text"]
const PORT = process.env.DSH_CDP_PORT ?? '9222'

const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
const page = (await response.json()).find((t) => t.type === 'page')
if (page === undefined) throw new Error('no page target')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))

let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const text = process.argv[2] ?? '你好'

// Focus the composer through the DOM, then insert text as real input events so
// the app's own handlers see it (a bare .value assignment would not).
await evaluate(`(() => {
  const el = document.querySelector('div[role="textbox"]')
  if (!el) return 'no textbox'
  el.focus()
  return 'focused'
})()`)
await sleep(300)
await send('Input.insertText', { text })
await sleep(600)

const composed = await evaluate(`document.querySelector('div[role="textbox"]').textContent`)
console.log('[probe-session] composer now holds:', JSON.stringify(composed))

// Send via the send button so the app's own submit path runs.
const sent = await evaluate(`(() => {
  const buttons = [...document.querySelectorAll('button')]
  const send = buttons.find((b) => (b.getAttribute('aria-label') || '').includes('发送'))
  if (!send) return 'send button not found'
  if (send.disabled) return 'send disabled'
  send.click()
  return 'clicked send'
})()`)
console.log('[probe-session]', sent)

console.log('[probe-session] waiting for a session to materialize…')
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1000)
  const state = await evaluate(`(() => {
    const controls = [...document.querySelectorAll('button,[role="button"]')]
      .map((b) => ({ label: (b.getAttribute('aria-label') || b.textContent || '').trim(), rect: b.getBoundingClientRect() }))
      .filter((c) => c.rect.width > 0 && c.label)
    return {
      url: location.href,
      hasSession: /session/.test(location.href) || document.body.innerText.includes('探索未至之境') === false,
      labels: controls.map((c) => c.label.slice(0, 40)),
    }
  })()`)
  if (state.hasSession) {
    console.log(`[probe-session] session appeared after ${attempt + 1}s; url=${state.url}`)
    console.log('[probe-session] controls now:')
    for (const label of state.labels) console.log('   ', label)
    break
  }
  if (attempt === 39) {
    console.log('[probe-session] no session materialized; controls:')
    for (const label of state.labels) console.log('   ', label)
  }
}

socket.close()
process.exit(0)
