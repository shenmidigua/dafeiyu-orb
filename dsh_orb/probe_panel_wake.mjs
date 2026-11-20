/**
 * Watch the panel through a spoken wake, and name whoever puts it away.
 *
 * The restore of the black panel put `setExpanded(true)` back on the wake path. In a probe run the
 * panel then opened and closed again a moment later, over and over, with no pointer anywhere near
 * the ball — and the only path that closes it is `leaveUi()`. Reading the code cannot say which of
 * its callers fired, and the wake engine's own state is not visible from outside, so this hooks the
 * one DOM call every collapse makes (`classList.remove('expanded')`) and records the stack behind
 * it. The stack names the function, and the function names the reason.
 *
 * The microphone is a file played through Chromium's fake capture device, so no real input is used.
 *
 * Usage: node probe_panel_wake.mjs [port] [wav]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const MAIN = join(INSTALLED, 'lib', 'main.js')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')

const port = process.argv[2] ?? '9560'
const mic = process.argv[3] ?? join(HOME, 'Desktop', 'dsh-orb-cordis', 'dsh_orb', 'two_round_mic.wav')

for (const [label, path] of [['electron', RUNTIME], ['installed helper', MAIN], ['profile', PROFILE], ['wav', mic]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`)
    process.exit(2)
  }
}

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
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

const scratch = mkdtempSync(join(tmpdir(), 'orb-panel-wake-'))
const token = 'probe-token'
const socketPort = 19800 + (process.pid % 150)

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
      hostSaw.push(message?.type ?? '?')
      if (message?.type === 'tcc') {
        sock.write(`${JSON.stringify({
          type: 'tcc', applicable: false, appName: 'DeepSeek Harness',
          screen: 'granted', accessibility: 'granted',
        })}\n`)
      }
      if (message?.type === 'transcribe') {
        // Answer, or the page parks in `transcribing` forever and no turn can start.
        setTimeout(() => {
          sock.write(`${JSON.stringify({ type: 'transcript', id: message.id, text: '你好' })}\n`)
        }, 250)
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
delete env.ELECTRON_RUN_AS_NODE

console.log(`wake: keyword=${settings.keyword} autoExpand=${settings.autoExpandOnWake}`)
console.log(`wav: ${mic}`)
console.log(`stub host on 127.0.0.1:${socketPort}, page debugging port ${port}\n`)

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${mic}`,
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  for (const line of chunk.split('\n')) if (line.trim() !== '') console.log(`[stderr] ${line.trim()}`)
})

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
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id !== undefined && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg)
        waiting.delete(msg.id)
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
    if (probe.result?.result?.value === true) return { send }
    ws.close()
  }
  return undefined
}

const page = await attachBall()
if (page === undefined) {
  console.error('\n*** no page with a ball ***')
  child.kill()
  host.close()
  process.exit(3)
}

const evaluate = async (expression) => {
  const res = await page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

// The hook: every collapse removes `expanded` off the body, and this records who did it. `add` is
// hooked too, so an opening is on the same timeline and the two can be paired.
const HOOK = `(() => {
  if (window.__panelTrace !== undefined) return 'already'
  window.__panelTrace = []
  const stamp = (what, stack) => {
    const frames = String(stack).split('\\n').slice(1)
      .map((line) => line.trim())
      .filter((line) => line.includes('shell.js') || line.includes('at '))
      .map((line) => line.replace(/^at /, '').replace(/\\(file:[^)]*\\)/, '').replace(/:\\d+:\\d+$/, ''))
      .filter((line) => !line.includes('stamp') && !line.includes('DOMTokenList'))
    window.__panelTrace.push({ t: Date.now(), what, frames: frames.slice(0, 6) })
  }
  const add = DOMTokenList.prototype.add
  const remove = DOMTokenList.prototype.remove
  const toggle = DOMTokenList.prototype.toggle
  DOMTokenList.prototype.add = function (...args) {
    if (this === document.body.classList && args.includes('expanded')) stamp('+expanded', new Error().stack)
    return add.apply(this, args)
  }
  DOMTokenList.prototype.remove = function (...args) {
    if (this === document.body.classList && args.includes('expanded')) stamp('-expanded', new Error().stack)
    return remove.apply(this, args)
  }
  DOMTokenList.prototype.toggle = function (token, force) {
    if (this === document.body.classList && token === 'expanded') stamp('~expanded', new Error().stack)
    return toggle.apply(this, arguments)
  }
  return 'hooked'
})()`

console.log(`hook: ${JSON.stringify(await evaluate(HOOK))}\n`)

// What the page is actually being told, at the capture phase: a drag that starts by itself has to
// come from a pointer event, and whether that event is trusted says whether a real mouse produced
// it. Counted rather than printed one by one — a moving pointer would flood the trace.
const EVENTS = `(() => {
  window.__panelEvents = []
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'click', 'pointerenter', 'pointerleave']) {
    window.addEventListener(type, (event) => {
      if (type === 'pointermove' && window.__panelEvents.length > 4000) return
      const id = event.target && event.target.id ? '#' + event.target.id : (event.target && event.target.tagName) || '?'
      window.__panelEvents.push({
        t: Date.now(), type, id, trusted: event.isTrusted === true,
        x: Math.round(event.screenX ?? -1), y: Math.round(event.screenY ?? -1),
      })
    }, { capture: true })
  }
  return 'listening'
})()`
console.log(`events: ${JSON.stringify(await evaluate(EVENTS))}\n`)

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const started = Date.now()

console.log('  ===== the panel, through one spoken wake =====')
let last = ''
const deadline = started + 45000
while (Date.now() < deadline) {
  const raw = await evaluate(`(() => {
    const panel = document.querySelector('#panel')
    return JSON.stringify({
      body: document.body.className,
      panelHidden: panel ? panel.hidden : null,
      badge: document.querySelector('#wake-badge') ? document.querySelector('#wake-badge').textContent : '',
    })
  })()`)
  if (typeof raw === 'string') {
    const s = JSON.parse(raw)
    const line = `body=${JSON.stringify(s.body)} panelHidden=${s.panelHidden} badge=${JSON.stringify(String(s.badge).slice(0, 30))}`
    if (line !== last) {
      const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5)
      console.log(`  [${at}s] ${line}`)
      last = line
    }
  }
  await wait(200)
}

const trace = await evaluate(`JSON.stringify(window.__panelTrace ?? [])`)
const events = await evaluate(`JSON.stringify((window.__panelEvents ?? []).filter((e) =>
  e.type !== 'pointermove' || e.trusted !== true).slice(0, 40))`)
if (typeof events === 'string') {
  const list = JSON.parse(events)
  console.log(`\n  ===== pointer traffic that was not a plain move (${list.length} shown) =====`)
  for (const event of list) {
    const at = ((event.t - started) / 1000).toFixed(1).padStart(5)
    console.log(`  [${at}s] ${event.type} on ${event.id} trusted=${event.trusted} at ${event.x},${event.y}`)
  }
}
const counts = await evaluate(`(() => {
  const all = window.__panelEvents ?? []
  const by = {}
  for (const e of all) by[e.type + (e.trusted ? '' : '(synthetic)')] = (by[e.type + (e.trusted ? '' : '(synthetic)')] ?? 0) + 1
  return JSON.stringify(by)
})()`)
console.log(`  counts: ${counts}`)

console.log('\n  ===== who toggled `expanded` =====')
if (typeof trace !== 'string') {
  console.log(`  trace unavailable: ${JSON.stringify(trace)}`)
} else {
  const events = JSON.parse(trace)
  console.log(`  ${events.length} transitions`)
  for (const event of events) {
    const at = ((event.t - started) / 1000).toFixed(1).padStart(5)
    console.log(`\n  [${at}s] ${event.what}`)
    for (const frame of event.frames) console.log(`      ${frame}`)
  }
}
console.log(`\n  host frames seen: ${[...new Set(hostSaw)].join(', ')}`)

child.kill()
host.close()
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  console.log(`  (scratch left at ${scratch})`)
}
process.exit(0)
