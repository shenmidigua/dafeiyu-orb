/**
 * Run one helper in isolation with a debugging port, and ask the ball page what it says about
 * the wake word.
 *
 * The running Desktop helper cannot be inspected: its `DevToolsActivePort` is stale and 9222
 * refuses connections. This launches a second copy of the *installed* bundle with the same
 * environment the host hands over, so the failure the user sees can be reproduced and read
 * rather than guessed at.
 *
 * A dedicated user-data-dir keeps it from touching the live helper's session, and the socket
 * handshake is not answered — nothing is plugged in, which is the point: the failure must be in
 * the wake engine, not in a missing backend.
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

const HOME = homedir()
const RUNTIME = join(HOME, '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const INSTALLED = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper')
const MAIN = join(INSTALLED, 'lib', 'main.js')
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop', 'orb-wake.json')

const settings = JSON.parse(readFileSync(PROFILE, 'utf8'))
const port = process.argv[2] ?? '9333'

// Exactly what `orb.ts#wakeEnvironment` hands over, rebuilt from the profile on disk.
const assets = settings.assetDirectory
const env = {
  ...process.env,
  DSH_ORB_WAKE_ASSETS: assets,
  DSH_ORB_WAKE: JSON.stringify({
    enabled: settings.enabled,
    keyword: settings.keyword,
    threshold: settings.threshold,
    autoExpandOnWake: settings.autoExpandOnWake,
    dictation: settings.dictation,
  }),
}

const scratch = mkdtempSync(join(tmpdir(), 'orb-wake-repro-'))
console.log(`repro: user-data-dir ${scratch}`)
console.log(`repro: DSH_ORB_WAKE_ASSETS ${assets}`)
console.log(`repro: DSH_ORB_WAKE ${env.DSH_ORB_WAKE}`)
console.log(`repro: debugging port ${port}`)

// The host deletes this before spawning (`orb.ts#launch`). The sandbox sets it, and without the
// delete electron.exe runs as plain Node: `import ... from 'electron'` resolves to the stub and
// dies with "does not provide an export named 'BrowserWindow'" before any window exists — a
// failure of this harness, not of the product.
delete env.ELECTRON_RUN_AS_NODE

// The helper refuses to open a window without these two (`main.ts:101`), so a socket endpoint
// has to exist. This is the thinnest thing that satisfies it: accept, read, discard, never
// answer. Anything the page needs from the host — transcript, appearance, TTS — is genuinely
// absent here, which is correct: the wake engine must fail (or succeed) on its own.
const socketPort = 19400 + (process.pid % 400)
const token = `repro-${process.pid}`
const host = createServer((sock) => {
  sock.on('data', () => {})
  sock.on('error', () => {})
})
await new Promise((resolve, reject) => {
  host.once('error', reject)
  host.listen(socketPort, '127.0.0.1', resolve)
})
env.DSH_ORB_SOCKET = `127.0.0.1:${socketPort}`
env.DSH_ORB_TOKEN = token
console.log(`repro: host stub on 127.0.0.1:${socketPort}`)

const child = spawn(RUNTIME, [
  `--user-data-dir=${scratch}`,
  MAIN,
  `--remote-debugging-port=${port}`,
  '--no-sandbox',
], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

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
      console.log(`[${label}] ${text}`)
    }
  })
}
relay('stdout', child.stdout)
relay('stderr', child.stderr)

const opener = null
void opener

/** Poll the debugging endpoint until the ball's page shows up. */
async function targets() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json`)
      const list = await response.json()
      if (list.length > 0) return list
    } catch {
      // Not listening yet, or not this process's.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return []
}

const list = await targets()
if (list.length === 0) {
  console.log('\n*** no debuggable page — the helper never opened one ***')
} else {
  const page = list.find((t) => t.type === 'page' && /floating|shell/.test(t.url))
    ?? list.find((t) => t.type === 'page')
  console.log(`\npage: ${page.url}`)

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  const seen = []
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === 'Log.entryAdded') {
      seen.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`)
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
      if (text !== '') seen.push(`[console.${msg.params.type}] ${text}`)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      seen.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`)
    }
  })

  const send = (method, params = {}) => new Promise((resolve) => {
    const id = nextId += 1
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

  await send('Runtime.enable')
  await send('Log.enable')

  // Give the engine time to load four models and either report or fail.
  for (const wait of [3000, 5000, 8000]) {
    await new Promise((resolve) => setTimeout(resolve, wait))
    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const body = document.body.className
        const badge = document.querySelector('#wake-badge')
        const ball = document.querySelector('#ball')
        return JSON.stringify({
          bodyClass: body,
          badgeText: badge ? badge.textContent : null,
          ballTitle: ball ? ball.getAttribute('title') : null,
        })
      })()`,
      returnByValue: true,
    })
    const value = probe.result?.result?.value
    console.log(`\n--- after ${wait} ms of page life ---\n${value}`)
  }

  // The helper's own line said "detail is not defined", which is a ReferenceError raised
  // somewhere while the failure was being reported — so the report itself is the thing that
  // broke. Ask for the stack, not for the message.
  const stack = await send('Runtime.evaluate', {
    expression: `(() => {
      try { new Function('detail', 'return detail') } catch (e) { /* ignore */ }
      return 'probe-only'
    })()`,
    returnByValue: true,
  })
  console.log(`\nstack probe: ${JSON.stringify(stack.result?.result?.value)}`)

  // Re-run the report path by hand with a failing payload and watch what escapes.
  const retry = await send('Runtime.evaluate', {
    expression: `(async () => {
      const out = []
      try {
        const mod = await import('./wake.js')
        const engine = new mod.WakeEngine(window.orb, { onStatus: (s) => out.push(s) })
        await engine.fail(new Error('probe-message'))
        return JSON.stringify({ ok: true, out })
      } catch (e) {
        return JSON.stringify({ ok: false, name: e.name, message: e.message,
          stack: String(e.stack).split('\\n').slice(0, 6).join(' | ') })
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  const retryValue = retry.result?.result?.value
    ?? JSON.stringify(retry.result)
  console.log(`\nfail() path: ${retryValue}`)

  if (seen.length > 0) {
    console.log('\n--- page log ---')
    for (const line of seen) console.log(`  ${line}`)
  } else {
    console.log('\n*** the page logged nothing at all ***')
  }

  ws.close()
}

child.kill()
host.close()
await new Promise((resolve) => child.once('exit', resolve))
try {
  rmSync(scratch, { recursive: true, force: true })
} catch {
  // Scratch cleanup is best-effort; a leftover temp directory is not worth a failed run.
}
