/**
 * Drive two whole wake -> dictate -> transcribe -> send turns through the real page and report
 * what the host was actually sent.
 *
 * The complaint this exists for is that the *second* turn recognises speech, finishes
 * transcribing, and then sends nothing — or sends an empty prompt. The first turn is fine. Every
 * part of that loop lives on the far side of a `getUserMedia` call and an IPC round trip, so
 * reading the source settles nothing: both turns run the same lines of code.
 *
 * So both are run for real, in the installed bundle, with the two genuinely different pieces
 * stubbed at their boundaries and *logged*:
 *
 *   - the microphone is Chromium's fake capture device fed `two_round_mic.wav`, which holds two
 *     wake words and two utterances with real silences between them, so the engine's own
 *     thresholds decide what was heard rather than this script;
 *   - the host socket answers `transcribe` the way a real host does, and **counts and prints every
 *     `prompt` frame it receives**. That log is the whole point: "the text was empty" and "the
 *     text never arrived" look identical from the page, and only the host side tells them apart.
 *
 * Nothing here asserts. It reports, because a harness that decides what the answer is can be wrong
 * in the same direction as the bug it was written for.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const MAIN = join(INSTALLED, 'lib', 'main.js')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')
const MIC = join(HOME, 'Desktop', 'dsh-orb-cordis', 'dsh_orb', 'two_round_mic.wav')

for (const [label, path] of [['electron', RUNTIME], ['installed helper', MAIN], ['profile', PROFILE], ['mic wav', MIC]]) {
  if (!existsSync(path)) {
    console.error(`missing ${label}: ${path}`)
    process.exit(2)
  }
}

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
const port = process.argv[2] ?? '9444'

// Exactly what `orb.ts#wakeEnvironment` hands over, rebuilt from the profile on disk.
//
// `enabled` is forced on here, and deliberately not by editing the profile: the host passes its
// in-memory setting down at launch, and the file on disk is whatever was last written — which on
// this machine is `false`, because the switch was turned off through the UI at some point and the
// running DSH still has it on. Copying the file verbatim makes the page correctly publish
// `disabled` and sit there saying nothing for the whole run, which looks exactly like a broken
// harness and measures nothing. The real host would send `true`, so the harness does too.
const wakeEnabled = process.argv.includes('--wake-off') ? settings.enabled : true

// Exactly what `orb.ts#wakeEnvironment` hands over, rebuilt from the profile on disk.
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: settings.assetDirectory,
  DSH_ORB_WAKE: JSON.stringify({
    enabled: wakeEnabled,
    keyword: settings.keyword,
    threshold: settings.threshold,
    autoExpandOnWake: settings.autoExpandOnWake,
    dictation: settings.dictation,
  }),
}

if (settings.dictation?.autoSend !== true) {
  console.error(`profile has autoSend=${settings.dictation?.autoSend}; this harness needs it true to see a send`)
  process.exit(2)
}

const scratch = mkdtempSync(join(tmpdir(), 'orb-two-round-'))
const socketPort = 19500 + (process.pid % 300)
const token = `two-round-${process.pid}`

/**
 * A real read-aloud service, so the reply is genuinely spoken.
 *
 * This is not a detail. The page mutes the wake engine on both edges of the speaking state
 * (`syncSpeechButtons`), which is the only per-turn state that differs between the first turn and
 * the second: the first turn is recorded by a mute-less engine, the second by one that was muted
 * and unmuted by the reply in between. A harness that never speaks therefore never exercises the
 * only thing that changed, and reports both turns green while testing nothing about the report.
 *
 * It answers `POST /speak` with a short WAV built here — a plain tone, not speech, because the
 * audio's content is irrelevant and a synthesised voice would need the real service. What matters
 * is that the page receives decodable audio, plays it, and reports `speaking: true` and then
 * `false`, which is what drives the two mute edges.
 */
const speechPort = 18700 + (process.pid % 200)
const SPEECH_ENDPOINT = `http://127.0.0.1:${speechPort}`

/** One WAV of a 440 Hz tone, 16 kHz mono PCM16 — enough for the page to enter and leave `speaking`. */
function toneWav(seconds = 0.6, rate = 16000, freq = 440) {
  const samples = Math.floor(seconds * rate)
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000)
    buffer.writeInt16LE(value, 44 + i * 2)
  }
  return buffer
}

const speechCalls = []
const speechService = createHttpServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    if (!req.url?.endsWith('/speak')) {
      res.writeHead(404).end()
      return
    }
    speechCalls.push(Date.now())
    console.log(`[speech] /speak #${speechCalls.length} ${body.slice(0, 120)}`)
    const wav = toneWav()
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length })
    res.end(wav)
  })
})
speechService.on('error', () => {})
await new Promise((resolve) => speechService.listen(speechPort, '127.0.0.1', resolve))

/** Everything the host was told, in order. The verdict is read off this list. */
const hostSaw = []
let transcribeSeq = 0

