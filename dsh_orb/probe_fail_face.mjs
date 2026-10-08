/**
 * Prove the failure face end to end: the turn message the host sends, all the way to the GIF on the ball.
 *
 * Why this exists: the host decides "this run failed" from DSH's `turn/end` reason, and the page decides
 * which face that means. Neither half can be checked by reading a file — the only place both are visible
 * at once is the `<img>` the ball is wearing. So this runs one helper against a *stub host* it controls,
 * speaks the real socket protocol to it, and asks the page what it is showing, comparing the image's own
 * `data:` URL against the clips read from the configured pack. "The ball is crying" then means those
 * bytes, not a mode string.
 *
 * The cases are the whole rule, not just the happy one: a failed run wears the failure face and hands
 * the ball back when its pass is over; a run that ended by itself still rings the bell; and a run the
 * *user* stopped does neither — that last one is the case a naive "anything but completed" rule gets
 * wrong, and it is 26 of the 166 turn ends in this machine's own logs.
 *
 * The helper is pointed at a scratch `helper-data/<id>` directory with a copy of `memes.json` in the
 * directory above it, which is exactly the layout the host creates, so this probe reads the live
 * configuration without being able to touch it.
 *
 * Usage: `probe_fail_face.mjs [--port 9455] [--keep]`
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const LIVE_CONFIG = join(HOME, '.dsh', 'dsh-orb', 'memes.json')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const port = flag('port', '9455')

const config = JSON.parse(readFileSync(LIVE_CONFIG, 'utf8'))
const files = {
  idle: config.idle?.file,
  poor: config.poor?.file,
  done: config.done?.file,
  fail: config.fail?.file,
}
for (const [slot, name] of Object.entries(files)) {
  if (typeof name !== 'string' || name === '') {
    console.log(`FAIL: the live memes.json names no ${slot} file, so this probe cannot tell the faces apart`)
    process.exit(1)
  }
}

/**
 * The clips that mean "the ball is resting", which is more than the idle file.
 *
 * A pack's idle skit is a resting loop with a schedule: it puts a *different* file up every so often,
 * with no cue behind it. The poor face is the resting loop under a low balance. Both are the ball at
 * rest, so both are labelled `rest` and neither can be mistaken for a face under test.
 */
const resting = [
  config.idle?.file,
  config.poor?.file,
  // A skit plan names its clips in a pool and, in older shapes, in one `file`/`item`.
  ...Object.values(config.skit?.files ?? {}),
  config.skit?.file,
  config.skit?.item?.file,
].filter((name) => typeof name === 'string' && name !== '')

/** Every image under a directory, by the resolver's own recursive rule. */
function imagesUnder(root, depth = 0, out = []) {
  if (depth > 4) return out
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) imagesUnder(path, depth + 1, out)
    else if (entry.isFile() && /\.(gif|png|jpe?g|webp)$/i.test(entry.name)) out.push(path)
  }
  return out
}

/** The `data:` URL the page builds for one file, byte for byte: the picker's own rule. */
function dataUrlFor(name) {
  const path = imagesUnder(config.dir).find((candidate) => candidate.endsWith(`\\${name}`) || candidate.endsWith(`/${name}`))
  if (path === undefined) throw new Error(`${name} is not under ${config.dir}`)
  return `data:image/gif;base64,${readFileSync(path).toString('base64')}`
}

const urls = Object.fromEntries(Object.entries(files).map(([slot, name]) => [slot, dataUrlFor(name)]))
// One label per resting clip, so a skit can never be mistaken for a face under test.
const restUrls = new Set(resting.flatMap((name) => {
  try {
    return [dataUrlFor(name)]
  } catch {
    return []
  }
}))

