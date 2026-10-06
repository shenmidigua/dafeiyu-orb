/**
 * Record what the meter drew, and when, across a whole wake - not just its extremes.
 *
 * `wake_meter_verify.mjs` answers "did the bar ever reach the threshold". This one answers the
 * question a user asks while looking at it: "the bar never got there and it fired anyway - why".
 * That needs the *order* of things: the engine's own report (`--wake-score` is written
 * synchronously by `paintWakeMeter`, so a MutationObserver on the style attribute timestamps every
 * scored window exactly), the pixels the browser actually painted (one sample per animation frame,
 * read off the fill's bounding box), and the badge the page shows when a run completes.
 *
 * The two timelines are what separate the three ways "the bar was low and it fired" can happen:
 *   - the engine never sent a high score  -> the report never reaches the page
 *   - it sent one but the paint lagged    -> the fill is still animating when the badge changes
 *   - a zero arrives right after the fire -> something reset the engine and wiped the reading
 *
 * Usage:
 *   wake_meter_trace.mjs --mic wake-mic-doubled.wav [--seconds 30] [--port 9530] [--no-dictation]
 *
 * Exit code 0 when the run produced a trace with at least one completed run, 2 when the harness
 * itself failed. It is a recorder, not a test: a trace of a quiet run is a valid answer.
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
const port = arg('port', '9530')
const seconds = Number(arg('seconds', '30'))
const dictation = process.argv.includes('--no-dictation') ? false : true
const out = arg('out', '')
/**
 * CPU throttle for the orb's renderer, the way a busy desktop behaves.
 *
 * The engine runs on the page's main thread, so a slower box - or the same box with the chat panel
 * open, a reply being rendered, anything - makes the audio messages queue and then arrive in a
 * burst. That is the one condition under which the detection rule can complete without a single
 * frame being painted in between, which is what this harness exists to observe. `1` is the real
 * machine; higher is slower.
 */
const throttle = Number(arg('throttle', '1'))

if (!existsSync(mic)) {
  console.error(`mic file not found: ${mic}`)
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
    dictation: { ...settings.dictation, enabled: dictation },
  }),
}
delete env.ELECTRON_RUN_AS_NODE

console.log(`mic:        ${mic}`)
console.log(`keyword:    ${settings.keyword} @ threshold ${settings.threshold}`)
console.log(`dictation:  ${dictation ? 'as configured' : 'forced off'}`)

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
env.DSH_ORB_TOKEN = `meter-trace-${process.pid}`

const scratch = mkdtempSync(join(tmpdir(), 'orb-trace-'))

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
 * The recorder.
 *
 * Two independent clocks, deliberately: the *report* clock is a MutationObserver on the meter's
 * style attribute, which fires synchronously inside `paintWakeMeter()` - so its timestamps are the
 * engine's own window times, and its values are what the engine scored. The *paint* clock samples
 * the fill's measured width once per animation frame - so it is what the user could actually see,
 * transitions included. Reading `--wake-score` alone would prove only that the variable was set;
 * reading pixels alone could not tell a late score from a slow one.
 *
 * No backticks anywhere inside this template: they end it early and the failure is a syntax error
 * in the harness rather than in the page - which reads as "the page is broken" if you are looking at
 * the wrong end of it. No `${` either, for the same reason with a quieter symptom: it would be
 * interpolated here, in the harness's scope, instead of in the page.
 */
