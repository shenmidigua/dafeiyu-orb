/**
 * Why is the badge empty?
 *
 * `wake_phrase_verify.mjs` reports page errors only when they mention the wake word, which is right
 * for its own verdict — it deliberately leaves the host socket unanswered, so page grumbling about a
 * missing backend must not fail a run. But when the badge never appears at all, the interesting error
 * is exactly the one that does not mention the wake word, and that filter throws it away.
 *
 * Same helper, same flags, everything printed: every target, the page's own state, and every
 * exception and console line with nothing filtered out.
 *
 * Usage: node wake_accept_diagnose.mjs [--seconds 20] [--mic wake-mic-single.wav]
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve } from 'node:path'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')
const HERE = import.meta.dirname

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}

const seconds = Number(arg('seconds', '20'))
const port = arg('port', '9610')
const mic = resolve(HERE, arg('mic', 'wake-mic-single.wav'))
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

const socketPort = 19700 + (process.pid % 200)
const host = createServer((sock) => {
  sock.on('data', () => {})
  sock.on('error', () => {})
})
await new Promise((ok) => host.listen(socketPort, '127.0.0.1', ok))
env.DSH_ORB_SOCKET = `127.0.0.1:${socketPort}`
env.DSH_ORB_TOKEN = 'diagnose'

const scratch = mkdtempSync(join(tmpdir(), 'orb-diag-'))
const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  join(INSTALLED, 'lib', 'main.js'),
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
  '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${mic}`,
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
    for (const line of lines) if (line.trim()) log.push(`[${label}] ${line.trim()}`)
  })
}

async function targets() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      if (list.length) return list
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  return []
}

const list = await targets()
console.log('=== targets ===')
for (const t of list) console.log(`  ${String(t.type).padEnd(9)} ${t.url}\n            title=${JSON.stringify(t.title)}`)

const pages = list.filter((t) => t.type === 'page')
console.log()
console.log(`=== ${pages.length} page target(s) ===`)

for (const page of pages) {
  console.log()
  console.log(`---- ${page.url}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
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
      const d = msg.params.exceptionDetails
      errors.push(`EXCEPTION ${d.exception?.description ?? d.text}`)
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      errors.push(`console.${msg.params.type} ${msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
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
  await new Promise((r) => setTimeout(r, Math.min(seconds, 6) * 1000))

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const badge = document.querySelector('#wake-badge')
      return JSON.stringify({
        href: location.href,
        ready: document.readyState,
        title: document.title,
        bodyClass: document.body ? document.body.className : null,
        hasBadge: badge !== null,
        badgeText: badge ? badge.textContent : null,
        // Any global the page uses to expose the engine, whatever it is named.
        globals: Object.keys(globalThis).filter((k) => /wake|engine|orb/i.test(k)),
      })
    })()`,
    returnByValue: true,
  })
  console.log(`  state: ${probe.result?.result?.value}`)
  console.log(`  errors (${errors.length}):`)
  for (const line of errors.slice(0, 25)) console.log(`    ${line}`)
  ws.close()
}

child.kill()
host.close()
await new Promise((r) => setTimeout(r, 400))
try { rmSync(scratch, { recursive: true, force: true }) } catch { /* best effort */ }

console.log()
console.log('=== helper output ===')
for (const line of log.slice(-30)) console.log(`  ${line}`)
process.exit(0)
