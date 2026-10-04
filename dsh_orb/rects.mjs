/**
 * Measure where the ball and the panel actually land, for every direction, over CDP.
 *
 * The invariant this exists to check cannot be checked by reading either side alone: the ball's
 * screen position is `window origin + its offset inside the window`, and the offset is decided by
 * the stylesheet while the origin is decided by the main process. A disagreement between the two
 * is invisible to the unit tests (which only ever compare sizes) and shows up only as a ball that
 * jumps when the direction changes.
 *
 * So: park the window, wear each direction in turn, and report both rects. The ball's rect must be
 * the same in all four — that is the whole claim. The panel's rect must then sit beside it, with
 * `PANEL_GAP` between, on the side the direction names.
 *
 * Requires a helper started with --remote-debugging-port=9222 (fake-host.mjs does that).
 */
const PORT = process.argv[2] ?? '9222'
const GAP = Number(process.argv[3] ?? 10)

const EXPR = `(() => {
  const style = document.createElement('style')
  style.textContent = '*{transition:none !important;animation:none !important}'
  document.head.appendChild(style)
  const panel = document.querySelector('#panel')
  const ball = document.querySelector('#ball')
  const round = (r) => ({ l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) })
  const out = []
  for (const h of ['left', 'right']) {
    for (const v of ['up', 'down']) {
      document.body.className = 'expand-' + h + ' expand-' + v + ' expanded'
      panel.hidden = false
      out.push({
        dir: h + '/' + v,
        ball: round(ball.getBoundingClientRect()),
        panel: round(panel.getBoundingClientRect()),
        win: [window.innerWidth, window.innerHeight],
        at: [window.screenX, window.screenY],
      })
    }
  }
  return out
})()`

async function targets() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`)
      return await response.json()
    } catch {
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
  throw new Error(`no devtools endpoint on ${PORT}`)
}

const list = await targets()
const page = list.find((t) => t.type === 'page' && /floating|shell/.test(t.url)) ?? list.find((t) => t.type === 'page')
if (page === undefined) {
  console.log('NO PAGE TARGET. targets:', list.map((t) => `${t.type} ${t.url}`).join(' | '))
  process.exit(1)
}
console.log('page:', page.url)

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

const result = await send('Runtime.evaluate', { expression: EXPR, awaitPromise: true, returnByValue: true })
if (result.result?.exceptionDetails) {
  console.log('EXCEPTION:', JSON.stringify(result.result.exceptionDetails).slice(0, 800))
  process.exit(1)
}
const rows = result.result.result.value
ws.close()

const win = rows[0].win
console.log(`\nwindow: ${win[0]}x${win[1]} CSS px, at screen ${rows[0].at}\n`)
console.log('dir          ball (l,t,w,h)              panel (l,t,w,h)             relations')
const first = rows[0].ball
let ballSteady = true
for (const row of rows) {
  const b = row.ball
  const p = row.panel
  const [h, v] = row.dir.split('/')
  if (b.l !== first.l || b.t !== first.t || b.w !== first.w || b.h !== first.h) ballSteady = false
  const gapOk = h === 'left' ? p.l + p.w + GAP === b.l : b.l + b.w + GAP === p.l
  const alignOk = v === 'up' ? p.t + p.h === b.t + b.h : p.t === b.t
  const inside = p.l >= 0 && p.t >= 0 && p.l + p.w <= win[0] && p.t + p.h <= win[1]
  console.log(
    `${row.dir.padEnd(12)} ${`${b.l},${b.t},${b.w},${b.h}`.padEnd(26)} ${`${p.l},${p.t},${p.w},${p.h}`.padEnd(28)} ` +
      `gap=${gapOk ? 'ok' : 'OFF'} align=${alignOk ? 'ok' : 'OFF'} insideWin=${inside ? 'ok' : 'NO'}`,
  )
}
console.log(`\nball steady across all four directions: ${ballSteady ? 'YES' : 'NO'}`)
process.exit(ballSteady ? 0 : 2)
