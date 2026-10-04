/**
 * Walk the read-aloud path inside the real page, and report what each step did.
 *
 * Why this exists: the audio is MP3 now rather than the WAV a local model produced, and the page
 * plays it from a blob URL. Whether that works is a claim about the page's own content security
 * policy (`media-src 'self' blob:`, `connect-src` to loopback only) plus Chromium's media stack, and
 * none of the unit tests can reach either. It also walks the failure path on purpose — the first
 * request is expected to fail when nothing is listening, and the host is then asked to start the
 * service, exactly as `speech.js` does — so this checks the whole cold-start chain rather than a
 * service that happened to already be up.
 *
 * `Failed to fetch` is the same sentence whether the service is absent or the request was refused by
 * policy, so the port is probed from Node as well. That separates the two: if Node reaches it and
 * the page does not, the page is what is blocking.
 *
 * Usage: `voice_check.mjs [port]`
 */

const port = Number(process.argv[2] || 9222)

// Plain Node fetch, which does not read HTTP_PROXY, so this is a direct connection.
async function serviceUp() {
  try {
    const response = await fetch('http://127.0.0.1:8765/health', { signal: AbortSignal.timeout(2000) })
    return `HTTP ${response.status}`
  } catch (error) {
    return `unreachable (${error.cause?.code || error.name})`
  }
}

const PROBE = `(async () => {
  const out = { steps: [] }
  const step = (name, value) => { out.steps.push([name, value]) }

  const ask = async () => {
    const response = await fetch('http://127.0.0.1:8765/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '现在用的是小女孩的声音。' }),
    })
    if (!response.ok) throw new Error('service said ' + response.status)
    return response
  }

  let response
  try {
    response = await ask()
    step('fetch', 'ok without starting anything')
  } catch (error) {
    step('fetch #1', error.name + ': ' + error.message)
    if (!window.dshOrb || typeof window.dshOrb.ensureSpeech !== 'function') {
      step('ensure', 'no dshOrb.ensureSpeech on this page')
      return out
    }
    const started = await window.dshOrb.ensureSpeech()
    step('ensure', JSON.stringify(started))
    try {
      response = await ask()
      step('fetch #2', 'ok after the host started it')
    } catch (again) {
      step('fetch #2', again.name + ': ' + again.message)
      return out
    }
  }

  const blob = await response.blob()
  step('blob', blob.type + ', ' + blob.size + ' bytes')

  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  const result = await new Promise((resolve) => {
    audio.addEventListener('playing', () => resolve('PLAYING'))
    audio.addEventListener('error', () => resolve('media error ' + (audio.error && audio.error.code)))
    audio.play().catch((error) => resolve('play() rejected: ' + error.name))
    setTimeout(() => resolve('no event within 8s'), 8000)
  })
  step('audio', result)
  step('duration', String(audio.duration))
  URL.revokeObjectURL(url)
  return out
})()`

console.log('service before the page tries:', await serviceUp())

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = targets.find((t) => t.type === 'page' && (t.url || '').includes('floating.html'))
if (!page) {
  console.log('no floating.html target among:', targets.map((t) => `${t.type} ${t.url}`))
  process.exit(1)
}
console.log('target:', page.url)

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve)
  socket.addEventListener('error', reject)
})

const answer = await new Promise((resolve) => {
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id === 1) resolve(message)
  })
  socket.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: PROBE, awaitPromise: true, returnByValue: true },
  }))
})
socket.close()

if (answer.result && answer.result.exceptionDetails) {
  console.log('the page threw:', JSON.stringify(answer.result.exceptionDetails, null, 2))
  process.exit(2)
}
const value = answer.result && answer.result.result && answer.result.result.value
if (!value) {
  console.log('unexpected answer:', JSON.stringify(answer, null, 2))
  process.exit(2)
}
for (const [name, detail] of value.steps) console.log(`  ${name.padEnd(9)} ${detail}`)
console.log('service after:', await serviceUp())

const audioStep = value.steps.find(([name]) => name === 'audio')
process.exit(audioStep && audioStep[1] === 'PLAYING' ? 0 : 2)
