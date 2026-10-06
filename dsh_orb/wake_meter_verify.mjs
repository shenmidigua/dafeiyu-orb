/**
 * Play a microphone file at the real helper and read back what the wake meter drew.
 *
 * Same harness as `wake_phrase_verify.mjs` — the installed bundle, the installed models, the real
 * page, real 16 kHz audio through Chromium's fake capture device — but it watches the meter instead
 * of the badge. The question it answers is what the meter is *for*: a user staring at a ball that
 * either ignored them or woke for no reason wants to see the score, and "the score" only means
 * something if the number on screen came from the engine and the bar is as long as the number says.
 *
 * The page records its own meter rather than being polled from here. A window scores once per
 * 128 ms, so an external poll at a comfortable rate would step straight over the single window that
 * completes a run — and the run completing is the one thing worth seeing. `setInterval` at 40 ms
 * inside the page catches it.
 *
 * Usage:
 *   wake_meter_verify.mjs --mic wake-mic-doubled.wav --expect fired [--port 9520] [--seconds 30]
 *   wake_meter_verify.mjs --mic wake-mic-single.wav  --expect quiet
 *
 * Exit code 0 when the expectation holds, 1 when it does not, 2 when the harness itself is broken
 * (no page, no meter, engine never reached `listening`) — a harness failure must never be reported as
 * a verdict about the product.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
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
const port = arg('port', '9520')
const seconds = Number(arg('seconds', '30'))
/** Optional: a PNG of the moment the bar crosses, which is what the meter looks like in use. */
const shot = arg('shot', '')

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
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: settings.assetDirectory,
  DSH_ORB_WAKE: JSON.stringify({
    enabled: true,
    keyword: settings.keyword,
    threshold: settings.threshold,
    autoExpandOnWake: settings.autoExpandOnWake,
    dictation: { ...settings.dictation, enabled: false },
  }),
}
delete env.ELECTRON_RUN_AS_NODE

const threshold = Number(settings.threshold)
console.log(`mic:        ${mic}`)
console.log(`expect:     ${expect}`)
console.log(`keyword:    ${settings.keyword} @ threshold ${threshold}`)

const socketPort = 19900 + (process.pid % 200)
const host = createServer((sock) => {
  sock.on('data', () => {})
  sock.on('error', () => {})
})
await new Promise((ok, fail) => {
  host.once('error', fail)
  host.listen(socketPort, '127.0.0.1', ok)
})
env.DSH_ORB_SOCKET = `127.0.0.1:${socketPort}`
env.DSH_ORB_TOKEN = `meter-verify-${process.pid}`

const scratch = mkdtempSync(join(tmpdir(), 'orb-meter-'))

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--use-fake-device-for-media-stream',
  // Exactly one `--use-file-for-fake-audio-capture`, and it carries the path: Chromium resolves a
  // switch to its *first* occurrence, so a bare spelling would win with an empty value and the fake
  // mic would play nothing.
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
      if (text !== '') log.push(`[${label}] ${text}`)
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
 * Not by URL: the helper opens three pages and Chromium reports the floating one with an **empty**
 * `url`, so a `/floating|shell/` match skips the only page that matters.
 */
async function orbPage() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    for (const target of await listTargets()) {
      if (target.type !== 'page' || target.webSocketDebuggerUrl === undefined) continue
      let page
      try {
        page = await attach(target)
      } catch {
        continue
      }
      const probe = await page.send('Runtime.evaluate', {
        expression: `document.querySelector('#wake-meter') !== null`,
        returnByValue: true,
      })
      if (probe.result?.result?.value === true) return page
      page.ws.close()
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return undefined
}

/**
 * The recorder, installed into the page.
 *
 * It keeps the extremes rather than a log, because a log at 40 ms for 30 s is 750 rows nobody reads
 * and the interesting events are three numbers. It also captures the *geometry* on every tick: the
 * filled width in pixels against the track's own width is the only evidence that the bar the user
 * sees is the score the engine reported, and reading the CSS variable back would only prove the
 * variable was set.
 */
