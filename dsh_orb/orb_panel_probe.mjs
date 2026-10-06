/**
 * Drive a whole reply through the real ball page and watch what the panel does when it ends.
 *
 * The complaint is that the panel vanishes when a reply finishes and then cannot be put away
 * again. Both halves of that are about state the page keeps in closures - `expanded`, `pinned`,
 * `running` - and all three are mirrored onto `document.body`'s class list, which is readable from
 * outside. So this does not infer the state from pixels: it reads the flags the collapse paths
 * actually test, at each step of one turn.
 *
 * The turn is driven through the real socket the host uses, with the same frames the host sends
 * on a real run, in the same order: `turn running:true`, then blocks, then `turn running:false`.
 * The last one is the interesting one - it is the only frame that can play the finished-task
 * frame, and it is what "the reply finished" means to the page.
 *
 * The pointer is synthetic and dispatched into the page rather than moved on the desktop, so the
 * user's own cursor and session are not touched. Nothing is asserted: a harness that decides the
 * answer can be wrong in the same direction as the bug. It prints the trail.
 *
 * Usage: node orb_panel_probe.mjs [port]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

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
const port = process.argv[2] ?? '9540'

/**
 * Drive the run through the microphone instead of a synthetic pointer.
 *
 * The synthetic-pointer run put the pointer on the ball and took it off again, which is the shape
 * of a person using the mouse. The report is about the other shape: the ball is woken by voice, so
 * nobody is touching it, the panel opens on its own, a reply arrives while the cursor is somewhere
 * else entirely - and whatever the panel then does it does without a pointer in the story.
 */
const micArg = process.argv[3]
const mic = micArg !== undefined && micArg !== '--synthetic'
  ? micArg
  : join(HOME, 'Desktop', 'dsh-orb-cordis', 'dsh_orb', 'two_round_mic.wav')
const useMic = micArg !== '--synthetic' && existsSync(mic)

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

const scratch = mkdtempSync(join(tmpdir(), 'orb-panel-probe-'))
const token = 'probe-token'
const socketPort = 19600 + (process.pid % 300)

/** The live host connection, kept so frames can be sent on demand rather than only in reply. */
let pageSock = null
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
      const type = message?.type ?? '?'
      hostSaw.push(type)
      if (type === 'tcc' || type === 'tcc-open') {
        sock.write(`${JSON.stringify({
          type: 'tcc', applicable: false, appName: 'DeepSeek Harness',
          screen: 'granted', accessibility: 'granted',
        })}\n`)
        continue
      }
      if (type === 'chrome-windows') continue
      if (type === 'transcribe') {
        // The host answers with text for the audio it was just handed. Without this the page parks in
        // `transcribing` forever and nothing is ever sent, which is a silent harness fault: it looks
        // exactly like a recorder that heard nothing.
        const id = message.id
        console.log(`  [host] transcribe id=${id}`)
        setTimeout(() => {
          sock.write(`${JSON.stringify({ type: 'transcript', id, text: '帮我看一下桌面上的这个文件' })}\n`)
        }, 250)
        continue
      }
      if (type === 'prompt') {
        // A real host acknowledges the prompt and streams a turn back, and the frames it ends with
        // are the point of this probe: `turn running:true`, then blocks, then `turn running:false`.
        // The last one is what "the reply finished" means to the page, and the only frame that can
        // play the finished-task frame.
        console.log(`  [host] prompt received: ${JSON.stringify(message.text ?? '')}`)
        const reply = () => {
          const at = (ms, payload) => setTimeout(() => {
            sock.write(`${JSON.stringify(payload)}\n`)
          }, ms)
          at(300, { type: 'turn', running: true })
          at(800, {
            type: 'block', key: 'reply-1', kind: 'assistant', text: '好的，我看到了。', running: true,
          })
          at(1700, {
            type: 'block', key: 'reply-1', kind: 'assistant',
            text: '好的，我看完了，没有什么问题。', running: false, response: true,
          })
          at(2300, { type: 'turn', running: false })
        }
        reply()
        continue
      }
      // Anything else is left unanswered; the observation does not depend on it.
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

