/**
 * Play one microphone file at the real helper and read back whether the wake word fired.
 *
 * This is the acceptance test for the doubled wake word, and it is a *behavioural* one: the isolated
 * helper is the installed bundle, the models are the installed models, the page is the real page, and
 * the microphone is real 16 kHz audio pushed in by Chromium's fake capture device. What it answers is
 * the only question that matters — does saying the phrase twice wake it, and does saying it once leave
 * it alone — and it answers it by watching the ball's own badge, not by re-deriving anything.
 *
 * The two runs are meant to be read as a pair. `wake-mic-doubled.wav` must fire and
 * `wake-mic-single.wav` must not; a run of one alone cannot distinguish a working model from an
 * engine that never started.
 *
 * The helper opens three pages and only the floating one has the badge, so the page is chosen by
 * asking each candidate about its own DOM (`wakePage`) rather than by URL. See there for the two
 * wrong runs that made this necessary.
 *
 * Usage:
 *   wake_phrase_verify.mjs --mic wake-mic-doubled.wav --expect fired [--port 9500] [--seconds 30]
 *   wake_phrase_verify.mjs --mic wake-mic-single.wav  --expect quiet [--port 9501]
 *
 * Exit code 0 when the expectation holds, 1 when it does not, 2 when the harness itself is broken
 * (no page, no model, engine never reached `listening`) — a harness failure must never be reported as
 * a verdict about the product.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const MAIN = join(INSTALLED, 'lib', 'main.js')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const mic = resolve(arg('mic', ''))
const expect = arg('expect', '')
const port = arg('port', '9500')
const seconds = Number(arg('seconds', '30'))

if (!existsSync(mic)) {
  console.error(`mic file not found: ${mic}`)
  process.exit(2)
}
if (expect !== 'fired' && expect !== 'quiet') {
  console.error('--expect must be "fired" or "quiet"')
  process.exit(2)
}
if (!existsSync(MAIN)) {
  console.error(`installed helper not found: ${MAIN}`)
  process.exit(2)
}

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
// `enabled` is forced on here rather than by editing the profile: the file on disk is whatever the
// host last wrote, and a page told the wake word is off publishes `disabled` and sits there saying
// nothing for the whole run — which reads exactly like a model that never fires.
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: settings.assetDirectory,
  DSH_ORB_WAKE: JSON.stringify({
    enabled: true,
    keyword: settings.keyword,
    threshold: settings.threshold,
    autoExpandOnWake: settings.autoExpandOnWake,
    // Dictation off: this run is about the detection, and leaving the recorder armed would make the
    // page chase a transcript it has no host to answer.
    dictation: { ...settings.dictation, enabled: false },
  }),
}
delete env.ELECTRON_RUN_AS_NODE

console.log(`mic:        ${mic}`)
console.log(`expect:     ${expect}`)
console.log(`keyword:    ${settings.keyword} @ threshold ${settings.threshold}`)
console.log(`assets:     ${settings.assetDirectory}`)

// The helper refuses to open a window without a socket endpoint to dial, so one exists and never
// answers. Nothing here needs the host: a wake word is detected on this machine or not at all.
const socketPort = 19700 + (process.pid % 200)
const host = createServer((sock) => {
  sock.on('data', () => {})
  sock.on('error', () => {})
})
await new Promise((ok, fail) => {
  host.once('error', fail)
  host.listen(socketPort, '127.0.0.1', ok)
})
env.DSH_ORB_SOCKET = `127.0.0.1:${socketPort}`
env.DSH_ORB_TOKEN = `phrase-verify-${process.pid}`

const scratch = mkdtempSync(join(tmpdir(), 'orb-phrase-'))

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  // Chromium wants all three: the fake device to exist, the file to be its source, and the capture
  // grant pre-answered so the page's getUserMedia resolves without a user.
  '--use-fake-device-for-media-stream',
  // Exactly one `--use-file-for-fake-audio-capture`, and it carries the path. Chromium resolves a
  // switch to its *first* occurrence, so also passing the bare spelling (value = "") silently wins
  // and the fake mic plays nothing — which looks exactly like a model that never fires.
  `--use-file-for-fake-audio-capture=${mic}`,
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

const log = []
const relay = (label, stream) => {
  stream.setEncoding('utf8')
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const text = line.trim()
      if (text === '') continue
      log.push(`[${label}] ${text}`)
    }
  })
}
relay('out', child.stdout)
relay('err', child.stderr)

async function listTargets() {
  try {
    return await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  } catch {
    return []
  }
}

/** One CDP session, with its own error collector and a `send` that resolves on the reply. */
async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  const errors = []
  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.exception?.description
        ?? msg.params.exceptionDetails.text)
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
  })
  await new Promise((ok, fail) => {
    ws.addEventListener('open', ok)
    ws.addEventListener('error', fail)
  })
  const send = (method, params = {}) => new Promise((done) => {
    const id = nextId += 1
    pending.set(id, done)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  return { ws, send, errors }
}

/**
 * The page that owns the orb, found by asking each candidate about its own DOM.
 *
 * Not by URL, which is what this used to do and why every run reported an empty badge. The helper
 * opens three pages, and Chromium reports the floating one with an **empty** `url` while the
 * observation frame and the selection toolbar have theirs - so a `/floating|shell/` match skipped the
 * only page that mattered and the fallback took the first page in the list, which has no badge. The
 * run then read `never fired, engine listening NO` and the harness called it BROKEN, which was
 * correct of it and pointed at the wrong thing.
 */
async function wakePage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const target of await listTargets()) {
      if (target.type !== 'page' || target.webSocketDebuggerUrl === undefined) continue
      // A target that is still coming up can fail to attach. That is not a verdict about the orb, so
      // it is skipped and the next poll tries again rather than taking the run down with it.
      let page
      try {
        page = await attach(target)
      } catch {
        continue
      }
      const probe = await page.send('Runtime.evaluate', {
        expression: `document.querySelector('#wake-badge') !== null`,
        returnByValue: true,
      })
      if (probe.result?.result?.value === true) return page
      page.ws.close()
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return undefined
}