const RECORDER = `(() => {
  const state = {
    ticks: 0,
    seen: false,
    hiddenTicks: 0,
    peakScore: 0,
    peakRatio: 0,
    hotSeen: false,
    maxLit: 0,
    scoreAtMaxLit: 0,
    readouts: [],
    geometry: null,
    dotCount: 0,
    thresholdVar: null,
    lineOffsetPx: null,
  }
  window.__wakeMeter = state
  const tick = () => {
    const meter = document.querySelector('#wake-meter')
    if (meter === null) return
    state.ticks += 1
    if (meter.hidden) { state.hiddenTicks += 1; return }
    state.seen = true
    const track = meter.querySelector('#wake-meter-track')
    const fill = meter.querySelector('#wake-meter-fill')
    const line = meter.querySelector('#wake-meter-line')
    const ball = document.querySelector('#ball')
    const dots = meter.querySelectorAll('.wake-meter-dot')
    state.dotCount = dots.length
    let lit = 0
    for (const dot of dots) if (dot.classList.contains('on')) lit += 1
    const score = Number(meter.style.getPropertyValue('--wake-score') || '0')
    const trackRect = track ? track.getBoundingClientRect() : null
    const fillRect = fill ? fill.getBoundingClientRect() : null
    const ratio = trackRect && trackRect.width > 0 && fillRect
      ? fillRect.width / trackRect.width
      : 0
    if (Number.isFinite(score) && score > state.peakScore) state.peakScore = score
    if (Number.isFinite(ratio) && ratio > state.peakRatio) state.peakRatio = ratio
    if (meter.classList.contains('hot')) state.hotSeen = true
    if (lit > state.maxLit) { state.maxLit = lit; state.scoreAtMaxLit = score }
    const readout = meter.querySelector('#wake-meter-score')
    const text = readout ? readout.textContent : ''
    const last = state.readouts[state.readouts.length - 1]
    if (text !== last) {
      state.readouts.push(text)
      if (state.readouts.length > 40) state.readouts.shift()
    }
    if (state.geometry === null && trackRect && trackRect.width > 0) {
      const meterRect = meter.getBoundingClientRect()
      const ballRect = ball ? ball.getBoundingClientRect() : null
      state.geometry = {
        // The card is what is deliberately the ball's width; the track is inset from it by the
        // card's own padding, so measuring the track against the ball reads a 20px design decision
        // as a 20px bug. That is the check telling on itself, not on the meter. (No backticks
        // anywhere in this template - they end it early, and the failure is a syntax error in the
        // *harness*, which is at least loud.)
        cardPx: Math.round(meterRect.width),
        trackPx: Math.round(trackRect.width),
        topPx: Math.round(meterRect.top),
        leftPx: Math.round(meterRect.left),
        heightPx: Math.round(meterRect.height),
        gapPx: ballRect ? Math.round(meterRect.top - ballRect.bottom) : null,
      }
      state.thresholdVar = meter.style.getPropertyValue('--wake-threshold')
    }
    if (line && trackRect && state.lineOffsetPx === null) {
      const lineRect = line.getBoundingClientRect()
      state.lineOffsetPx = Math.round((lineRect.left + lineRect.width / 2) - trackRect.left)
    }
  }
  window.__wakeMeterTimer = setInterval(tick, 40)
  tick()
  return true
})()`

/** The badge (the engine's own view of the last detection) and the meter's running extremes. */
const PROBE = `(() => {
  const badge = document.querySelector('#wake-badge')
  const m = window.__wakeMeter
  return JSON.stringify({
    badge: badge ? badge.textContent : null,
    bodyClass: document.body.className,
    peakRatio: m ? m.peakRatio : 0,
  })
})()`

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

const page = await orbPage()
if (page === undefined) {
  await finish(2, ['\n*** no page ever exposed #wake-meter — the helper never started the orb, or the installed page is the old one ***'])
}
const { ws, send, errors: pageErrors } = page

await send('Runtime.evaluate', { expression: RECORDER, returnByValue: true })
if (shot !== '') await send('Page.enable')

const timeline = []
let listeningSeen = false
let detectedAtMs
let shotTaken = false
const started = Date.now()

