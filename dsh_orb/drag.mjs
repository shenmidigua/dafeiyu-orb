/**
 * Drag the ball with a real press-move-release and ask whether it stayed under the pointer.
 *
 * This is the check for the reported bug — "the GIF's position wanders while I drag the ball" —
 * and it is the only one that takes the machine's own word for it. Two other probes already cover
 * the halves: `rects.mjs` wears each direction in turn and confirms the stylesheet puts the ball in
 * the same place in all four, and the helper's unit suite pins the geometry the window is built
 * from. Neither one drags. The drag is where the two halves disagree, because:
 *
 *  - the main process re-decides the direction on **every** `orb:move`, and
 *  - the page never applies it during a drag: `moveBall` only applies `docked`, so whatever
 *    `expand-*` class the page happened to be wearing when the drag began, it keeps.
 *
 * A frozen class is harmless only while the ball's offset inside the window does not depend on the
 * class. It did: the four `body.expand-* #ball` rules moved the ball between corners, so the moment
 * a drag crossed the middle of the work area the main process switched to the other corner's
 * formula while the page stayed in the old one, and the ball was drawn a whole panel away from the
 * pointer — not for a frame, but for the rest of the drag and after it.
 *
 * So the invariant measured here is `window origin + ball offset == pointer - grab offset`, sampled
 * with the pointer held still at each step so that the allowed one-frame lag of a two-process
 * handoff is not mistaken for the bug. `--expect` names what to expect (the control run against the
 * pre-fix package is the same script with the other answer).
 *
 * The drag is driven with `Input.dispatchMouseEvent`, which produces trusted events carrying a real
 * `screenX`, and whose screen position the caller therefore controls exactly: the widget's screen
 * origin is `window.screenX`, so dispatching at viewport `target - screenX` puts the page's own
 * `event.screenX` on `target`. The page records what it saw, and the comparison uses that rather
 * than the requested value, so a constant offset between the widget and the content view cannot
 * flatter the result. The real mouse is never moved: nothing here depends on the OS cursor, which
 * also keeps the main process's hit-test polling from interfering.
 *
 * Usage: `drag.mjs [port] [--settle 150] [--step 40] [--expect fixed|broken]`
 * Requires a helper started with --remote-debugging-port=9222 (fake-host.mjs does that).
 */