/** Shut everything down and report. One exit path, so no run can end without its verdict printed. */
async function finish(code, lines) {
  child.kill()
  host.close()
  await new Promise((r) => setTimeout(r, 400))
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Best effort; a leftover temp directory is not worth a failed run.
  }
  console.log(lines.join('\n'))
  process.exit(code)
}

const page = await wakePage()
if (page === undefined) {
  await finish(2, ['\n*** no page ever exposed #wake-badge — the helper never started the orb ***'])
}
const { ws, send, errors: pageErrors } = page

const STATE = `(() => {
  const badge = document.querySelector('#wake-badge')
  return JSON.stringify({
    bodyClass: document.body.className,
    badge: badge ? badge.textContent : null,
  })
})()`

const timeline = []
let listeningSeen = false
let detectedAtMs
const started = Date.now()

while (Date.now() - started < seconds * 1000) {
  const probe = await send('Runtime.evaluate', { expression: STATE, returnByValue: true })
  const raw = probe.result?.result?.value
  if (typeof raw === 'string') {
    const snap = JSON.parse(raw)
    const badge = snap.badge ?? ''
    const last = timeline.at(-1)
    if (last === undefined || last.badge !== badge) {
      timeline.push({ at: Math.round((Date.now() - started) / 1000), badge, bodyClass: snap.bodyClass })
      console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${badge}`)
    }
    if (badge.includes('语音唤醒已开启')) listeningSeen = true
    if (badge.includes('已听到唤醒词') && detectedAtMs === undefined) {
      detectedAtMs = Date.now() - started
      break
    }
  }
  await new Promise((r) => setTimeout(r, 250))
}

ws.close()

const fired = detectedAtMs !== undefined
// Errors are read from the badge first, because that is the engine's own report of itself. Page
// console output is only consulted when it names the wake word: this harness deliberately leaves the
// host socket unanswered, so a page that grumbles about a missing backend is describing the harness,
// and treating that as an engine failure would fail every run for the wrong reason.
const badgeError = timeline.find((row) => /不可用|失败|错误/.test(row.badge ?? ''))
const wakePageErrors = pageErrors.filter((text) => /wake|唤醒/i.test(text))
const engineErrored = badgeError !== undefined || wakePageErrors.length > 0

const report = [
  '',
  '======================= result =======================',
  `  mic              ${mic.split(/[\\/]/).pop()}`,
  `  expected         ${expect}`,
  `  observed         ${fired ? `fired after ${detectedAtMs} ms` : 'never fired'}`,
  `  engine listening ${listeningSeen ? 'yes' : 'NO'}`,
  `  engine errors    ${engineErrored
    ? badgeError?.badge ?? wakePageErrors.join(' | ')
    : 'none'}`,
  '  badge timeline  ',
  ...timeline.map((row) => `    ${String(row.at).padStart(3)}s  ${row.badge || '(empty)'}`),
  '',
  ...log.slice(-12).map((line) => `  ${line}`),
]

if (!listeningSeen) {
  report.push('', '*** THE ENGINE NEVER REPORTED `listening` — this run proves NOTHING ***')
  report.push('    (a harness failure, not a verdict: check the assets path and that the models loaded)')
  await finish(2, report)
}
if (engineErrored) {
  report.push('', '*** the engine reported an error — the run is not a verdict about the phrase ***')
  await finish(2, report)
}

const passed = expect === 'fired' ? fired : !fired
report.push('', passed
  ? `PASS — the phrase was expected to ${expect === 'fired' ? 'wake the orb' : 'be ignored'}, and it was.`
  : `FAIL — expected the orb to ${expect === 'fired' ? 'wake' : 'stay quiet'} on this file.`)
await finish(passed ? 0 : 1, report)