// The sandbox sets this, and Electron refuses to open a window when it is present: it degrades
// into plain Node and main.js fails on its first import.
delete env.ELECTRON_RUN_AS_NODE

console.log(`profile: keyword=${settings.keyword} threshold=${settings.threshold} autoExpand=${settings.autoExpandOnWake}`)
console.log(`stub host on 127.0.0.1:${socketPort}, page debugging port ${port}`)

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  // Chromium wants all three together: the fake device to exist, the file to be its source, and
  // the capture to be labelled NoloCapture so `getUserMedia` resolves the way it does on the
  // machine. Two of the three (or the switch twice, once bare) is how an earlier harness came to
  // report "the model never fires" about a microphone that was never playing.
  ...(useMic ? [
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${mic}`,
    '--use-fake-ui-for-media-stream',
  ] : []),
  '--autoplay-policy=no-user-gesture-required',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const relay = (label, stream) => {
  stream.setEncoding('utf8')
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') console.log(`[${label}] ${line.trim()}`)
  })
}
relay('stdout', child.stdout)
relay('stderr', child.stderr)

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
 * Matching on the target URL is what an earlier version did, and it silently attached to the
 * wrong page: Chromium reports an empty `url` for the floating page, so the URL test failed and
 * the fallback picked the first page in the list - the observation frame, which has no ball.
 * Every reading after that was about a page the user never sees.
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
    if (probe.result?.result?.value === true) return { ws, send, logs, url: target.url }
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
console.log(`page: ${page.url === '' ? '(empty url reported)' : page.url}`)
console.log()

const evaluate = async (expression) => {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

/**
 * The state the collapse paths actually test, plus the pixels that would explain a complaint
 * about the panel "vanishing": where each element is, and which image the ball is wearing.
 */
const SNAPSHOT = `(() => {
  const r = (el) => {
    if (!el) return null
    const b = el.getBoundingClientRect()
    if (b.width === 0 && b.height === 0) return 'zero'
    return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)].join(',')
  }
  const gif = document.querySelector('#ball-gif')
  return JSON.stringify({
    body: document.body.className,
    expanded: document.body.classList.contains('expanded'),
    pinned: document.body.classList.contains('pinned'),
    running: document.body.classList.contains('running'),
    docked: document.body.classList.contains('docked'),
    // asking() is "pending !== undefined", and the page mirrors it onto the body. It is the one
    // flag a spoken turn can set with no pointer involved, and it gates every collapse path.
    asking: document.body.classList.contains('asking'),
    questionHidden: document.querySelector('#question') ? document.querySelector('#question').hidden : null,
    panelHidden: document.querySelector('#panel') ? document.querySelector('#panel').hidden : null,
    panelRect: r(document.querySelector('#panel')),
    ballRect: r(document.querySelector('#ball')),
    stopHidden: document.querySelector('#stop') ? document.querySelector('#stop').hidden : null,
    gif: gif ? String(gif.getAttribute('src') ?? '').slice(-28) : null,
    gifMode: gif ? (gif.dataset.mode ?? '') : null,
    gifLoaded: gif ? gif.naturalWidth > 0 : null,
    badge: document.querySelector('#wake-badge') ? document.querySelector('#wake-badge').textContent : null,
  })
})()`

let step = 0
const trail = []
async function snap(note) {
  step += 1
  const raw = await evaluate(SNAPSHOT)
  if (typeof raw !== 'string') {
    console.log(`  ${String(step).padStart(2)}. ${note} — snapshot failed: ${JSON.stringify(raw)}`)
    return
  }
  const s = JSON.parse(raw)
  trail.push({ step, note, ...s })
  console.log(`  ${String(step).padStart(2)}. ${note}`)
  console.log(`      body=${JSON.stringify(s.body)}`)
  console.log(`      expanded=${s.expanded} pinned=${s.pinned} running=${s.running} docked=${s.docked}`
    + ` asking=${s.asking} questionHidden=${s.questionHidden}`)
  console.log(`      panelHidden=${s.panelHidden} stopHidden=${s.stopHidden}`)
  console.log(`      ball=[${s.ballRect}] panel=[${s.panelRect}]`)
  console.log(`      gif=${s.gif} mode=${JSON.stringify(s.gifMode)} loaded=${s.gifLoaded}`)
  return s
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Put a synthetic pointer on the ball, without moving the user's cursor. */
async function hoverBall() {
  const result = await evaluate(`(() => {
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
  return result
}

/** And take it off again, which is `leaveUi()` and therefore `scheduleCollapse()`. */
async function unhover() {
  return evaluate(`(() => {
    document.body.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse' }))
    return 'left'
  })()`)
}

const frame = (payload) => {
  if (pageSock === null) return 'no socket'
  pageSock.write(`${JSON.stringify(payload)}\n`)
  return 'sent'
}

/**
 * Watch the ball through a whole spoken turn, printing every change of state.
 *
 * Polling rather than waiting for a marker: what is being looked for is a state that should not
 * persist, and a state that should not persist has no event to wait on. Every reading is the same
 * snapshot, so a change anywhere - the body's classes, the panel's own `hidden`, which image the
 * ball wears, whether the ball is still loaded - shows up as one line.
 */
async function runMicWatch() {
  console.log('  ===== the ball, through one whole spoken turn =====')
  console.log(`  mic: ${mic}`)
  console.log()
  let last = ''
  let quietSince
  const started = Date.now()
  const deadline = started + 75000
  while (Date.now() < deadline) {
    const raw = await evaluate(SNAPSHOT)
    if (typeof raw === 'string') {
      const s = JSON.parse(raw)
      const line = `${JSON.stringify(s.body)} | expanded=${s.expanded} pinned=${s.pinned}`
        + ` running=${s.running} panelHidden=${s.panelHidden} stopHidden=${s.stopHidden}`
        + ` gif=${String(s.gif).slice(-16)} mode=${s.gifMode} loaded=${s.gifLoaded}`
      if (line !== last) {
        const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5)
        console.log(`  [${at}s] ${line}`)
        last = line
        quietSince = undefined
      } else if (quietSince === undefined) {
        quietSince = Date.now()
      }
    }
    // Nothing has moved for a while and the microphone ran out long ago: stop rather than sit on
    // the deadline.
    if (quietSince !== undefined && Date.now() - quietSince > 12000) break
    await wait(250)
  }
  console.log()
  console.log(`  host frames seen: ${[...new Set(hostSaw)].join(', ')}`)
  if (page.logs.length > 0) {
    console.log('  page errors (unfiltered):')
    for (const line of page.logs) console.log(`    ${line}`)
  }
}