/**
 * A host that answers the three things the page needs to get to a send, and records the rest.
 *
 * `tcc` must come back `applicable: false` — that is what a machine without those permissions
 * reports, and `tccReady()` treats it as "no gate", so the submit path is not held up behind a
 * dialog this script cannot click.
 */
const host = createServer((sock) => {
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
      if (type === 'transcribe') {
        transcribeSeq += 1
        const audio = typeof message.audioBase64 === 'string' ? message.audioBase64 : ''
        // The bytes, not a verdict on them: how much audio arrived is the first thing to separate
        // "the recorder heard nothing" from "the recorder worked and the recogniser returned junk".
        const bytes = audio.length === 0 ? 0 : Math.floor((audio.length * 3) / 4)
        const seconds = bytes / 2 / 16000
        console.log(`[host] transcribe #${transcribeSeq} id=${message.id} audio=${bytes}B ~${seconds.toFixed(2)}s`)
        hostSaw.push({ type, index: transcribeSeq, id: message.id, bytes, seconds })
        sock.write(`${JSON.stringify({ type: 'transcript', id: message.id, text: `第${transcribeSeq}轮识别到的文字` })}\n`)
        continue
      }
      if (type === 'prompt') {
        const text = typeof message.text === 'string' ? message.text : JSON.stringify(message)
        console.log(`[host] PROMPT >>> ${JSON.stringify(text)}`)
        hostSaw.push({ type, text })
        // A real host acknowledges the prompt and then streams a turn back. Without that the page
        // would sit in `running` forever and the second wake would be refused by its own guard, so
        // the stub sends a minimal turn and then goes quiet — which is what lets round two start.
        sock.write(`${JSON.stringify({ type: 'turn', message: { role: 'assistant', text: '收到' } })}\n`)
        sock.write(`${JSON.stringify({ type: 'idle' })}\n`)
        // Read-aloud on, so the page really does speak the reply and `mute()`/`unmute()` run.
        //
        // The first version of this harness left speech off, and both turns passed — which looked
        // like the bug was not reproducible. It is not evidence of that: with nothing ever spoken,
        // the mute edges never fired, and the mute is the one piece of per-turn state that differs
        // between round one and round two. Turning it on is what makes this run match the report.
        sock.write(`${JSON.stringify({
          type: 'chrome',
          speech: { enabled: true, autoPlay: true, endpoint: SPEECH_ENDPOINT },
        })}\n`)
        continue
      }
      if (type === 'tcc' || type === 'tcc-open') {
        sock.write(`${JSON.stringify({
          type: 'tcc',
          applicable: false,
          appName: 'DeepSeek Harness',
          screen: 'granted',
          accessibility: 'granted',
        })}\n`)
        continue
      }
      if (type === 'chrome-windows') continue
      console.log(`[host] ${type}`)
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

console.log(`profile: keyword=${settings.keyword} threshold=${settings.threshold} dictation=${JSON.stringify(settings.dictation)}`)
console.log(`stub host on 127.0.0.1:${socketPort}, page debugging port ${port}`)
console.log(`mic: ${MIC}`)

delete env.ELECTRON_RUN_AS_NODE

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  // The microphone stand-in. Chromium wants all three together: the fake device to exist, the file
  // to be the source, and the capture to be labelled NoloCapture so the page's getUserMedia
  // resolves the same way it does on the machine.
  '--use-fake-device-for-media-stream',
  '--use-file-for-fake-audio-capture',
  `--use-file-for-fake-audio-capture=${MIC}`,
  '--use-fake-ui-for-media-stream',
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
const page = list.find((t) => t.type === 'page' && /floating|shell/.test(t.url)) ?? list.find((t) => t.type === 'page')

if (page === undefined) {
  console.error('\n*** no debuggable page — the helper never opened one ***')
  child.kill()
  host.close()
  process.exit(3)
}

console.log(`page: ${page.url}`)
const ws = new WebSocket(page.webSocketDebuggerUrl)
const logs = []
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

let nextId = 1
const pendingCalls = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pendingCalls.has(msg.id)) {
    pendingCalls.get(msg.id)(msg)
    pendingCalls.delete(msg.id)
    return
  }
  if (msg.method === 'Log.entryAdded') logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`)
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (text !== '') logs.push(`[console.${msg.params.type}] ${text}`)
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    logs.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`)
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId += 1
  pendingCalls.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Log.enable')

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.result?.exceptionDetails) return { error: res.result.exceptionDetails.text }
  return res.result?.result?.value
}