const RECORDER = `(() => {
  if (window.__wakeTrace !== undefined) {
    clearInterval(window.__wakeTrace.timer)
    if (window.__wakeTrace.raf !== undefined) cancelAnimationFrame(window.__wakeTrace.raf)
  }
  const S = { t0: performance.now(), events: [], paints: [], timer: 0, raf: undefined }
  window.__wakeTrace = S
  const meter = document.querySelector('#wake-meter')
  const badge = document.querySelector('#wake-badge')
  const fill = document.querySelector('#wake-meter-fill')
  const track = document.querySelector('#wake-meter-track')
  const at = () => Math.round(performance.now() - S.t0)
  // How many dots the page builds, which is the detection rule drawn as a picture: one dot per
  // window the rule needs in a row. Read off the page rather than restated here, so the harness
  // cannot disagree with the rule it is measuring.
  S.dots = meter.querySelectorAll('.wake-meter-dot').length
  // The crossed green, resolved to the exact string the browser reports for it. The sheet writes
  // --wake-strong as a hex literal, so comparing a sampled colour against that literal would never
  // match: getComputedStyle hands back rgb(). Resolving it through a throwaway element is what keeps
  // "has it turned green" a question about the page rather than about string formatting; the first
  // version of this probe compared against the literal and reported zero green frames.
  const probe = document.createElement('i')
  document.body.appendChild(probe)
  probe.style.background = getComputedStyle(meter).getPropertyValue('--wake-strong') || '#2ea043'
  const STRONG = getComputedStyle(probe).backgroundColor
  probe.remove()
  // The phase the body class says the page is in, as one token. Read from the body rather than from
  // any page variable: it is the same class the sheet keys off, so it is what the user is looking at.
  const phaseOf = () => {
    const c = document.body.classList
    if (c.contains('wake-transcribing')) return 'transcribing'
    if (c.contains('wake-recording')) return 'recording'
    if (c.contains('wake-detected')) return 'detected'
    if (c.contains('wake-listening')) return 'listening'
    return 'idle'
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  const push = (kind, value) => {
    const last = S.events[S.events.length - 1]
    if (last !== undefined && last.kind === kind && same(last.value, value)) return
    S.events.push({ t: at(), kind, value })
  }
  const readMeter = () => ({
    score: meter.style.getPropertyValue('--wake-score') || '',
    hot: meter.classList.contains('hot') ? 1 : 0,
    held: meter.classList.contains('held') ? 1 : 0,
    dots: [...meter.querySelectorAll('.wake-meter-dot')].filter((d) => d.classList.contains('on')).length,
    text: (meter.querySelector('#wake-meter-score') || {}).textContent || '',
    hidden: meter.hidden ? 1 : 0,
  })
  new MutationObserver(() => push('meter', readMeter()))
    .observe(meter, { attributes: true, attributeFilter: ['style', 'hidden', 'class'] })
  new MutationObserver(() => push('phase', { cls: document.body.className }))
    .observe(document.body, { attributes: true, attributeFilter: ['class'] })
  // What is on top of the meter when the ball announces a completion. The panel opens on the same
  // status as the chime, so if the two surfaces overlap, the reading the user was watching is
  // covered at the exact moment it matters - and a covered meter reads as "it never got there".
  const stack = () => {
    const meterRect = meter.getBoundingClientRect()
    const point = document.elementFromPoint(meterRect.left + meterRect.width / 2, meterRect.top + meterRect.height / 2)
    const panel = document.querySelector('#panel')
    const panelRect = panel === null ? null : panel.getBoundingClientRect()
    const overlap = panelRect === null ? 0 : Math.max(0, Math.min(meterRect.bottom, panelRect.bottom) - Math.max(meterRect.top, panelRect.top)) * Math.max(0, Math.min(meterRect.right, panelRect.right) - Math.max(meterRect.left, panelRect.left))
    const cs = panel === null ? null : getComputedStyle(panel)
    return {
      hidden: meter.hidden ? 1 : 0,
      top: point === null ? null : (point.id || point.className || point.tagName),
      meter: [Math.round(meterRect.left), Math.round(meterRect.top), Math.round(meterRect.width), Math.round(meterRect.height)],
      panel: panelRect === null ? null : [Math.round(panelRect.left), Math.round(panelRect.top), Math.round(panelRect.width), Math.round(panelRect.height)],
      panelOpacity: cs === null ? null : cs.opacity,
      panelZ: cs === null ? null : cs.zIndex,
      overlapPx: Math.round(overlap),
    }
  }
  if (badge !== null) {
    new MutationObserver(() => push('badge', { text: badge.textContent, hidden: badge.hidden ? 1 : 0 }))
      .observe(badge, { attributes: true, childList: true, characterData: true, subtree: true })
    new MutationObserver(() => {
      if (typeof badge.textContent !== 'string' || !badge.textContent.includes('已听到唤醒词')) return
      push('stack', stack())
    }).observe(badge, { childList: true, characterData: true, subtree: true })
  }
  const frame = () => {
    S.raf = requestAnimationFrame(frame)
    if (fill === null || track === null) return
    const fr = fill.getBoundingClientRect()
    const tr = track.getBoundingClientRect()
    const colour = getComputedStyle(fill).backgroundColor
    S.paints.push({
      t: at(),
      r: tr.width > 0 ? Math.round((fr.width / tr.width) * 1000) / 1000 : -1,
      h: meter.classList.contains('hot') ? 1 : 0,
      // The four questions the report cannot answer from the report channel alone, sampled on the
      // same clock as the length so none of them can disagree with it: whether the bar was green
      // (k), whether the bar was on screen at all (hid), and which phase the page was in (p). The
      // last two are what catch the reported fault - a phase whose audio the engine is still
      // scoring, with the bar taken off the screen for it.
      //
      // (k) is "the green the user could have seen", not "the class was set": a hidden fill still
      // reports the crossed colour, so counting the class alone would credit the page with showing
      // a colour that was never on the screen.
      k: colour === STRONG && !meter.hidden ? 1 : 0,
      kg: colour === STRONG && meter.hidden ? 1 : 0,
      hid: meter.hidden ? 1 : 0,
      p: phaseOf(),
    })
  }
  S.raf = requestAnimationFrame(frame)
  // A safety net: if the page is starved so badly that rAF stops firing, the timeline would end
  // early and look like a quiet run. The interval keeps the trace honest about its own coverage.
  S.timer = setInterval(() => { S.heartbeat = at() }, 500)
  return true
})()`

