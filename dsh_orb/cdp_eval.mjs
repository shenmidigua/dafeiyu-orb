/**
 * Evaluate an expression inside the ball's page over CDP, and collect console/CSP messages.
 *
 * Used to answer questions the ball's own UI cannot surface — e.g. whether the page's CSP lets a
 * `fetch` reach the local TTS service. Requires a helper started with --remote-debugging-port=9222
 * (fake-host.mjs does that).
 */
const PORT = process.argv[2] ?? '9222'
const EXPR = process.argv[3] ?? "1 + 1"

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
const page = targets.find((t) => t.type === 'page' && /floating|shell/.test(t.url)) ?? targets.find((t) => t.type === 'page')
if (!page) {
  console.log('NO PAGE TARGET. targets:', targets.map((t) => `${t.type} ${t.url}`).join(' | '))
  process.exit(1)
}
console.log('page:', page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', reject)
})

let nextId = 1
const pending = new Map()
const logs = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg)
    pending.delete(msg.id)
    return
  }
  if (msg.method === 'Log.entryAdded') {
    logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`)
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ')
    if (text) logs.push(`[console.${msg.params.type}] ${text}`)
  }
})

function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

await send('Runtime.enable')
await send('Log.enable')

const result = await send('Runtime.evaluate', {
  expression: EXPR,
  awaitPromise: true,
  returnByValue: true,
})

console.log('--- result ---')
if (result.result?.exceptionDetails) {
  console.log('EXCEPTION:', JSON.stringify(result.result.exceptionDetails).slice(0, 600))
} else {
  console.log(JSON.stringify(result.result?.result?.value, null, 2))
}

await new Promise((r) => setTimeout(r, 600))
console.log('--- console / security log ---')
console.log(logs.length ? logs.join('\n') : '(none)')

ws.close()
process.exit(0)