/** The page's own view of the turn: badge, composer, engine counters. */
const SNAPSHOT = `(() => {
  const badge = document.querySelector('#wake-badge')
  const prompt = document.querySelector('#prompt')
  const engine = window.__probeEngine
  return JSON.stringify({
    body: document.body.className,
    badge: badge ? badge.textContent : null,
    expanded: document.body.classList.contains('expanded'),
    promptText: prompt ? (prompt.innerText ?? prompt.textContent) : null,
    promptLen: prompt ? (prompt.innerText ?? prompt.textContent ?? '').trim().length : null,
    wake: engine ? engine.status() : null,
    dictation: engine ? {
      active: engine.dictation !== undefined,
      frames: engine.dictation?.frames.length ?? 0,
      heard: engine.dictation?.heard ?? null,
    } : null,
    levels: engine ? Math.max(...engine.waveform()).toFixed(4) : null,
  })
})()`

/**
 * Expose the live engine so its counters can be read, rather than inferred from the badge.
 *
 * The page keeps its `WakeEngine` in a module-local `const` that no `Runtime.evaluate` can reach,
 * and `syncFromHelper` is what constructs it. Rather than build a second engine — two engines on
 * one microphone would fight over the frames — this reports the page's own observable state and
 * leaves the engine alone. `wakeState` is inferred from the badge text, which is rendered straight
 * from the state the page last published.
 */
const badgeStates = new Map([
  ['语音唤醒已开启', 'listening'],
  ['已听到唤醒词', 'detected'],
  ['正在听你说', 'recording'],
  ['正在识别', 'transcribing'],
  ['语音唤醒加载中', 'loading'],
  ['语音唤醒不可用', 'error'],
  ['语音唤醒已关闭', 'disabled'],
])

/** Which engine state the badge is currently reporting, `undefined` when it says nothing. */
function stateFromBadge(badge) {
  if (badge === null || badge === undefined || badge === '') return undefined
  for (const [needle, state] of badgeStates) {
    if (badge.includes(needle)) return state
  }
  return undefined
}

console.log('\n--- watching ---')
const started = Date.now()
const seen = new Set()
let lastBadge = null
let sawListening = false

// 27 s of audio, two turns, plus room for the models to load, both replies to be spoken, and the
// wake engine to be muted and unmuted in between.
while (Date.now() - started < 150_000) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const snap = await evaluate(SNAPSHOT)
  if (snap === undefined || snap === null) continue
  let parsed
  try {
    parsed = JSON.parse(snap)
  } catch {
    continue
  }
  if (parsed.error !== undefined) {
    console.log(`snapshot failed: ${parsed.error}`)
    continue
  }
  const badge = parsed.badge ?? ''
  if (badge !== lastBadge) {
    console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] badge: ${badge}`)
    lastBadge = badge
  }
  const state = stateFromBadge(badge)
  if (state === 'listening') sawListening = true
  const key = `${badge}|${parsed.promptLen}`
  if (!seen.has(key) && (badge !== '' || parsed.promptLen > 0)) {
    seen.add(key)
    console.log(`         state=${state} promptLen=${parsed.promptLen} peakLevel=${parsed.levels}`)
  }
  if (state === 'error') {
    console.log(`\n*** engine reported an error: ${badge} ***`)
    break
  }
  // Two prompts to the host is the whole run; stop as soon as both have landed.
  if (hostSaw.filter((entry) => entry.type === 'prompt').length >= 2) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    break
  }
}

console.log('\n================ what the host received ================')
const prompts = hostSaw.filter((entry) => entry.type === 'prompt')
const transcribes = hostSaw.filter((entry) => entry.type === 'transcribe')
console.log(`read-aloud calls: ${speechCalls.length}${speechCalls.length === 0
  ? '  *** THE REPLY WAS NEVER SPOKEN — mute()/unmute() never ran, so this run does not test the report ***'
  : '  (mute/unmute edges exercised)'}`)

// A run in which the engine never reached `listening` measured nothing at all. Saying "no
// transcribe reached the host" there would read as a verdict about the product, and the first
// version of this harness did exactly that: the profile said `enabled: false`, the page correctly
// published `disabled`, and the report looked like a clean negative result.
if (!sawListening) {
  console.log('*** THE ENGINE NEVER REACHED `listening` — this run proves NOTHING ***')
  console.log('    (check `enabled` in the env handed over, and that the fake mic flags took effect)')
} else if (transcribes.length === 0) {
  console.log('NO transcribe request ever reached the host')
} else {
  for (const entry of transcribes) {
    console.log(`transcribe #${entry.index}: ${entry.bytes} bytes, ~${entry.seconds.toFixed(2)}s of audio`)
  }
}
if (prompts.length === 0) {
  console.log('NO prompt ever reached the host')
} else {
  for (const [index, entry] of prompts.entries()) {
    const text = typeof entry.text === 'string' ? entry.text : JSON.stringify(entry.text)
    console.log(`prompt #${index + 1}: ${JSON.stringify(text)} (length ${text.length})`)
  }
}

console.log('\n================ page log ================')
if (logs.length === 0) console.log('(nothing logged)')
else for (const line of logs) console.log(`  ${line}`)

ws.close()
child.kill()
host.close()
await new Promise((resolve) => child.once('exit', resolve))
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  /* best effort */
}
