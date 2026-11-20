/**
 * Walk the black panel through the whole cycle, and say whether each leg did what it should.
 *
 * The panel was switched off behind a constant in `shell.js`; this probe is the check that it is
 * back and that nothing about the way it comes and goes was left behind. Five legs, each with one
 * expected end state:
 *
 *   1. at rest                 panel hidden, `expanded` off
 *   2. pointer onto the ball   panel shown, `expanded` on      <- the thing the report was about
 *   3. click the ball          `pinned` on, panel still shown
 *   4. pointer off, unpinned   panel hidden again, `expanded` off
 *   5. pointer back on         panel shown again               <- the way in still works after a
 *                                                               collapse, not only the first time
 *
 * The pointer is synthetic and dispatched into the page, so the user's cursor and session are not
 * touched. Every reading is taken from the flags the collapse paths themselves test, mirrored onto
 * `document.body`'s class list, plus `#panel`'s own `hidden` — not from pixels.
 *
 * Usage: node probe_panel_cycle.mjs [port]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const MAIN = join(INSTALLED, 'lib', 'main.js')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')

for (const [label, path] of [['electron', RUNTIME], ['installed helper', MAIN], ['profile', PROFILE]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`)
    process.exit(2)
  }
}

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
const port = process.argv[2] ?? '9550'

// The page reads the ball's assets from the profile; without this it draws nothing and every
// snapshot below is about a blank element.
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: settings.assetDirectory,
  DSH_ORB_WAKE: JSON.stringify({
    enabled: settings.enabled,
    keyword: settings.keyword,
    threshold: settings.threshold,
    autoExpandOnWake: settings.autoExpandOnWake,
    dictation: settings.dictation,
  }),
}

const scratch = mkdtempSync(join(tmpdir(), 'orb-panel-cycle-'))
const token = 'probe-token'
const socketPort = 19700 + (process.pid % 200)

// A stub host: the page greets it, asks for the Windows it may capture and the TCC status, and
// nothing here needs a real turn. Unanswered frames are fine — the observation is about the panel.
let pageSock = null
// Every frame the page sends: the last leg asks whether a draft pressed Enter actually leaves.
const hostSaw = []
const host = createServer((sock) => {
  pageSock = sock
  let pending = ''
  sock.setEncoding('utf8')
  sock.write(`${JSON.stringify({ type: 'hello-ack', token })}\n`)
  sock.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      hostSaw.push(message?.type ?? '?')
      if (message?.type === 'tcc') {
        sock.write(`${JSON.stringify({
          type: 'tcc', applicable: false, appName: 'DeepSeek Harness',
          screen: 'granted', accessibility: 'granted',
        })}\n`)
      }
    }
  })
  sock.on('error', () => {})
})

await new Promise((resolve, reject) => {
  host.once('error', reject)
  host.listen(socketPort, '127.0.0.1', resolve)
})
env.DSH_ORB_SOCKET = `127.0.0.1:${socketPort}`
env.DSH_ORB_TOKEN = token

// The sandbox in the calling shell sets this, and Electron refuses to open a window with it: it
// degrades into plain Node and main.js fails on its first import.
delete env.ELECTRON_RUN_AS_NODE

console.log(`stub host on 127.0.0.1:${socketPort}, page debugging port ${port}`)

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

for (const [label, stream] of [['stdout', child.stdout], ['stderr', child.stderr]]) {
  stream.setEncoding('utf8')
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') console.log(`[${label}] ${line.trim()}`)
  })
}

async function targets() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const list = await response.json()
      if (list.length > 0) return list
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return []
}

const list = await targets()

/**
 * Attach to whichever page carries the ball, asked of the page itself.
 *
 * Matching on the target URL picks the wrong page: Chromium reports an empty `url` for the floating
 * window, so the test fails and the fallback lands on the observation frame, which has no ball.
 */
async function attachBall() {
  for (const target of list) {
    if (target.type !== 'page' || target.webSocketDebuggerUrl === undefined) continue
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    const opened = await new Promise((resolve) => {
      ws.addEventListener('open', () => resolve(true))
      ws.addEventListener('error', () => resolve(false))
    })
    if (!opened) continue
    let nextId = 1
    const waiting = new Map()
    const logs = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg)
        waiting.delete(msg.id)
        return
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        logs.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`.trim())
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        logs.push(`[console.error] ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
      }
    })
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = nextId += 1
      waiting.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
    await send('Runtime.enable')
    const probe = await send('Runtime.evaluate', {
      expression: `document.querySelector('#ball-gif') !== null`,
      returnByValue: true,
    })
    if (probe.result?.result?.value === true) return { ws, send, logs }
    ws.close()
  }
  return undefined
}

