/**
 * Measure how long the meter takes to *show* a crossing, with the engine out of the way.
 *
 * The engine decides on raw 128 ms samples: three in a row over the threshold and the ball wakes.
 * The bar, though, is animated - 90 ms on the width and 90 ms on the colour - so a run that lasts
 * three windows and then falls away again is a three-sample square wave fed into a low-pass filter.
 * If the filter is slower than the signal, the bar never reaches the line and never turns green,
 * while the engine - reading the raw samples - fires. That is a user's "it fired and the bar never
 * got there", and it is a property of the sheet, not of the classifier.
 *
 * So this drives `--wake-score` itself, on the engine's own cadence, and measures the *pixels*: the
 * fill's width against the track, and the fill's rendered colour against the two greens the sheet
 * defines. The wake engine is switched off for the run (`DSH_ORB_WAKE.enabled = false`), so nothing
 * overwrites the variable and the numbers belong to the sheet alone.
 *
 * Usage:
 *   wake_meter_lag_probe.mjs [--port 9550] [--out lag.json]
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

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const port = arg('port', '9550')
const out = arg('out', '')

if (!existsSync(MAIN)) {
  console.error(`installed helper not found: ${MAIN}`)
  process.exit(2)
}

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
const threshold = Number(settings.threshold)
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: settings.assetDirectory,
  // Off: the meter is driven here, and a live engine would fight this for the same variable.
  DSH_ORB_WAKE: JSON.stringify({
    enabled: false,
    keyword: settings.keyword,
    threshold,
    autoExpandOnWake: false,
    dictation: { ...settings.dictation, enabled: false },
  }),
}
delete env.ELECTRON_RUN_AS_NODE

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
env.DSH_ORB_TOKEN = `meter-lag-${process.pid}`

const scratch = mkdtempSync(join(tmpdir(), 'orb-lag-'))
const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
const log = []
for (const [label, stream] of [['out', child.stdout], ['err', child.stderr]]) {
  stream.setEncoding('utf8')
  let pending = ''
  stream.on('data', (chunk) => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.trim() !== '') log.push(`[${label}] ${line.trim()}`)
  })
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
      errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text)
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
    let targets = []
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    } catch {
      targets = []
    }
    for (const target of targets) {
      if (target.type !== 'page' || target.webSocketDebuggerUrl === undefined) continue
      let page
      try {
        page = await attach(target)
      } catch {
        continue
      }
      const probe = await page.send('Runtime.evaluate', {
        expression: `document.querySelector('#wake-meter-fill') !== null`,
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
 * The driver, in the page.
 *
 * Each scripted step lasts one engine window - 128 ms - and is written to the same variable
 * `applyWakeScore` writes, together with the same `hot` class and the same streak dots, so the
 * sheet is exercised exactly as it is in service. The measurement is taken on every animation
 * frame *before* the next write, which is the frame the user would have seen.
 *
 * No backticks inside: they end this template early.
 */
const DRIVER = `(() => {
  const STEP = 128
  const meter = document.querySelector('#wake-meter')
  const fill = document.querySelector('#wake-meter-fill')
  const track = document.querySelector('#wake-meter-track')
  const dots = [...document.querySelectorAll('.wake-meter-dot')]
  meter.hidden = false
  meter.style.setProperty('--wake-threshold', '${threshold}')
  meter.style.setProperty('--wake-score', '0.02')
  const phases = [
    { name: 'marginal run: three windows at 0.96, the shortest thing that wakes the ball', values: [0.02, 0.02, 0.02, 0.02, 0.96, 0.96, 0.96, 0.02, 0.02, 0.02, 0.02, 0.02] },
    { name: 'clean run: three windows at 0.995', values: [0.02, 0.02, 0.02, 0.02, 0.995, 0.995, 0.995, 0.02, 0.02, 0.02, 0.02, 0.02] },
    { name: 'flicker: six windows alternating 0.96 and 0.30', values: [0.02, 0.02, 0.96, 0.30, 0.96, 0.30, 0.96, 0.30, 0.96, 0.30, 0.96, 0.30, 0.02, 0.02] },
    { name: 'quiet: nothing crosses', values: [0.02, 0.02, 0.02, 0.02, 0.60, 0.60, 0.60, 0.60, 0.02, 0.02] },
  ]
  const frameOf = () => {
    const fr = fill.getBoundingClientRect()
    const tr = track.getBoundingClientRect()
    const cs = getComputedStyle(fill)
    return {
      ratio: tr.width > 0 ? fr.width / tr.width : -1,
      color: cs.backgroundColor,
      hot: meter.classList.contains('hot') ? 1 : 0,
      dots: dots.filter((d) => d.classList.contains('on')).length,
    }
  }
  const run = async () => {
    const report = []
    for (const phase of phases) {
      const frames = []
      for (let i = 0; i < phase.values.length; i += 1) {
        const value = phase.values[i]
        const crossed = value > ${threshold}
        meter.style.setProperty('--wake-score', String(value))
        meter.classList.toggle('hot', crossed)
        const lit = value > ${threshold} ? Math.min(3, i - 3) : 0
        dots.forEach((dot, index) => dot.classList.toggle('on', index < lit))
        const until = performance.now() + STEP
        while (performance.now() < until) {
          await new Promise((r) => requestAnimationFrame(r))
          frames.push({ phase: phase.name, step: i, value, crossed, ...frameOf() })
        }
      }
      report.push({ name: phase.name, values: phase.values, frames })
      // A second of rest so every phase starts from a settled bar rather than from the last one.
      meter.style.setProperty('--wake-score', '0.02')
      meter.classList.remove('hot')
      dots.forEach((dot) => dot.classList.remove('on'))
      const until = performance.now() + 1200
      while (performance.now() < until) await new Promise((r) => requestAnimationFrame(r))
    }
    window.__lagReport = report
  }
  void run()
  return true
})()`