while (Date.now() - started < seconds * 1000) {
  const probe = await send('Runtime.evaluate', { expression: PROBE, returnByValue: true })
  const raw = probe.result?.result?.value
  if (typeof raw === 'string') {
    const snap = JSON.parse(raw)
    const badge = snap.badge ?? ''
    const last = timeline.at(-1)
    if (last === undefined || last.badge !== badge) {
      const at = Math.round((Date.now() - started) / 1000)
      timeline.push({ at, badge })
      console.log(`[${String(at).padStart(3)}s] ${badge}`)
    }
    if (badge.includes('语音唤醒已开启')) listeningSeen = true
    // The shot is taken the moment the bar first crosses, because that is the frame the meter exists
    // for and it lasts one window - 128 ms - after which the run fires, the bar resets and the score
    // falls away. Waiting for the badge to change would photograph the aftermath.
    if (shot !== '' && !shotTaken && snap.peakRatio >= threshold) {
      const frame = await send('Page.captureScreenshot', { format: 'png' })
      const data = frame.result?.data
      if (typeof data === 'string' && data !== '') {
        writeFileSync(shot, Buffer.from(data, 'base64'))
        shotTaken = true
        console.log(`[shot] the bar crossed — wrote ${shot}`)
      }
    }
    if (badge.includes('已听到唤醒词')) {
      detectedAtMs = Date.now() - started
      // A detection is the moment the meter has the most to show: the run that completed, the dots
      // all lit, and then the reset. Three more seconds of it is the whole story.
      await new Promise((r) => setTimeout(r, 3000))
      break
    }
  }
  await new Promise((r) => setTimeout(r, 200))
}

const snapshot = await send('Runtime.evaluate', {
  expression: `JSON.stringify(window.__wakeMeter ?? null)`,
  returnByValue: true,
})
// A run that never crossed still has a meter worth photographing — the quiet frame is the one a user
// looks at all day, and the crossing frame is the rare one. Whichever this run did not get, this is
// the fallback.
if (shot !== '' && !shotTaken) {
  const frame = await send('Page.captureScreenshot', { format: 'png' })
  const data = frame.result?.data
  if (typeof data === 'string' && data !== '') {
    writeFileSync(shot, Buffer.from(data, 'base64'))
    shotTaken = true
    console.log(`[shot] the run never crossed — wrote the resting frame to ${shot}`)
  }
}
const meter = JSON.parse(snapshot.result?.result?.value ?? 'null')
await send('Runtime.evaluate', { expression: `clearInterval(window.__wakeMeterTimer)`, returnByValue: true })
ws.close()

if (meter === null) {
  await finish(2, ['\n*** the recorder never installed — this run proves NOTHING ***'])
}

const fired = detectedAtMs !== undefined
const wakePageErrors = pageErrors.filter((text) => /wake|唤醒|meter/i.test(text))

const geometry = meter.geometry
const lineRatio = geometry && geometry.trackPx > 0 && meter.lineOffsetPx !== null
  ? meter.lineOffsetPx / geometry.trackPx
  : null

const report = [
  '',
  '======================= result =======================',
  `  mic              ${mic.split(/[\\/]/).pop()}`,
  `  expected         ${expect}`,
  `  observed         ${fired ? `fired after ${detectedAtMs} ms` : 'never fired'}`,
  `  engine listening ${listeningSeen ? 'yes' : 'NO'}`,
  `  meter sampled    ${meter.ticks} ticks, up for ${meter.ticks - meter.hiddenTicks}`,
  `  meter visible    ${meter.seen ? 'yes' : 'NEVER'}`,
  `  peak score       ${meter.peakScore.toFixed(3)}   (threshold ${threshold})`,
  `  peak bar         ${(meter.peakRatio * 100).toFixed(1)}% of the track`,
  `  crossed (hot)    ${meter.hotSeen ? 'yes' : 'no'}`,
  `  most dots lit    ${meter.maxLit} / ${meter.dotCount}  at score ${meter.scoreAtMaxLit.toFixed(3)}`,
  `  threshold var    ${meter.thresholdVar}`,
  `  threshold line   ${lineRatio === null ? 'not measured' : `${(lineRatio * 100).toFixed(1)}% along the track`}`,
  `  geometry         ${geometry === null ? 'not measured'
    : `card ${geometry.cardPx}px, track ${geometry.trackPx}px, top ${geometry.topPx}px, left ${geometry.leftPx}px, height ${geometry.heightPx}px, ${geometry.gapPx}px under the ball`}`,
  `  readout trail    ${meter.readouts.slice(-12).join(' -> ')}`,
  '  badge timeline  ',
  ...timeline.map((row) => `    ${String(row.at).padStart(3)}s  ${row.badge || '(empty)'}`),
  '',
  ...log.slice(-8).map((line) => `  ${line}`),
]

