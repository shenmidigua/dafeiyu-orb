/**
 * Prove the poor face end to end: the balance message the host sends, all the way to the GIF bytes
 * on the ball.
 *
 * Why this exists: the decision this feature makes cannot be read out of any one file. The host reads
 * the account, the helper turns the message into a page event, the page picks between two loops, and
 * the only place all of that is visible at once is the `<img>` the ball is actually wearing. So this
 * runs one helper against a *stub host* it controls, speaks the real protocol to it, and asks the
 * page which file it is showing — by comparing the image's own `data:` URL against the two candidate
 * GIFs read from disk, so "the poor face is up" means those exact bytes and not merely a mode string.
 *
 * It also covers the case the feature is most likely to get wrong: a balance that is *unknown*. The
 * host says `cny: null` for a signed-out account, an unreachable Platform or a build with no client
 * version, and the ball has to keep its ordinary resting loop — a failed lookup read as zero would
 * put the sad face on every machine that never signed in.
 *
 * The helper is pointed at a scratch `helper-data/<id>` directory with a *copy* of `memes.json` in the
 * directory above it, which is exactly the layout the host creates, so this probe reads the live
 * configuration without being able to touch it.
 *
 * Usage: `probe_poor_balance.mjs [--port 9444] [--keep]`
 */

import { spawn } from 'node:child_process'
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
const port = flag('port', '9444')

const config = JSON.parse(readFileSync(LIVE_CONFIG, 'utf8'))
const idleFile = config.idle?.file
const poorFile = config.poor?.file
if (typeof idleFile !== 'string' || typeof poorFile !== 'string') {
  console.log(`FAIL: the live memes.json names no ${typeof idleFile === 'string' ? 'poor' : 'idle'} file`)
  process.exit(1)
}

/** The `data:` URL the page builds for one file, byte for byte: the picker's own rule. */
function dataUrlFor(name) {
  const path = imagesUnder(config.dir).find((candidate) => candidate.endsWith(`\\${name}`) || candidate.endsWith(`/${name}`))
  if (path === undefined) throw new Error(`${name} is not under ${config.dir}`)
  return `data:image/gif;base64,${readFileSync(path).toString('base64')}`
}

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

const scratch = mkdtempSync(join(tmpdir(), 'orb-poor-probe-'))
// The host's own layout: the helper's `runtimeDirectory()` walks up out of `helper-data`, so the
// config has to sit one level above the profile directory it is handed.
mkdirSync(join(scratch, 'helper-data', 'probe'), { recursive: true })
copyFileSync(LIVE_CONFIG, join(scratch, 'memes.json'))
console.log(`probe: ${scratch}`)
console.log(`probe: idle -> ${idleFile}, poor -> ${poorFile}, below ${config.poor.below}`)

// The thinnest host that can answer the handshake and then say what this probe wants said.
const clients = new Set()
const host = createServer((socket) => {
  clients.add(socket)
  socket.on('data', () => {})
  socket.on('error', () => {})
  socket.on('close', () => clients.delete(socket))
})
const socketPort = 19500 + (process.pid % 400)
await new Promise((resolve, reject) => {
  host.once('error', reject)
  host.listen(socketPort, '127.0.0.1', resolve)
})

const env = {
  ...process.env,
  DSH_ORB_SOCKET: `127.0.0.1:${socketPort}`,
  DSH_ORB_TOKEN: `probe-${process.pid}`,
}
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
    if (line.includes('error') || line.includes('helper:')) console.log(`[helper] ${line.trim()}`)
  }
})

/** Send one host message to every connected helper. */
function say(message) {
  const text = `${JSON.stringify(message)}\n`
  for (const socket of clients) socket.write(text)
  console.log(`probe -> ${text.trim()}`)
}

/** Poll the debugging endpoint until the ball's own page appears. */
async function pageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const pages = list.filter((t) => t.type === 'page')
      // The helper owns several windows (the ball, the observation frame, the selection toolbar), so
      // the target is picked by the page it loaded rather than by being the first one to show up.
      const ball = pages.find((t) => /floating\.html/.test(t.url))
        ?? pages.find((t) => /floating|shell/.test(t.url))
      if (ball !== undefined) {
        console.log(`probe: page ${ball.url}`)
        for (const other of pages) console.log(`probe:   other target ${other.url}`)
        return ball
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return undefined
}