async function finish(code, lines) {
  child.kill()
  host.close()
  await new Promise((r) => setTimeout(r, 400))
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // best effort
  }
  if (lines !== undefined) console.log(lines.join('\n'))
  process.exit(code)
}

const page = await orbPage()
if (page === undefined) await finish(2, ['*** no orb page ever appeared ***'])
const { ws, send } = page
await send('Runtime.evaluate', { expression: DRIVER, returnByValue: true })
await new Promise((r) => setTimeout(r, 16000))

const snapshot = await send('Runtime.evaluate', {
  expression: `JSON.stringify(window.__lagReport ?? null)`,
  returnByValue: true,
})
ws.close()
const raw = snapshot.result?.result?.value
if (typeof raw !== 'string' || raw === '' || raw === 'null') {
  await finish(2, ['*** the driver never reported - this run proves NOTHING ***', ...log.slice(-6)])
}
const report = JSON.parse(raw)
if (out !== '') writeFileSync(out, JSON.stringify(report))

// The colours the sheet defines for the fill: the resting green and the crossed one.
const STRONG = '#2ea043'

const lines = ['']
lines.push(`threshold ${threshold}   (the line sits at ${(threshold * 100).toFixed(1)}% of the track)`)
const summarize = []
for (const phase of report) {
  const crossed = phase.frames.filter((f) => f.crossed)
  const during = phase.frames.filter((f) => f.step >= 4 && f.step <= 6 && f.value > threshold)
  const peak = crossed.length === 0 ? 0 : Math.max(...crossed.map((f) => f.ratio))
  const peakInRun = during.length === 0 ? 0 : Math.max(...during.map((f) => f.ratio))
  const framesAbove = during.filter((f) => f.ratio >= threshold).length
  const strong = crossed.filter((f) => f.color.replace(/\s/g, '').toLowerCase() === STRONG)
  const colors = [...new Set(crossed.map((f) => f.color))]
  summarize.push({
    name: phase.name,
    peakRatio: peak,
    peakDuringRun: peakInRun,
    framesAboveLine: framesAbove,
    framesCrossed: during.length,
    framesStrongGreen: strong.length,
    colors,
  })
  lines.push('')
  lines.push(`  ${phase.name}`)
  lines.push(`    the engine scored over the line for ${during.length} frames of the run`)
  lines.push(`    the bar reached    ${(peakInRun * 100).toFixed(1)}% of the track   (the line is at ${(threshold * 100).toFixed(1)}%)`)
  lines.push(`    frames with the bar at or past the line   ${framesAbove}`)
  lines.push(`    frames showing the crossed green (${STRONG})   ${strong.length}`)
  lines.push(`    colours the fill was drawn in   ${colors.join(', ') || 'none'}`)
  const trail = crossed.slice(0, 40).map((f) => `${(f.ratio * 100).toFixed(0)}%${f.hot ? 'g' : ''}`).join(' ')
  lines.push(`    drawn, frame by frame: ${trail}`)
}
lines.push('')
const verdict = summarize.map((s) => s.framesAboveLine === 0 && s.framesCrossed > 0)
const broken = verdict.some(Boolean)
lines.push(broken
  ? 'VERDICT: a run that the engine counted never appears on the bar - the animation is slower than the decision.'
  : 'VERDICT: the bar shows every crossing the engine counts.')
console.log(lines.join('\n'))
await finish(0)