async function finish(code) {
  child.kill()
  host.close()
  await new Promise((r) => setTimeout(r, 400))
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best effort
  }
  process.exit(code)
}

const page = await orbPage()
if (page === undefined) {
  console.log('*** no page ever exposed #wake-meter - the helper never started the orb ***')
  await finish(2)
}
const { ws, send, errors: pageErrors } = page

const installed = await send('Runtime.evaluate', { expression: RECORDER, returnByValue: true })
if (installed.result?.result?.value !== true && installed.result?.result?.value !== undefined) {
  console.log('*** the recorder did not install ***')
  await finish(2)
}
if (throttle > 1) {
  const applied = await send('Emulation.setCPUThrottlingRate', { rate: throttle })
  console.log(`cpu throttle: ${throttle}x  (${applied.error === undefined ? 'applied' : `FAILED: ${applied.error.message}`})`)
}

const started = Date.now()
while (Date.now() - started < seconds * 1000) {
  await new Promise((r) => setTimeout(r, 500))
}

const snapshot = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    events: window.__wakeTrace ? window.__wakeTrace.events : null,
    paints: window.__wakeTrace ? window.__wakeTrace.paints : null,
    dots: window.__wakeTrace ? window.__wakeTrace.dots : 0,
    heartbeat: window.__wakeTrace ? window.__wakeTrace.heartbeat : null,
  })`,
  returnByValue: true,
})
ws.close()

const raw = snapshot.result?.result?.value
if (typeof raw !== 'string' || raw === '') {
  console.log('*** the page never handed back a trace - this run proves NOTHING ***')
  console.log(log.slice(-10).map((line) => `  ${line}`).join('\n'))
  await finish(2)
}
const trace = JSON.parse(raw)
if (trace.events === null || trace.events.length === 0) {
  console.log('*** the recorder never saw a single window - the engine was not scoring ***')
  console.log(log.slice(-10).map((line) => `  ${line}`).join('\n'))
  await finish(2)
}

if (out !== '') writeFileSync(out, JSON.stringify(trace))

const events = trace.events
const paints = trace.paints ?? []
const meterEvents = events.filter((e) => e.kind === 'meter')
const badgeEvents = events.filter((e) => e.kind === 'badge')

// A completed run, straight from the engine's own report: the rule completing is the lit dots going
// from one short of a full set to a full set, because the engine publishes the full streak on the
// window that fires and a zero on the next one.
//
// Read as a *transition* rather than as "a full set is lit". A held reading is drawn as a full set
// deliberately - that is its whole job - so any repaint while a hold is live writes a full set, and
// "a full set is lit" therefore counts hold repaints as wakes. It did: a run with two wakes was
// reported as six, the four extra all inside a recording, where the engine scores nothing at all
// (`processChunk` hands those frames to the recorder) and so cannot possibly have detected anything.
const RULE = trace.dots ?? 0
const runEvents = []
let fullSetsNotARun = 0
for (let i = 0; i < meterEvents.length && RULE > 1; i += 1) {
  const event = meterEvents[i]
  if (event.value.dots !== RULE) continue
  if (i > 0 && meterEvents[i - 1].value.dots === RULE - 1) runEvents.push(event)
  else fullSetsNotARun += 1
}

// The badge is the second signal, and it is not redundancy: the page hands the badge to the dictation
// phase while a transcript is pending, so a wake that lands in that stretch changes no badge text at
// all. A badge-only count reported "1 completion" for a run that fired four times, and the three it
// missed were the three that fired with the bar off the screen - the exact case this harness exists
// for.
// The badge text the page shows on a completion; from `messages.wakeDetected`.
const FIRED = '已听到唤醒词'
const rawFires = badgeEvents.filter((e) => typeof e.value.text === 'string' && e.value.text.includes(FIRED))

// Both signals describe one completion each, and badge writes also come in pairs (the text, then the
// unhide). Anything within a second is the same event.
const fires = []
for (const fire of [...rawFires, ...runEvents].sort((a, b) => a.t - b.t)) {
  const last = fires.at(-1)
  if (last !== undefined && fire.t - last.t < 1000) continue
  fires.push(fire)
}

// Gaps between scored windows: the rule needs three in a row, so how far apart they arrive is what
// decides whether a 90 ms width transition can possibly show the run before it fires.
//
// One window per 128 ms of audio is the realtime rate. A median well above it means the engine is
// draining a backlog - and a backlog is exactly what makes a burst possible: once the renderer has
// been blocked for a while, the audio frames it queued are all delivered at once and several
// windows are scored inside a single task, with no frame painted in between.
const gaps = []
const shortGaps = []
for (let i = 1; i < meterEvents.length; i += 1) {
  const gap = meterEvents[i].t - meterEvents[i - 1].t
  if (gap > 5000) continue // a dictation pauses scoring; that gap is not a rate
  gaps.push(gap)
  if (gap < 90) shortGaps.push({ t: meterEvents[i].t, gap })
}
const sorted = [...gaps].sort((a, b) => a - b)
const pct = (p) => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
const span = (meterEvents.at(-1)?.t ?? 0) - (meterEvents[0]?.t ?? 0)
const rate = span > 0 ? (meterEvents.length * 1000) / span : 0
const paintsPerWindow = meterEvents.length > 0 ? paints.length / meterEvents.length : 0

const lastPaintAt = (t) => {
  let found = null
  for (const paint of paints) {
    if (paint.t > t) break
    found = paint
  }
  return found
}

const lines = []
lines.push('')
lines.push('======================== trace ========================')
lines.push(`  windows scored   ${meterEvents.length}  spanning ${(span / 1000).toFixed(1)} s`)
lines.push(`  window rate      ${rate.toFixed(2)} /s   (realtime is 7.81 /s: one window per 128 ms of audio)`)
lines.push(`  window gap       min ${pct(0)} ms, p25 ${pct(0.25)} ms, p50 ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${pct(0.999)} ms`)
lines.push(`  burst gaps       ${shortGaps.length} under 90 ms  (two windows scored with no frame between them)`)
lines.push(`  painted frames   ${paints.length}  = ${paintsPerWindow.toFixed(1)} per window (last at ${((paints.at(-1)?.t ?? 0) / 1000).toFixed(1)} s, heartbeat ${trace.heartbeat ?? 0} ms)`)
lines.push('')
lines.push(`  completions      ${fires.length}${fullSetsNotARun > 0 ? `   (${fullSetsNotARun} further full set(s) of dots were not the last step of a run - a hold repaint, which draws a full set on purpose)` : ''}`)
// What the meter was doing when the ball announced each one. The engine keeps scoring whenever the
// recorder is not holding the microphone - listening, the detection hold, and the transcription
// wait - so a completion the meter could not show is a completion the user hears with no reading.
//
// Whether the bar was up is read from the meter's own state at that window, not from the badge: a
// completion that the page announced with no badge (mid-analysis) has no badge event to look at, and
// those are the ones this line is for.
const blind = []
for (const [index, fire] of fires.entries()) {
  const last = [...meterEvents].reverse().find((x) => x.t <= fire.t)
  const shown = last === undefined ? '?' : (last.value.hidden ? 'HIDDEN' : 'shown')
  const phase = [...events].reverse().find((x) => x.kind === 'phase' && x.t <= fire.t)
  const source = typeof fire.value.text === 'string' && fire.value.text.includes(FIRED) ? 'badge' : 'meter run'
  lines.push(`    #${index + 1} at ${(fire.t / 1000).toFixed(2)} s  [${source}]  meter ${shown}  readout ${last === undefined ? '?' : last.value.text}  dots ${last === undefined ? '?' : last.value.dots}  held ${last === undefined ? '?' : last.value.held}  body "${phase === undefined ? '?' : String(phase.value.cls).replace(/^expand-\S+ |^expand-\S+$/g, '').trim()}"`)
  if (last !== undefined && last.value.hidden) blind.push(fire.t)
}
if (blind.length > 0) {
  lines.push('')
  lines.push(`  *** ${blind.length} of ${fires.length} completion(s) fired while the meter was NOT on screen -`)
  lines.push('      the ball chimed and the page had no reading up at all ***')
}

