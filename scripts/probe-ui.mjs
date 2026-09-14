// Drive the live UI through a small CDP session.
//
//   node scripts/probe-ui.mjs click-text "<visible label>"   click the first control whose label contains it
//   node scripts/probe-ui.mjs dump                            list visible named controls
//   node scripts/probe-ui.mjs eval "<expression>"             evaluate in the page
const PORT = process.env.DSH_CDP_PORT ?? '9222'

const listResponse = await fetch(`http://127.0.0.1:${PORT}/json/list`)
const page = (await listResponse.json()).find((t) => t.type === 'page')
if (page === undefined) throw new Error('no page target; start the app with --remote-debugging-port=9222')

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

const [, , mode, argument] = process.argv

/**
 * Normalize a label before comparing.
 *
 * Chinese UI labels wrap examples in full-width quotes (U+201C/U+201D) while a
 * label typed on a command line usually carries ASCII quotes, so a raw
 * `includes` comparison silently misses. Quotes and whitespace are dropped.
 */
const normalizeHelper = `
  const norm = (s) => (s || '').replace(/[\\u201c\\u201d\\u2018\\u2019"']/g, '').replace(/\\s+/g, '').toLowerCase()
`

/** Snapshot every visible named control. */
const snapshot = `[...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[aria-label]')]
  .map((el) => {
    const rect = el.getBoundingClientRect()
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim()
    return { label: label.slice(0, 50), x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
  })
  .filter((c) => c.w > 0 && c.h > 0 && c.label)`

if (mode === 'click-text' || mode === 'click-at') {
  const target = await evaluate(`(() => {
    ${normalizeHelper}
    const wanted = norm(${JSON.stringify(argument)})
    const els = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[aria-label]')]
    const hit = els.find((el) => {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return false
      const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || ''
      return norm(label).includes(wanted)
    })
    if (!hit) return null
    const r = hit.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: (hit.getAttribute('aria-label') || hit.textContent || '').trim().slice(0, 50) }
  })()`)

  if (target === null) {
    console.log('[probe-ui] NOT FOUND:', argument)
  } else if (mode === 'click-at') {
    // Real mouse events at the control's centre: a JS .click() does not drive
    // React handlers that listen for pointer events.
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: target.x, y: target.y, button: 'left', clickCount: 1 })
    }
    console.log(`[probe-ui] pointer-clicked ${Math.round(target.x)},${Math.round(target.y)} -> ${target.label}`)
  } else {
    await evaluate(`(() => {
      ${normalizeHelper}
      const wanted = norm(${JSON.stringify(argument)})
      const hit = [...document.querySelectorAll('button,[role="button"],[role="menuitem"],a,[aria-label]')].find((el) => {
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 || rect.height === 0) return false
        return norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').includes(wanted)
      })
      hit.click()
    })()`)
    console.log('[probe-ui] js-clicked ->', target.label)
  }

  await sleep(1800)
  const controls = await evaluate(snapshot)
  console.log(`[probe-ui] ${controls.length} visible named controls now:`)
  for (const c of controls) console.log(`  ${String(c.x).padStart(5)},${String(c.y).padStart(4)} ${String(c.w).padStart(4)}x${String(c.h).padStart(3)}  ${c.label}`)
} else if (mode === 'dump') {
  const controls = await evaluate(snapshot)
  console.log(`[probe-ui] ${controls.length} visible named controls:`)
  for (const c of controls) console.log(`  ${String(c.x).padStart(5)},${String(c.y).padStart(4)} ${String(c.w).padStart(4)}x${String(c.h).padStart(3)}  ${c.label}`)
  console.log('[probe-ui] viewport:', JSON.stringify(await evaluate('({w: innerWidth, h: innerHeight})')))
} else if (mode === 'eval') {
  console.log(JSON.stringify(await evaluate(argument), null, 2))
} else {
  console.log('usage: probe-ui.mjs dump | click-text "<label>" | eval "<expr>"')
}

socket.close()
process.exit(0)
