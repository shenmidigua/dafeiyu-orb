/**
 * Run the real speech.js against a stubbed fetch/Audio and count what it actually does.
 *
 * The question this answers: given a two-sentence reply, does `Speaker.run` request and play both
 * sentences, or does it stop after the first one? The browser-side evidence (one `POST /speak` in
 * the service log) is ambiguous because a second request could have failed before reaching the
 * server, so the loop itself has to be observed directly.
 */
import { pathToFileURL } from 'node:url'

const SPEECH = pathToFileURL('C:/Users/digua/Desktop/dsh-orb-cordis/packages/helper/assets/speech.js').href
const { Speaker, sentencesForSpeech, plainForSpeech } = await import(SPEECH)

const REPLY = '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。你要是还想继续测别的内容，直接说一声就行。'

console.log('--- split ---')
const sentences = sentencesForSpeech(plainForSpeech(REPLY))
sentences.forEach((s, i) => console.log(`  [${i}] (${s.length}) ${s}`))

/* ── stubs ────────────────────────────────────────────────────────────────── */

let nextId = 0
globalThis.URL.createObjectURL = () => `blob:fake/${nextId++}`
globalThis.URL.revokeObjectURL = () => {}

class FakeAudio {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.paused = true
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeAttribute() {}
  pause() { this.paused = true }
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn() }
  play() {
    this.paused = false
    // Playback lasts `playMs`; the harness decides how long via FakeAudio.playMs.
    this.timer = setTimeout(() => this.emit('ended'), FakeAudio.playMs)
    return Promise.resolve()
  }
}
FakeAudio.playMs = 40

let audioInstances = []
globalThis.Audio = class extends FakeAudio {
  constructor(url) { super(url); audioInstances.push(this) }
}

let calls = []
let failIndex = -1
let fetchDelay = () => 1

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  const index = calls.length
  calls.push({ url, text: body.text, at: Date.now() - t0 })
  const delay = fetchDelay(index)
  if (delay > 0) await new Promise((r) => setTimeout(r, delay))
  if (index === failIndex) {
    return { ok: false, status: 502, blob: async () => new Blob(['x']) }
  }
  return { ok: true, status: 200, blob: async () => new Blob([new Uint8Array(1024)]) }
}

/* ── scenario runner ──────────────────────────────────────────────────────── */

const t0 = Date.now()

async function scenario(name, { delay = () => 1, fail = -1, playMs = 40 } = {}) {
  calls = []
  audioInstances = []
  failIndex = fail
  fetchDelay = delay
  FakeAudio.playMs = playMs

  const states = []
  const speaker = new Speaker({
    endpoint: 'http://127.0.0.1:8765',
    onState: (s) => states.push({ ...s, at: Date.now() - t0 }),
    ensure: async () => ({ ok: true }),
  })
  speaker.configure({ enabled: true })
  speaker.speak(REPLY, 'k1')

  // Long enough for the whole queue in every scenario below.
  await new Promise((r) => setTimeout(r, 1500))

  console.log(`\n--- ${name} ---`)
  console.log(`  requests  ${calls.length}`)
  calls.forEach((c, i) => console.log(`    [${i}] +${c.at}ms (${c.text.length}) ${c.text.slice(0, 24)}…`))
  console.log(`  played    ${audioInstances.length}`)
  console.log(`  final     speaking=${speaker.speaking} key=${speaker.currentKey} err=${speaker.lastError} ${speaker.lastDetail}`)
  const last = states[states.length - 1]
  console.log(`  lastState ${JSON.stringify(last)}`)
  return { calls: calls.length, played: audioInstances.length, speaker }
}

await scenario('A  both sentences, instant service')
await scenario('B  second sentence slow (3s), first plays in 200ms', {
  delay: (i) => (i === 0 ? 200 : 3000),
  playMs: 200,
})
await scenario('C  second sentence fails with 502', { fail: 1 })
await scenario('D  both slow, first slightly faster', {
  delay: (i) => (i === 0 ? 2000 : 4500),
  playMs: 200,
})