const problems = []
const page = await pageTarget()
if (page === undefined) {
  problems.push('the helper never opened a page')
} else {
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  let nextId = 1
  const pending = new Map()
  const pageProblems = []
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      pageProblems.push(`exception: ${message.params.exceptionDetails?.text} ${message.params.exceptionDetails?.exception?.description ?? ''}`)
    }
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      pageProblems.push(`[${message.params.entry.level}] ${message.params.entry.text}`)
    }
  })
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId += 1
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
  await send('Runtime.enable')
  await send('Log.enable')

  /** What the ball is wearing right now: the page's own mode, and the image it handed the element. */
  const look = async () => {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const gif = document.querySelector('#ball-gif')
        return JSON.stringify({
          mode: gif ? gif.dataset.mode : null,
          src: gif ? gif.src : null,
          href: location.href,
          ready: document.readyState,
          images: document.images.length,
        })
      })()`,
      returnByValue: true,
    })
    return JSON.parse(result.result?.result?.value ?? '{}')
  }

  /** Wait for the ball to settle on one file, and say what it was wearing when it did. */
  const settle = async (src, seconds = 12) => {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const now = await look()
      if (now.src === src) return now
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    const now = await look()
    return { ...now, missed: true }
  }

  const idleUrl = dataUrlFor(idleFile)
  const poorUrl = dataUrlFor(poorFile)
  console.log(`probe: idle ${idleUrl.length} chars, poor ${poorUrl.length} chars`)

  /** One case: say something, then check which file the ball ends up wearing. */
  const check = async (label, message, expected) => {
    say(message)
    const seen = await settle(expected.url)
    const ok = !seen.missed && seen.src === expected.url
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}: mode ${seen.mode}, ${seen.src === poorUrl ? '自我安慰' : seen.src === idleUrl ? 'idle' : 'something else'}`)
    if (!ok) problems.push(`${label}: expected ${expected.name}, saw mode ${seen.mode}`)
  }

  // The greeting plays first and owns the ball for about four seconds; it is not what is under test,
  // so the first case waits for it to hand over.
  console.log('\nwaiting for the arrival sequence to finish…')
  const afterGreeting = await settle(idleUrl, 20)
  console.log(`${afterGreeting.src === idleUrl ? 'ok  ' : 'FAIL'}  the greeting hands over to the resting loop`)
  if (afterGreeting.src !== idleUrl) {
    problems.push('the resting loop never appeared after the greeting')
    const first = await look()
    console.log(`      page: ${first.href} ready=${first.ready} images=${first.images} mode=${first.mode}`)
    for (const line of pageProblems.slice(0, 8)) console.log(`      ${line}`)
  }

  // Every amount is derived from the live line rather than written here. The line is a configuration
  // value somebody will change (it has been 60 and then 5), and a probe full of numbers that only mean
  // "under" or "over" *that* line would start reporting the wrong verdict the moment it moved.
  const line = config.poor.below
  console.log(`probe: the live line is ${line} CNY`)
  await check('no balance said yet keeps the ordinary loop', { type: 'balance', cny: null }, { url: idleUrl, name: 'idle' })
  await check('a healthy balance keeps the ordinary loop',
    { type: 'balance', cny: line + 100, at: Date.now() }, { url: idleUrl, name: 'idle' })
  await check('a balance under the line wears the poor face',
    { type: 'balance', cny: Math.max(0, line - 1), at: Date.now() }, { url: poorUrl, name: 'poor' })
  await check('a top-up takes the poor face off again',
    { type: 'balance', cny: line * 4, at: Date.now() }, { url: idleUrl, name: 'idle' })
  await check('a failed read is not a zero', { type: 'balance', cny: null, at: Date.now() }, { url: idleUrl, name: 'idle' })
  await check('a message with no number at all is not a zero', { type: 'balance' }, { url: idleUrl, name: 'idle' })
  await check('exactly the line is not below it', { type: 'balance', cny: line }, { url: idleUrl, name: 'idle' })
  await check('a cent under the line is', { type: 'balance', cny: line - 0.01 }, { url: poorUrl, name: 'poor' })
  await check('zero really is below it', { type: 'balance', cny: 0, at: Date.now() }, { url: poorUrl, name: 'poor' })

  ws.close()
}

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

console.log(problems.length === 0 ? '\nOK: every balance the host can send lands on the right face' : `\n${problems.length} PROBLEM(S)`)
for (const problem of problems) console.log(`  ${problem}`)
process.exit(problems.length === 0 ? 0 : 1)
