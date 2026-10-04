/**
 * Speak a real reply through the real `speech.js` against the real service, and time every step.
 *
 * `probe_sentences.mjs` already showed the sentence queue is correct against an instant stub. The
 * open question is what happens at the speeds the actual service runs at: each sentence is a
 * several-second synthesis followed by a download over a ~20 KB/s link, and the second sentence is
 * requested while the first one is still playing. That overlap is exactly where "it read the first
 * half and stopped" would come from, and no stub reproduces it.
 *
 * Only `Audio` is faked — playback is compressed by `PLAY_SCALE` so the run does not take a minute.
 * `fetch` is the real one, so the requests, their bodies, the status codes and the timings are all
 * genuine.
 *
 * Usage: `probe_real_speech.mjs [text]`
 */

import { pathToFileURL } from 'node:url'

const SPEECH = pathToFileURL('C:/Users/digua/Desktop/dsh-orb-cordis/packages/helper/assets/speech.js').href
const { Speaker, sentencesForSpeech, plainForSpeech } = await import(SPEECH)

const REPLY = process.argv[2]
  || '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。你要是还想继续测别的内容，直接说一声就行。'

/** MP3 at roughly 128 kbps, so this is close enough to the real playback length. */
const BYTES_PER_SECOND = 16000
/** Compress playback so a ~20 s reply does not take 20 s to test. */
const PLAY_SCALE = 8
const ENDPOINT = 'http://127.0.0.1:8765'

const t0 = Date.now()
const at = () => `+${String(Date.now() - t0).padStart(5)}ms`

const sentences = sentencesForSpeech(plainForSpeech(REPLY))
console.log(`reply ${REPLY.length} chars -> ${sentences.length} sentence(s)`)
sentences.forEach((s, i) => console.log(`  [${i}] (${s.length}) ${s}`))

/* ── Audio stand-in whose play() resolves after the clip would have finished ── */

const recordings = []
globalThis.URL.createObjectURL = (blob) => {
  const tag = `blob:probe/${recordings.length}`
  recordings.push({ tag, size: blob.size })
  return tag
}
globalThis.URL.revokeObjectURL = () => {}

class FakeAudio {
  constructor(url) {
    this.url = url
    this.listeners = new Map()
    this.record = recordings.find((r) => r.tag === url) ?? { size: 0 }
    this.seconds = this.record.size / BYTES_PER_SECOND
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, [])
    this.listeners.get(type).push(fn)
  }
  removeAttribute() {}
  pause() {}
  emit(type) { for (const fn of this.listeners.get(type) ?? []) fn() }
  play() {
    const ms = Math.max(60, (this.seconds * 1000) / PLAY_SCALE)
    console.log(`      ${at()}  play  ${this.record.size}B (~${this.seconds.toFixed(1)}s, waiting ${ms.toFixed(0)}ms)`)
    this.timer = setTimeout(() => {
      console.log(`      ${at()}  ended`)
      this.emit('ended')
    }, ms)
    return Promise.resolve()
  }
}
globalThis.Audio = FakeAudio

/* ── real fetch, wrapped only to observe ── */

const realFetch = globalThis.fetch
let index = 0
globalThis.fetch = async (url, init) => {
  const mine = index++
  const body = JSON.parse(init.body)
  const started = Date.now()
  console.log(`      ${at()}  request[${mine}] -> (${body.text.length}) ${body.text.slice(0, 20)}…`)
  try {
    const response = await realFetch(url, init)
    const blob = await response.blob()
    console.log(`      ${at()}  reply[${mine}]   ${response.status}, ${blob.size} bytes,` +
      ` ${((Date.now() - started) / 1000).toFixed(1)}s`)
    return { ok: response.ok, status: response.status, blob: async () => blob }
  } catch (error) {
    console.log(`      ${at()}  reply[${mine}]   THREW ${error.name}: ${error.message}`)
    throw error
  }
}

/* ── run it ── */

const states = []
const speaker = new Speaker({
  endpoint: ENDPOINT,
  onState: (s) => {
    states.push(s)
    if (s.error !== '' || s.speaking === false) console.log(`      ${at()}  state ${JSON.stringify(s)}`)
  },
  ensure: async () => ({ ok: true, reason: 'probe-asked' }),
})
speaker.configure({ enabled: true })
speaker.speak(REPLY, 'probe-key')

const deadline = Date.now() + 180000
while (speaker.speaking && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
}

console.log(`\nrequests sent:   ${index}`)
console.log(`clips played:    ${recordings.length}`)
console.log(`still speaking:  ${speaker.speaking}`)
console.log(`last error:      ${speaker.lastError || '(none)'} ${speaker.lastDetail}`)
process.exit(speaker.lastError === '' && recordings.length === sentences.length ? 0 : 2)