// The colour is the half of the promise the user checks by eye: not "was the bar long enough" but
// "did it turn green". Read per frame off the fill's own background, and only counted while the
// meter was actually displayed - a hidden fill still computes to the crossed green, and crediting the
// page with a colour that was never on the screen is how this measurement lies.
const greenFrames = paints.filter((p) => p.k === 1)
const greenHidden = paints.filter((p) => p.kg === 1).length
lines.push('')
const longestGreen = (() => {
  let best = 0
  let run = 0
  let prev = -1
  for (const f of greenFrames) {
    run = f.t - prev < 400 ? run + 1 : 1
    prev = f.t
    if (run > best) best = run
  }
  return best
})()
lines.push(`  crossed green    ${greenFrames.length} frames on screen${greenFrames.length === 0 ? ' (never)' : `, first at ${(greenFrames[0].t / 1000).toFixed(2)} s, longest run ${longestGreen} frames`}${greenHidden > 0 ? `, plus ${greenHidden} frames green while hidden` : ''}`)
for (const fire of fires) {
  const before = [...greenFrames].reverse().find((p) => p.t <= fire.t)
  const after = greenFrames.find((p) => p.t >= fire.t)
  const wasGreen = before !== undefined && fire.t - before.t < 400
  lines.push(`    at the completion at ${(fire.t / 1000).toFixed(2)} s: green ${wasGreen ? `already (${fire.t - before.t} ms earlier)` : after === undefined ? 'NEVER' : `first ${after.t - fire.t} ms after the chime`}`)
}