if (useMic) {
  await runMicWatch()
  child.kill()
  host.close()
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    console.log(`  (scratch left at ${scratch})`)
  }
  process.exit(0)
}

/**
 * A question card, and whether the panel can close while one is up.
 *
 * This is the only state a spoken turn can put the page in without a pointer being involved: the
 * ball may be woken by voice, the panel opens on its own, and `ask_user_question` makes the page
 * hold a question. `asking()` is then true, and `asking()` gates both collapse paths - so if the
 * card outlives the turn, the panel cannot be put away by anything at all.
 *
 * The second half is the interesting one: it clears the card and asks whether the panel becomes
 * closable again. A card that can be cleared is a card the user can get out of; one that cannot is
 * the report.
 */
if (process.argv.includes('--question')) {
  console.log('  ===== a question card, and whether the panel closes under it =====')
  await snap('at rest')

  console.log(`\n  [pointer] onto the ball -> ${await hoverBall()}`)
  await wait(600)
  await snap('pointer on the ball')

  const card = {
    type: 'question',
    id: 'q-probe-1',
    questions: [{
      question: '你指的是桌面上的哪个文件？',
      header: '文件',
      options: [{ label: '第一个' }, { label: '第二个' }],
      multiSelect: false,
    }],
  }
  console.log(`\n  [host] question -> ${frame(card)}`)
  await wait(700)
  await snap('question card up')

  console.log(`\n  [host] turn running:false, the reply is over -> ${frame({ type: 'turn', running: false })}`)
  await wait(1200)
  await snap('reply over, card still up')

  console.log(`\n  [pointer] off the ball -> ${await unhover()}`)
  await wait(1500)
  await snap('pointer left, collapse expected')

  console.log(`\n  [host] question-clear -> ${frame({ type: 'question-clear', id: 'q-probe-1' })}`)
  await wait(500)
  await snap('card cleared')

  console.log(`\n  [pointer] onto the ball and off again -> ${await hoverBall()}`)
  await wait(600)
  await unhover()
  await wait(1500)
  await snap('after clearing, pointer left again')

  child.kill()
  host.close()
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    console.log(`  (scratch left at ${scratch})`)
  }
  process.exit(0)
}