/**
 * What the ball is wearing, in the terms this probe cares about: the face under test, or "resting".
 *
 * A resting ball is more than the idle file. A pack's idle skit puts a *different* clip up every so
 * often with no cue behind it, and the poor face is the resting loop under a low balance — so a probe
 * that only knew `idle` would read those moments as "something else" and fail on a ball that is behaving
 * perfectly. Everything resting is one label here; the faces under test are told apart from it, not from
 * each other (the poor face has its own probe).
 *
 * An unmatched clip is reported with a short fingerprint of its bytes rather than a bare "other",
 * because "other" is exactly the answer that needs a name when a run of this probe goes wrong.
 */
function faceOf(src) {
  if (src === null || src === undefined) return 'none'
  const known = Object.entries(urls).find(([, url]) => url === src)
  if (known !== undefined) return known[0] === 'done' || known[0] === 'fail' ? known[0] : 'rest'
  if (restUrls.has(src)) return 'rest'
  return `other#${createHash('sha1').update(src).digest('hex').slice(0, 6)}`
}

const scratch = mkdtempSync(join(tmpdir(), 'orb-fail-probe-'))
mkdirSync(join(scratch, 'helper-data', 'probe'), { recursive: true })
copyFileSync(LIVE_CONFIG, join(scratch, 'memes.json'))
console.log(`probe: ${scratch}`)
console.log(`probe: idle ${files.idle} | done ${files.done} | fail ${files.fail}`)

const clients = new Set()
const host = createServer((socket) => {
  clients.add(socket)
  socket.on('data', () => {})
  socket.on('error', () => {})
  socket.on('close', () => clients.delete(socket))
})
const socketPort = 19600 + (process.pid % 300)
await new Promise((resolve, reject) => {
  host.once('error', reject)
  host.listen(socketPort, '127.0.0.1', resolve)
})

const env = { ...process.env, DSH_ORB_SOCKET: `127.0.0.1:${socketPort}`, DSH_ORB_TOKEN: `probe-${process.pid}` }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(RUNTIME, [
  `--user-data-dir=${join(scratch, 'helper-data', 'probe')}`,
  join(INSTALLED, 'lib', 'main.js'),
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
child.stderr.setEncoding('utf8')
child.stderr.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.includes('turn failed') || line.includes('turn done')) console.log(`[helper] ${line.trim()}`)
  }
})

/** Send one host message to every connected helper, the way `OrbRuntime.broadcast` does. */
function say(message) {
  const text = `${JSON.stringify(message)}\n`
  for (const socket of clients) socket.write(text)
  console.log(`probe -> ${text.trim()}`)
}

const problems = []

/** Poll the debugging endpoint until the ball's own page appears. */
async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = list.filter((t) => t.type === 'page').find((t) => /floating\.html/.test(t.url))
      if (page !== undefined) return page
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return undefined
}

const page = await pageTarget()
if (page === undefined) {
  problems.push('the helper never opened a page')
  child.kill()
  host.close()
  console.log(problems.join('\n'))
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})
let nextId = 1
const pending = new Map()
ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId += 1
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
await send('Runtime.enable')