const page = await attachBall()
if (page === undefined) {
  console.error('\n*** no page with a ball — the helper never opened one ***')
  child.kill()
  host.close()
  process.exit(3)
}
console.log(`page: ${'file:///…/floating.html'}\n`)

const evaluate = async (expression) => {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

const SNAPSHOT = `(() => {
  const panel = document.querySelector('#panel')
  const b = panel ? panel.getBoundingClientRect() : null
  return JSON.stringify({
    body: document.body.className,
    expanded: document.body.classList.contains('expanded'),
    pinned: document.body.classList.contains('pinned'),
    panelHidden: panel ? panel.hidden : null,
    panelRect: b ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',') : null,
    panelText: panel ? String(panel.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null,
  })
})()`

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function snap(note) {
  const raw = await evaluate(SNAPSHOT)
  if (typeof raw !== 'string') {
    console.log(`  ${note} — snapshot failed: ${JSON.stringify(raw)}`)
    return undefined
  }
  const s = JSON.parse(raw)
  console.log(`  ${note}`)
  console.log(`      body=${JSON.stringify(s.body)}`)
  console.log(`      expanded=${s.expanded} pinned=${s.pinned} panelHidden=${s.panelHidden} panel=[${s.panelRect}]`)
  if (s.panelText) console.log(`      panel text: "${s.panelText}"`)
  return s
}

async function hoverBall() {
  return evaluate(`(() => {
    const ball = document.querySelector('#ball')
    if (!ball) return 'no ball'
    const b = ball.getBoundingClientRect()
    const at = { clientX: b.x + b.width / 2, clientY: b.y + b.height / 2 }
    document.body.dispatchEvent(new PointerEvent('pointerenter', {
      ...at, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    }))
    document.body.dispatchEvent(new PointerEvent('pointermove', {
      ...at, bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse',
    }))
    return at.clientX + ',' + at.clientY
  })()`)
}

async function unhover() {
  return evaluate(`(() => {
    document.body.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }))
    return 'left'
  })()`)
}

async function clickBall() {
  const spot = await evaluate(`(() => {
    const ball = document.querySelector('#ball')
    if (!ball) return null
    const b = ball.getBoundingClientRect()
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  })()`)
  if (spot === null || typeof spot !== 'object') return 'no ball'
  const { x, y } = spot
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  return `${x},${y}`
}

/** One leg: the name, what it did, and what the panel has to look like afterwards. */
const legs = []
function expect(name, state, wanted) {
  const misses = []
  for (const [key, value] of Object.entries(wanted)) {
    if (state === undefined) {
      misses.push(`${key} (no reading)`)
    } else if (state[key] !== value) {
      misses.push(`${key}=${JSON.stringify(state[key])}, wanted ${JSON.stringify(value)}`)
    }
  }
  legs.push({ name, misses })
  console.log(misses.length === 0 ? '      -> as expected' : `      -> WRONG: ${misses.join('; ')}`)
  console.log()
}

console.log('  ===== the panel, around the whole cycle =====\n')
await wait(1500)
expect('1. at rest', await snap('1. at rest (nothing near the ball)'),
  { expanded: false, panelHidden: true })

console.log(`  [pointer] onto the ball -> ${await hoverBall()}`)
await wait(900)
expect('2. pointer on the ball', await snap('2. pointer on the ball (0.9 s later)'),
  { expanded: true, panelHidden: false })

// The state is right, but "right" for a panel is also that it has something in it and the something
// is laid out where it belongs. A screenshot of the page at this instant is the only reading that
// can say that; `hidden=false` cannot.
{
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  const data = shot.result?.data
  if (typeof data === 'string') {
    writeFileSync(join(tmpdir(), 'orb-panel-open.png'), Buffer.from(data, 'base64'))
    console.log(`  screenshot of the open panel -> ${join(tmpdir(), 'orb-panel-open.png')}\n`)
  } else {
    console.log('  screenshot failed (no data in the reply)\n')
  }
}

console.log(`  [click] on the ball -> ${await clickBall()}`)
await wait(700)
expect('3. click pins it', await snap('3. after a click on the ball'),
  { expanded: true, pinned: true, panelHidden: false })

console.log(`  [click] again -> ${await clickBall()}`)
await wait(700)
expect('4. click releases the pin', await snap('4. after the second click'),
  { expanded: true, pinned: false, panelHidden: false })

console.log(`  [pointer] off the ball -> ${await unhover()}`)
await wait(1200)
expect('5. pointer off, unpinned', await snap('5. pointer off (1.2 s later)'),
  { expanded: false, pinned: false, panelHidden: true })

console.log(`  [pointer] back onto the ball -> ${await hoverBall()}`)
await wait(900)
expect('6. pointer back on', await snap('6. pointer back on the ball (0.9 s later)'),
  { expanded: true, panelHidden: false })

// The panel's own colours come from the app's theme, which the probe's helper does not have — so
// the run is repeated in the dark scheme the user sees, and typed into, because "it opens" is not
// the same as "it works".
await page.send('Emulation.setEmulatedMedia', {
  features: [{ name: 'prefers-color-scheme', value: 'dark' }],
})
await wait(500)
{
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  const data = shot.result?.data
  if (typeof data === 'string') {
    writeFileSync(join(tmpdir(), 'orb-panel-dark.png'), Buffer.from(data, 'base64'))
    console.log(`  screenshot in the dark scheme -> ${join(tmpdir(), 'orb-panel-dark.png')}`)
  }
}

console.log('  [typing] into the composer')
await evaluate(`(() => {
  const prompt = document.querySelector('#prompt')
  if (!prompt) return 'no prompt'
  prompt.focus()
  return 'focused'
})()`)
await page.send('Input.insertText', { text: '这条是恢复测试' })
await wait(400)
const typed = await evaluate(`(() => {
  const prompt = document.querySelector('#prompt')
  const send = document.querySelector('#send')
  return JSON.stringify({
    draft: prompt ? prompt.textContent : null,
    sendHidden: send ? send.hidden : null,
    sendDisabled: send ? send.disabled : null,
    body: document.body.className,
  })
})()`)
console.log(`      ${typed}`)
if (typeof typed === 'string') {
  const t = JSON.parse(typed)
  const ok = String(t.draft).includes('这条是恢复测试')
  console.log(ok ? '      -> the composer takes a draft' : '      -> WRONG: the draft did not land')
  legs.push({ name: '7. the composer takes a draft', misses: ok ? [] : ['draft missing'] })
}
{
  const shot = await page.send('Page.captureScreenshot', { format: 'png' })
  const data = shot.result?.data
  if (typeof data === 'string') {
    writeFileSync(join(tmpdir(), 'orb-panel-typed.png'), Buffer.from(data, 'base64'))
    console.log(`  screenshot with a draft -> ${join(tmpdir(), 'orb-panel-typed.png')}\n`)
  }
}

// The last leg: Enter is the send. A panel that opens and takes text but never sends is not the
// panel the user remembers, and the stub host is the only place that can say the frame left.
const before = hostSaw.length
await page.send('Input.dispatchKeyEvent', {
  type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
})
await page.send('Input.dispatchKeyEvent', {
  type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
})
await wait(800)
const sent = hostSaw.slice(before)
const left = sent.includes('prompt')
console.log(`  [enter] frames out of the page: ${sent.length > 0 ? sent.join(', ') : '(none)'}`)
console.log(left ? '      -> the draft was sent' : '      -> WRONG: nothing left the page')
legs.push({ name: '8. Enter sends the draft', misses: left ? [] : ['no prompt frame'] })

console.log('  ===== verdict =====')
const wrong = legs.filter((leg) => leg.misses.length > 0)
if (wrong.length === 0) {
  console.log(`  all ${legs.length} legs as expected — the panel comes out on hover, pins on a click,`)
  console.log('  and puts itself away when the pointer leaves.')
} else {
  for (const leg of wrong) console.log(`  ${leg.name}: ${leg.misses.join('; ')}`)
}
if (page.logs.length > 0) {
  console.log('\n  page errors (unfiltered):')
  for (const line of page.logs) console.log(`    ${line}`)
}

child.kill()
host.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  console.log(`  (scratch left at ${scratch})`)
}
process.exit(wrong.length === 0 ? 0 : 1)