console.log('  ===== the panel, through one whole reply =====')
await snap('at rest')

console.log(`\n  [pointer] onto the ball -> ${await hoverBall()}`)
await wait(600)
await snap('pointer on the ball')

console.log(`\n  [host] turn running:true -> ${frame({ type: 'turn', running: true })}`)
await wait(400)
await snap('turn started')

console.log(`\n  [host] block: user -> ${frame({
  type: 'block', key: 'user-1', kind: 'user', text: '[语音] 帮我看一下这个', running: false,
})}`)
await wait(300)
await snap('user block landed')

console.log(`\n  [host] block: assistant (streaming) -> ${frame({
  type: 'block', key: 'reply-1', kind: 'assistant', text: '好的，我看一下。', running: true,
})}`)
await wait(400)
await snap('reply streaming')

console.log(`\n  [host] block: assistant (settled) -> ${frame({
  type: 'block', key: 'reply-1', kind: 'assistant', text: '好的，我看了一下，没什么问题。', running: false, response: true,
})}`)
await wait(400)
await snap('reply settled')

console.log(`\n  [host] turn running:false -> ${frame({ type: 'turn', running: false })}`)
await wait(1400)
await snap('REPLY FINISHED (1.4 s later)')

/** A real click on the ball, through the same input path a person's mouse takes. */
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
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  })
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  })
  return `${x},${y}`
}

console.log(`\n  [click] on the ball, the way a person puts the panel away -> ${await clickBall()}`)
await wait(700)
await snap('after a click on the ball')

console.log(`\n  [pointer] off the ball -> ${await unhover()}`)
await wait(900)
const afterLeave = await snap('pointer left, collapse expected (0.9 s later)')

await wait(2500)
await snap('2.5 s after that, still watching')

console.log(`\n  [click] on the ball again, to release the pin -> ${await clickBall()}`)
await wait(700)
await snap('after the second click')

console.log()
console.log('  ===== verdict on this run =====')
const stuck = []
if (afterLeave !== undefined && afterLeave.expanded) stuck.push('expanded stayed true after the pointer left')
if (afterLeave !== undefined && afterLeave.panelHidden === false) stuck.push('panel stayed visible after the pointer left')
if (afterLeave !== undefined && afterLeave.pinned) stuck.push('pinned is stuck on')
if (afterLeave !== undefined && afterLeave.running) stuck.push('running is stuck on')
if (stuck.length === 0) {
  console.log('  the panel put itself away as expected:')
  console.log(`    expanded=${afterLeave?.expanded} panelHidden=${afterLeave?.panelHidden} body=${JSON.stringify(afterLeave?.body)}`)
} else {
  console.log('  THE PANEL DID NOT PUT ITSELF AWAY:')
  for (const line of stuck) console.log(`    - ${line}`)
}
if (page.logs.length > 0) {
  console.log()
  console.log('  page errors (unfiltered):')
  for (const line of page.logs) console.log(`    ${line}`)
}

console.log()
console.log(`  host frames seen: ${[...new Set(hostSaw)].join(', ')}`)

child.kill()
host.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  console.log(`  (scratch left at ${scratch})`)
}
process.exit(0)