// Frames grouped by the phase the page was in. This is the measurement that does not depend on
// counting scored windows: the engine keeps reading the microphone in `listening`, `detected` and
// `transcribing`, and only stops for `recording`. A frame in one of the first three with `hid` set is
// a frame where the bar was off the screen over audio that was being scored - which is exactly the
// reported fault, and is invisible to a report-channel-only trace.
const byPhase = new Map()
for (const p of paints) {
  const row = byPhase.get(p.p) || { n: 0, hid: 0, green: 0, max: 0 }
  row.n += 1
  if (p.hid) row.hid += 1
  if (p.k) row.green += 1
  if (p.r > row.max) row.max = p.r
  byPhase.set(p.p, row)
}
lines.push('')
lines.push('  --- frames by phase (the engine scores every phase except recording) ---')
for (const [phase, row] of byPhase) {
  const pctHidden = row.n === 0 ? 0 : Math.round((row.hid / row.n) * 100)
  lines.push(`    ${phase.padEnd(13)} ${String(row.n).padStart(5)} frames   meter hidden ${String(row.hid).padStart(5)} (${String(pctHidden).padStart(3)}%)   green ${String(row.green).padStart(4)}   best drawn ${(Math.max(0, row.max) * 100).toFixed(1)}%`)
}
const scored = ['listening', 'detected', 'transcribing']
const hiddenScored = scored.reduce((sum, phase) => sum + (byPhase.get(phase)?.hid ?? 0), 0)
const scoredFrames = scored.reduce((sum, phase) => sum + (byPhase.get(phase)?.n ?? 0), 0)
if (hiddenScored > 0) {
  lines.push('')
  lines.push(`  *** ${hiddenScored} of ${scoredFrames} frame(s) in a scored phase had the meter hidden -`)
  lines.push('      the ball was reading the microphone with no reading on the screen ***')
} else if (scoredFrames > 0) {
  lines.push('')
  lines.push(`  the meter was up for all ${scoredFrames} frame(s) of the scored phases`)
}
if (byPhase.get('recording') !== undefined) {
  const row = byPhase.get('recording')
  // The recording is the one stretch the engine does not score, so the bar being up over it is not
  // the same finding as the one above: it is a reading left on screen for audio nobody is judging.
  // Whether that was deliberate is answerable from the page itself - a held reading is drawn as one.
  const held = meterEvents.some((e) => e.value.held === 1)
  lines.push(`  over the unscored recording: ${row.hid} of ${row.n} frames hidden (${held ? `a held reading kept the rest up; the build draws one` : 'no hold in this build, so the bar was up for a reading nothing was producing'})`)
}

