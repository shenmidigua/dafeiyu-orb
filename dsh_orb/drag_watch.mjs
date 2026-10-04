/**
 * Watch where the page thinks the ball is, without sending it anything.
 *
 * The drag is driven by `drag_probe.py` with the real mouse, because nothing else reproduces the
 * user's gesture honestly. Injecting pointer events over CDP looks like the tidier way to do it and
 * is not: the input domain takes window-relative coordinates, so the caller has to turn its target
 * into `target - window.screenX` — which means it must know the window's screen position at the
 * instant the event is built. That is the one quantity in flux during a drag, and it is in flux in
 * two processes at once. Driving that way produced a window that jumped 627px on a request of 64,
 * and then stopped moving entirely; both were artefacts of the harness. A real cursor is simply
 * where it is, and the page reads `event.screenX` off it directly.
 *
 * So this is the passive half: it samples `window.screenX` and the ball's own rect, which is the
 * composition the defect lives in — the ball's screen position is the window's origin plus its
 * offset inside the window, and neither of them means anything alone. Samples are timestamped with
 * `Date.now()` so the driver's own record of the cursor can be lined up against them.
 *
 * Usage: `drag_watch.mjs <out.jsonl> <seconds> [port]`
 */

import { writeFileSync, appendFileSync } from 'node:fs'

const OUT = process.argv[2]
const SECONDS = Number(process.argv[3] ?? 90)
const PORT = (process.argv[4] ?? '9222').toString()

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`)
      return await response.json()
    } catch {
      await sleep(500)
    }
  }
  throw new Error(`no devtools endpoint on ${PORT}`)
}

const list = await targets()
const page = list.find((t) => t.type === 'page' && /floating|shell/.test(t.url))
  ?? list.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('NO PAGE TARGET:', list.map((t) => `${t.type} ${t.url}`).join(' | '))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

// Transitions and animations are off so a sample is the settled layout rather than the middle of a
// fade; nothing else is touched, and no input is sent.
const setup = await send('Runtime.evaluate', {
  expression: `(() => {
    const style = document.createElement('style')
    style.textContent = '*{transition:none !important;animation:none !important}'
    document.head.appendChild(style)
    return true
  })()`,
  returnByValue: true,
})
if (setup.result?.exceptionDetails) {
  console.error('EXCEPTION:', JSON.stringify(setup.result.exceptionDetails).slice(0, 500))
  process.exit(1)
}

const READ = `(() => {
  const b = document.querySelector('#ball').getBoundingClientRect()
  return {
    sx: window.screenX, sy: window.screenY,
    bx: b.left, by: b.top, bw: b.width, bh: b.height,
    iw: window.innerWidth, ih: window.innerHeight,
    aw: screen.availWidth, ah: screen.availHeight,
    dpr: window.devicePixelRatio,
    cls: document.body.className,
    tab: document.querySelector('#dock-tab').hidden,
  }
})()`

writeFileSync(OUT, '')
console.error(`watching ${page.url} for ${SECONDS}s -> ${OUT}`)

let written = 0
const deadline = Date.now() + SECONDS * 1000
while (Date.now() < deadline) {
  const reply = await send('Runtime.evaluate', { expression: READ, returnByValue: true })
  const value = reply.result?.result?.value
  if (value !== undefined) {
    appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), ...value })}\n`)
    written += 1
  }
  await sleep(20)
}
console.error(`wrote ${written} samples`)
ws.close()
process.exit(0)
