import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createTranscriber } from '../src/transcribe.ts'

/** One WAV body, small enough for every limit under test. */
const AUDIO = Buffer.alloc(64, 7)

interface FakeOptions {
  /** Preparation phases handed back by `snapshot()`, one per call; the last one repeats. */
  readonly phases?: readonly string[]
  /** What `transcribe` returns or throws. */
  readonly result?: unknown
  readonly resolveThrows?: boolean
  readonly prepareThrows?: boolean
}

/**
 * A stand-in for `ctx.speechToText` shaped like the real service: `snapshot()` reports
 * providers with a `preparation.phase`, `prepare(id, options)` starts work, `resolve({audio})`
 * picks a provider, and `transcribe(spec, signal)` answers with the worker's
 * `{ text, audioSeconds, inferenceSeconds }`.
 */
function fakeSpeech(options: FakeOptions = {}) {
  const phases = options.phases ?? ['ready']
  const calls = { snapshot: 0, prepare: 0, resolve: 0, transcribe: 0 }
  let index = 0
  const service = {
    snapshot() {
      const phase = phases[Math.min(index, phases.length - 1)]
      index += 1
      calls.snapshot += 1
      return { default: 'sensevoice-local', providers: [{ id: 'sensevoice-local', preparation: { phase } }] }
    },
    prepare() {
      calls.prepare += 1
      if (options.prepareThrows === true) throw new Error('prepare refused')
    },
    resolve(request: unknown) {
      calls.resolve += 1
      if (options.resolveThrows === true) throw new Error('no provider selected')
      return { request }
    },
    async transcribe() {
      calls.transcribe += 1
      if (options.result instanceof Error) throw options.result
      return options.result ?? { text: ' 打开记事本 ', audioSeconds: 1.2, inferenceSeconds: 0.1 }
    },
  }
  const ctx = { get: (name: string) => (name === 'speechToText' ? service : undefined) }
  return { ctx, calls }
}

describe('host transcriber', () => {
  it('reports a missing speech service instead of throwing', async () => {
    const transcriber = createTranscriber({ get: () => undefined })
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: false, reason: '宿主里没有语音转文字服务' })
  })

  it('rejects empty and oversized audio before calling the service', async () => {
    const speech = fakeSpeech()
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(Buffer.alloc(0)), { ok: false, reason: '没有录到声音' })
    assert.deepEqual(await transcriber.transcribe(Buffer.alloc(4 * 1024 * 1024 + 1)), { ok: false, reason: '录音太长' })
    assert.equal(speech.calls.transcribe, 0)
  })

  it('transcribes through a verified cache, keeping the worker result text', async () => {
    const speech = fakeSpeech()
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: true, text: '打开记事本' })
    assert.equal(speech.calls.prepare, 1)
    assert.equal(speech.calls.resolve, 1)
    assert.equal(speech.calls.transcribe, 1)
  })

  it('treats standby as ready: the first recording wakes the worker', async () => {
    const speech = fakeSpeech({ phases: ['standby'] })
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: true, text: '打开记事本' })
    // One snapshot to select the provider, one to read its phase: no polling loop.
    assert.ok(speech.calls.snapshot <= 2, `snapshot called ${speech.calls.snapshot} times`)
    assert.equal(speech.calls.transcribe, 1)
  })

  it('waits out an actively preparing provider', async () => {
    const speech = fakeSpeech({ phases: ['loading', 'loading', 'ready'] })
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: true, text: '打开记事本' })
    assert.ok(speech.calls.snapshot >= 3, `snapshot called ${speech.calls.snapshot} times`)
  })

  it('surfaces the provider failure when preparation failed', async () => {
    const speech = fakeSpeech({ phases: ['failed'], result: new Error('模型文件缺失') })
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: false, reason: '模型文件缺失' })
  })

  it('survives a service that refuses prepare or resolve', async () => {
    const noPrepare = fakeSpeech({ prepareThrows: true })
    assert.deepEqual(await createTranscriber(noPrepare.ctx).transcribe(AUDIO), { ok: true, text: '打开记事本' })
    const noResolve = fakeSpeech({ resolveThrows: true })
    assert.deepEqual(await createTranscriber(noResolve.ctx).transcribe(AUDIO), { ok: false, reason: 'no provider selected' })
  })

  it('reads a string, a transcript field, and reports an empty recognition', async () => {
    const plain = fakeSpeech({ result: ' 你好 ' })
    assert.deepEqual(await createTranscriber(plain.ctx).transcribe(AUDIO), { ok: true, text: '你好' })
    const transcript = fakeSpeech({ result: { transcript: '回去继续' } })
    assert.deepEqual(await createTranscriber(transcript.ctx).transcribe(AUDIO), { ok: true, text: '回去继续' })
    const empty = fakeSpeech({ result: { text: '   ' } })
    assert.deepEqual(await createTranscriber(empty.ctx).transcribe(AUDIO), { ok: false, reason: '没有识别出文字' })
  })

  it('re-prepares after a failure so the next utterance retries the cold start', async () => {
    const speech = fakeSpeech({ result: new Error('worker exited') })
    const transcriber = createTranscriber(speech.ctx)
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: false, reason: 'worker exited' })
    assert.deepEqual(await transcriber.transcribe(AUDIO), { ok: false, reason: 'worker exited' })
    assert.equal(speech.calls.prepare, 2)
  })
})