for (const fire of fires) {
  const last = [...meterEvents].reverse().find((e) => e.t <= fire.t)
  const at = meterEvents.indexOf(last)
  const run = at >= RULE - 1 ? meterEvents.slice(at - RULE + 1, at + 1) : []
  const label = typeof fire.value.text === 'string' && fire.value.text.includes(FIRED) ? fire.value.text : 'the rule completing'
  lines.push('')
  lines.push(`  --- completion at ${(fire.t / 1000).toFixed(2)} s (${label}) ---`)
  for (const e of meterEvents.filter((x) => x.t > fire.t - 2500 && x.t <= fire.t + 1200)) {
    const paint = lastPaintAt(e.t)
    lines.push(`   ${e.t > fire.t ? ' ' : '*'}${String(e.t).padStart(6)} ms  score ${String(e.value.score).padEnd(20).slice(0, 20)} hot ${e.value.hot}  held ${e.value.held}  dots ${e.value.dots}  readout ${String(e.value.text).padEnd(6)} hidden ${e.value.hidden}  drawn ${paint === null ? '?' : (paint.r * 100).toFixed(1) + '%'}`)
  }
  if (run.length === RULE && RULE > 0) {
    const first = run[0]
    const between = paints.filter((p) => p.t > first.t && p.t <= fire.t).length
    const runMs = fire.t - first.t
    lines.push(`    the run: ${RULE} windows over ${runMs} ms (${run.map((e) => e.t).join(', ')}), ${between} frames painted inside it`)
  }
  const before = lastPaintAt(fire.t)
  const after = paints.find((p) => p.t > fire.t)
  lines.push(`    at the fire: engine score ${last === undefined ? '?' : last.value.score}, drawn ${before === null ? '?' : (before.r * 100).toFixed(1) + '%'}; next frame ${after === undefined ? 'none' : (after.r * 100).toFixed(1) + '%'}`)
}
lines.push('')
lines.push('  --- badge timeline ---')
for (const e of badgeEvents) {
  lines.push(`    ${String(e.t).padStart(6)} ms  hidden ${e.value.hidden}  ${(e.value.text || '(empty)').slice(0, 40)}`)
}
lines.push('')
lines.push('  --- phase timeline ---')
for (const e of events.filter((x) => x.kind === 'phase')) {
  lines.push(`    ${String(e.t).padStart(6)} ms  ${e.value.cls}`)
}
lines.push('')
lines.push('  --- what was on top of the meter at a completion (and after the panel opened) ---')
for (const e of events.filter((x) => x.kind === 'stack')) {
  const v = e.value
  lines.push(`    ${String(e.t).padStart(6)} ms  meter hidden ${v.hidden}  top=${v.top}  meter [${v.meter.join(',')}]  panel ${v.panel === null ? 'none' : `[${v.panel.join(',')}]`}  panel z ${v.panelZ} opacity ${v.panelOpacity}  overlap ${v.overlapPx} px²`)
}
const wakeErrors = pageErrors.filter((text) => /wake|唤醒|meter/i.test(text))
if (wakeErrors.length > 0) lines.push('', `  page errors: ${wakeErrors.join(' | ')}`)
lines.push('', ...log.slice(-6).map((line) => `  ${line}`))
console.log(lines.join('\n'))

await finish(fires.length > 0 ? 0 : 1)