/** What the ball is wearing right now, in terms of the configured files. */
async function look() {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const gif = document.querySelector('#ball-gif')
      return JSON.stringify({ mode: gif ? gif.dataset.mode : null, src: gif ? gif.src : null })
    })()`,
    returnByValue: true,
  })
  const now = JSON.parse(result.result?.result?.value ?? '{}')
  return { ...now, face: faceOf(now.src) }
}

/**
 * Watch the ball for a while and report the faces it wore, in order.
 *
 * A face is a *one-shot*: it is up for its clip's length and then the resting logic takes the ball back,
 * so the answer to "did it cry?" is not a state but a sequence. Polling and collecting is the only way
 * to ask that honestly.
 */
async function watch(seconds, step = 120) {
  const seen = []
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    const now = await look()
    if (seen.length === 0 || seen[seen.length - 1].face !== now.face) seen.push({ face: now.face, at: Date.now() })
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  return seen
}

const show = (seen) => seen.map((entry) => entry.face).join(' -> ')

/**
 * Wait until the ball is at rest, so every case starts from the same place and its first sample is not
 * somebody else's clip. A cue that is still up from the previous case would otherwise be read as this
 * case's first face — which is exactly how a probe starts failing on a ball that is behaving.
 */
async function settleToRest(seconds = 20, step = 120) {
  const deadline = Date.now() + seconds * 1000
  const recent = []
  while (Date.now() < deadline) {
    const now = await look()
    recent.push(now.face)
    if (recent.length > 3) recent.shift()
    if (recent.length === 3 && recent.every((face) => face === 'rest')) return true
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  return false
}

/**
 * One case: say something, watch, and require what the ball did with it.
 *
 * `wanted` is a run of faces that has to appear **in order and next to each other** somewhere in the
 * window, rather than from its first sample: the poll before the first one may already be past the
 * moment the cue went up, so requiring a leading `rest` would fail on a ball that is behaving — and a
 * leading `rest` is not what this probe is asking about anyway. What it is asking is that the face
 * appeared and that the ball handed itself back afterwards.
 *
 * `forbidden` is the other half, and for a cancellation it is the whole of the check: the face that must
 * *not* appear is the only observable difference between "the user stopped this" and "this failed".
 */
async function check(label, messages, wanted, seconds, forbidden = []) {
  const calm = await settleToRest()
  if (!calm) problems.push(`${label}: the ball never came to rest before this case`)
  for (const message of messages) say(message)
  const seen = await watch(seconds)
  const faces = seen.map((entry) => entry.face)
  // An empty `wanted` is not "nothing satisfied it": it means this case is only about what must *not*
  // appear, and `[].some(...)` is false — which would report a cancellation as a failure of the check.
  const ran = wanted.length === 0
    || wanted.some((_, start) => wanted.every((face, index) => faces[start + index] === face))
  const unwanted = forbidden.filter((face) => faces.includes(face))
  const ok = calm && ran && unwanted.length === 0
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: ${show(seen)}`)
  if (!ok) {
    problems.push(`${label}: expected ${wanted.join(' -> ') || 'no cue'}`
      + `${forbidden.length > 0 ? ` and none of ${forbidden.join('/')}` : ''}, saw ${show(seen)}`)
  }
}

// The greeting owns the ball for its first seconds, so the first case waits it out; every case after
// that waits for rest again, which is what makes a run of this probe repeatable.
console.log('\nwaiting for the greeting to hand over…')
const settled = await watch(20)
console.log(`  ${show(settled)}`)
if (!settled.some((entry) => entry.face === 'rest')) {
  problems.push('the resting loop never appeared after the greeting')
}

await check('a run that failed cries, then rests',
  [{ type: 'turn', running: true }, { type: 'turn', running: false, failed: true }],
  ['fail', 'rest'], 6, ['done'])

await check('a run that ended by itself still rings the bell',
  [{ type: 'turn', running: true }, { type: 'turn', running: false }],
  ['done', 'rest'], 6, ['fail'])

// A user stop is `aborted`, and the host turns that into neither `failed` nor a bell. 26 of the 166
// turn ends in this machine's logs are exactly this, so getting it wrong would cry at the user's own
// stop — the loudest possible version of "the ball misunderstood".
await check('a run the user stopped does neither',
  [{ type: 'turn', running: true }, { type: 'turn', running: false, interrupted: true }],
  [], 3, ['fail', 'done'])

// And the failure face does not need to have seen the turn start: the host reports the ending it read
// from the log, which for a turn the page loaded in the middle of is the first thing it says.
await check('a failure reported without a start still cries',
  [{ type: 'turn', running: false, failed: true }],
  ['fail', 'rest'], 6, ['done'])

ws.close()
child.kill()
host.close()
await new Promise((resolve) => child.once('exit', resolve))
if (!args.includes('--keep')) {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    // Best effort: a leftover temp directory is not worth a failed run.
  }
}

console.log(problems.length === 0
  ? '\nOK: a failed run cries, a finished one rings, a cancelled one does neither'
  : `\n${problems.length} PROBLEM(S)`)
for (const problem of problems) console.log(`  ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