const args = process.argv.slice(2)
const PORT = (args.find((a) => /^\d+$/.test(a)) ?? '9222').toString()
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const SETTLE = Number(flag('settle', 150))
const STEP = Number(flag('step', 64))
const BUDGET = Number(flag('budget', 80))
const TOLERANCE = Number(flag('tolerance', 6))
const EXPECT = flag('expect', 'fixed')      // 'fixed' = post-fix, 'broken' = the control
const TRACE = args.includes('--trace')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function targets() {
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`)
      return await response.json()
    } catch {
      await sleep(1000)
    }
  }
  throw new Error(`no devtools endpoint on ${PORT}`)
}

const list = await targets()
const page = list.find((t) => t.type === 'page' && /floating|shell/.test(t.url))
  ?? list.find((t) => t.type === 'page')
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

async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.result?.exceptionDetails) {
    console.log('EXCEPTION:', JSON.stringify(reply.result.exceptionDetails).slice(0, 600))
    process.exit(1)
  }
  return reply.result.result.value
}

const mouse = (type, x, y, buttons) =>
  send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y), button: 'left', buttons, clickCount: 1,
  })

// The recorder is installed in the capture phase so it sees every pointermove, including the ones
// the ball's own handler consumes under pointer capture. Transitions and animations are off so a
// sample is the settled layout, not the middle of a fade.
await evaluate(`(() => {
  const style = document.createElement('style')
  style.textContent = '*{transition:none !important;animation:none !important}'
  document.head.appendChild(style)
  window.__orbSeen = null
  document.addEventListener('pointermove', (event) => {
    window.__orbSeen = {
      sx: Math.round(event.screenX), sy: Math.round(event.screenY),
      cx: Math.round(event.clientX), cy: Math.round(event.clientY), buttons: event.buttons,
    }
  }, true)
  return true
})()`)

const READ = `(() => {
  const b = document.querySelector('#ball').getBoundingClientRect()
  return {
    sx: window.screenX, sy: window.screenY,
    iw: window.innerWidth, ih: window.innerHeight,
    aw: screen.availWidth, ah: screen.availHeight,
    bx: b.left, by: b.top, bw: b.width, bh: b.height,
    cls: document.body.className,
    seen: window.__orbSeen,
  }
})()`

const start = await evaluate(READ)
console.log(`\nwindow at ${start.sx},${start.sy}  viewport ${start.iw}x${start.ih}`
  + `  work area ${start.aw}x${start.ah}`)
console.log(`ball at ${start.bx},${start.by} ${start.bw}x${start.bh}  body "${start.cls}"`)

// Park the pointer on the ball without pressing, to establish where the page thinks the widget is.
// `grab*` are viewport coordinates (what the input domain wants); `grabScreen*` are the same point
// on the display (what the sweeps and the invariant are written in). Mixing the two was the first
// version's bug: it swept the cursor to screen coordinates taken from a viewport reading, so the
// pointer teleported and the ball's honest lag looked like the defect.
const grabX = start.bx + start.bw / 2
const grabY = start.by + start.bh / 2
const grabScreenX = start.sx + grabX
const grabScreenY = start.sy + grabY
await mouse('mouseMoved', grabX, grabY, 0)
await sleep(SETTLE)
const hover = await evaluate(READ)
if (hover.seen === null) {
  console.log('the page saw no pointermove: CDP input is not reaching the renderer')
  process.exit(1)
}
// Zero when the widget's screen origin and `window.screenX` agree, which is what lets the sweep
// below aim at a screen position by dispatching at `target - window.screenX`.
const offsetX = hover.seen.sx - (hover.sx + hover.seen.cx)
const offsetY = hover.seen.sy - (hover.sy + hover.seen.cy)
console.log(`\ncalibration: dispatched viewport ${Math.round(grabX)},${Math.round(grabY)}`
  + ` -> page saw screen ${hover.seen.sx},${hover.seen.sy}, client ${hover.seen.cx},${hover.seen.cy}`
  + `  (window ${hover.sx},${hover.sy}; screen - window - client = ${offsetX},${offsetY})`)

await send('Input.dispatchMouseEvent', {
  type: 'mousePressed', x: Math.round(grabX), y: Math.round(grabY),
  button: 'left', buttons: 1, clickCount: 1,
})
await sleep(SETTLE)
const pressed = await evaluate(READ)
// The grab offset, in the page's own client coordinates, exactly as `ballGrabOffset` computes it.
const dx = pressed.seen.cx - pressed.bx
const dy = pressed.seen.cy - pressed.by
console.log(`pressed: ball left ${pressed.bx},${pressed.by}; grab offset ${dx.toFixed(0)},${dy.toFixed(0)}`
  + `  body "${pressed.cls}"`)

/** Read the page and append one sample: where the ball is, against where the pointer says it is. */
const samples = []
async function sample(axis, phase) {
  const s = await evaluate(READ)
  if (s.seen === null) return null
  const ballLeft = s.sx + s.bx
  const ballTop = s.sy + s.by
  // A ball pinned against a work-area edge is `clampBall` doing its job, not the drag going wrong,
  // so those samples are reported but kept out of the verdict.
  const atLimit = ballLeft <= 4 || ballTop <= 4
    || ballLeft + s.bw >= s.aw - 4 || ballTop + s.bh >= s.ah - 4
  const row = {
    axis, phase, atLimit,
    wantX: s.seen.sx, wantY: s.seen.sy,
    errX: ballLeft - (s.seen.sx - dx),
    errY: ballTop - (s.seen.sy - dy),
    iw: s.iw, ih: s.ih, cls: s.cls,
    ballX: ballLeft, ballY: ballTop, winX: s.sx, winY: s.sy,
  }
  samples.push(row)
  if (TRACE) {
    console.log(`    let it go at ${Math.round(ballLeft)},${Math.round(ballTop)}`
      + `  window ${s.sx},${s.sy}  page saw ${s.seen.sx},${s.seen.sy}`
      + `  err ${row.errX.toFixed(1)},${row.errY.toFixed(1)}`)
  }
  return row
}

/**
 * Swipe the pointer across the ball by `STEP` at a time, for as long as the ball keeps answering.
 *
 * The pointer is held a fixed small distance from the ball's centre and the same move is dispatched
 * over and over. That is all a drag is: the page puts the ball's own grab point under the pointer,
 * so each dispatch advances the ball by exactly that distance — which is why this needs no absolute
 * screen target. Aiming at one is not even possible: CDP input coordinates are window-relative, and
 * a target on the far side of the display is a negative viewport coordinate, which the input domain
 * does not deliver. The first version of this script aimed at screen positions and produced a
 * window that never moved — an artefact of its own aiming, not of the helper.
 *
 * The sweep ends at the work-area edge, or when the ball stops answering two moves in a row. That
 * second stop is what a clamp looks like from here — and also what the defect looks like, so the
 * position it stopped at is reported rather than assumed.
 */
const stopped = []
async function drive(axis, sign, phase) {
  let last = null
  let still = 0
  for (let n = 0; n < BUDGET; n += 1) {
    const now = await evaluate(READ)
    const left = now.sx + now.bx
    const top = now.sy + now.by
    still = last !== null && Math.abs(left - last[0]) < 0.5 && Math.abs(top - last[1]) < 0.5
      ? still + 1 : 0
    if (still >= 2) {
      stopped.push({ axis, sign, at: [left, top], moves: n })
      console.log(`    the ball stopped answering at ${Math.round(left)},${Math.round(top)}`
        + ` after ${n} moves of ${sign * STEP}px`)
      break
    }
    last = [left, top]
    const atEdge = axis === 'x'
      ? (sign < 0 ? left <= 4 : left + now.bw >= now.aw - 4)
      : (sign < 0 ? top <= 4 : top + now.bh >= now.ah - 4)
    if (atEdge) break
    await mouse('mouseMoved', axis === 'x' ? grabX + sign * STEP : grabX,
                axis === 'y' ? grabY + sign * STEP : grabY, 1)
    await sleep(SETTLE)
    await sample(axis, phase)
  }
}

console.log(`\nswiping the pointer ${STEP}px off the ball's centre at a time, to each edge and back`)
for (const axis of ['x', 'y']) {
  for (const [sign, phase] of [[1, 'up/right'], [-1, 'down/left']]) {
    console.log(`\n--- ${axis} ${phase} ---`)
    await drive(axis, sign, phase)
    const inSweep = samples.filter((s) => s.axis === axis && s.phase === phase)
    if (inSweep.length === 0) {
      console.log('    no samples')
      continue
    }
    const edge = inSweep.filter((s) => s.atLimit).length
    const worstX = Math.max(...inSweep.map((s) => Math.abs(s.errX)))
    const worstY = Math.max(...inSweep.map((s) => Math.abs(s.errY)))
    console.log(`    -> ${inSweep.length} samples (${edge} with the ball at an edge),`
      + ` worst error ${worstX.toFixed(1)}px across, ${worstY.toFixed(1)}px down`)
  }
}

await send('Input.dispatchMouseEvent', {
  type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0, clickCount: 1,
})
await sleep(SETTLE)
const released = await evaluate(READ)
console.log(`\nreleased: body "${released.cls}"  ball ${released.bx},${released.by}`)

if (samples.length < 10) {
  console.log(`only ${samples.length} samples: not enough to judge`)
  ws.close()
  process.exit(1)
}

// The verdict. Both axes are asserted: a direction-dependent offset would show on whichever axis
// the ball crossed the middle of the work area, and dragging diagonally is as ordinary as dragging
// straight. Samples with the ball pinned to a work-area edge are reported but not judged.
const judged = samples.filter((s) => !s.atLimit)
const worstX = judged.reduce((a, s) => (Math.abs(s.errX) > Math.abs(a.errX) ? s : a), judged[0])
const worstY = judged.reduce((a, s) => (Math.abs(s.errY) > Math.abs(a.errY) ? s : a), judged[0])
const viewports = new Set(samples.map((s) => `${s.iw}x${s.ih}`))
const classes = [...new Set(samples.map((s) => s.cls))]

console.log(`\nsamples: ${samples.length} (${samples.length - judged.length} with the ball at a work-area edge)`)
console.log(`viewport sizes seen: ${[...viewports].join(', ')}`
  + `   <- must be one value: nothing resizes during a drag`)
console.log(`body class during the drag: ${classes.length === 1 ? `frozen at "${classes[0]}"` : classes.join(' | ')}`)
console.log(`\nerror is "window origin + ball offset" minus "pointer - grab offset", in CSS px:`)
console.log(`  x: worst ${worstX.errX.toFixed(1)}  (at cursor ${worstX.wantX},${worstX.wantY})`)
console.log(`  y: worst ${worstY.errY.toFixed(1)}  (at cursor ${worstY.wantX},${worstY.wantY})`)

const bad = judged.filter((s) => Math.abs(s.errX) > TOLERANCE || Math.abs(s.errY) > TOLERANCE)
console.log(`\nsamples over ${TOLERANCE}px of error: ${bad.length} of ${judged.length} judged`)
for (const s of bad.slice(0, 14)) {
  console.log(`    ${s.axis} ${s.phase.padEnd(10)} cursor ${String(s.wantX).padStart(5)},${String(s.wantY).padStart(5)}`
    + `  err ${s.errX.toFixed(1)},${s.errY.toFixed(1)}  class "${s.cls}"`)
}
if (bad.length > 14) console.log(`    ... ${bad.length - 14} more`)

const fixed = bad.length === 0
console.log(`\nthe ball stayed under the pointer: ${fixed ? 'YES' : 'NO'}`)
console.log(`expected for ${EXPECT}: ${EXPECT === 'fixed' ? 'YES' : 'NO'}`
  + `   -> ${fixed === (EXPECT === 'fixed') ? 'AS EXPECTED' : 'UNEXPECTED'}`)
ws.close()
process.exit(fixed === (EXPECT === 'fixed') ? 0 : 2)