// The harness's own failures, checked before anything is said about the product.
if (!listeningSeen) {
  report.push('', '*** THE ENGINE NEVER REPORTED `listening` — this run proves NOTHING ***')
  await finish(2, report)
}
if (!meter.seen) {
  report.push('', '*** the meter was NEVER visible — a hidden meter cannot be judged ***')
  report.push('    (the engine was listening, so the page should have shown it)')
  await finish(2, report)
}
if (meter.dotCount === 0) {
  report.push('', '*** the meter has no streak dots — the page never built them ***')
  await finish(2, report)
}
if (wakePageErrors.length > 0) {
  report.push('', `*** the wake page threw: ${wakePageErrors.join(' | ')} ***`)
  await finish(2, report)
}

// What the meter is for, in four checks. The geometry ones hold on every run: they are the claim
// that the bar is the ball's width, sits its 14px under the ball, and draws its threshold line where
// the configured threshold is - all of which a bar that "works" can still get wrong.
const failures = []
if (geometry === null) failures.push('the meter never reported a geometry')
else {
  if (geometry.gapPx === null || Math.abs(geometry.gapPx - 14) > 1) {
    failures.push(`the meter is ${geometry.gapPx}px under the ball, not 14`)
  }
  const ballWidth = 288
  if (Math.abs(geometry.cardPx - ballWidth) > 1) {
    failures.push(`the meter is ${geometry.cardPx}px wide, not the ball's ${ballWidth}`)
  }
  if (geometry.trackPx <= 0) failures.push('the track has no width')
}
if (meter.dotCount !== 3) failures.push(`the meter has ${meter.dotCount} dots, not 3`)
if (meter.thresholdVar !== null && Math.abs(Number(meter.thresholdVar) - threshold) > 1e-6) {
  failures.push(`the threshold was drawn at ${meter.thresholdVar}, not ${threshold}`)
}
if (lineRatio !== null && Math.abs(lineRatio - threshold) > 0.02) {
  failures.push(`the threshold line sits at ${(lineRatio * 100).toFixed(1)}%, not ${(threshold * 100).toFixed(1)}%`)
}

if (expect === 'fired') {
  if (!fired) failures.push('the orb never woke on the doubled phrase')
  if (!meter.hotSeen) failures.push('the bar never crossed the threshold on a phrase that woke the orb')
  if (meter.maxLit < 3) failures.push(`the run only reached ${meter.maxLit} of 3 dots on a phrase that woke the orb`)
  if (meter.peakScore < threshold) {
    failures.push(`the peak score was ${meter.peakScore.toFixed(3)}, under the ${threshold} the orb woke at`)
  }
} else {
  if (fired) failures.push('the orb woke on a phrase it should have ignored')
  if (meter.maxLit >= 3) failures.push('the run completed on a phrase that did not wake the orb')
}

report.push('', '  checks   ')
for (const line of [
  `card is the ball's width, 14px under it        ${geometry !== null && Math.abs(geometry.cardPx - 288) <= 1 && geometry.gapPx !== null && Math.abs(geometry.gapPx - 14) <= 1 ? 'OK' : 'FAIL'}`,
  `streak dots match the rule (3)                ${meter.dotCount === 3 ? 'OK' : 'FAIL'}`,
  `threshold line at ${(threshold * 100).toFixed(1)}% of the track           ${lineRatio !== null && Math.abs(lineRatio - threshold) <= 0.02 ? 'OK' : 'FAIL'}`,
  expect === 'fired'
    ? `crossed and completed, then woke              ${meter.hotSeen && meter.maxLit >= 3 && fired ? 'OK' : 'FAIL'}`
    : `stayed below a completed run                  ${meter.maxLit < 3 && !fired ? 'OK' : 'FAIL'}`,
]) report.push(`    ${line}`)

const passed = failures.length === 0
report.push('', passed
  ? `PASS — the meter drew the score the engine scored, and ${expect === 'fired' ? 'the run that woke the orb' : 'no completed run on a phrase it should ignore'}.`
  : `FAIL — ${failures.join('; ')}.`)
await finish(passed ? 0 : 1, report)
