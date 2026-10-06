import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine } from '../assets/wake.js'

/**
 * What the ring holds before the first real audio reaches it.
 *
 * This is a bug that was measured, not a tidiness preference. Training and every probe warm the
 * embedding ring from audio before a single window is emitted, so no clip the classifier was fitted
 * to ever contained zeros. `reset()` filled the ring with zeros anyway, and the doubled 大肥鱼 model
 * answers that - and the 27-zeros-plus-one-embedding variant - with 0.98 **on any audio at all**:
 * identical to four decimals on the "say it twice" and "say it once" acceptance files, and 0.86 on
 * an all-zero ring. So the ball woke about 4.7 s after every start, mute and dictation end, having
 * heard nothing. The shipped 16-slot model answered 0.0001 there, which is the only reason the hole
 * stayed invisible until the ring was widened.
 *
 * The fix is in two halves and both are asserted here, because either one alone leaves a hole:
 * `reset()` fills the ring with a quiet-room embedding, and `runModels` refuses to score a ring that
 * is not yet full (the pre-`load()` case, where there is nothing to compute a quiet room from).
 */

const stubApi = {
  wakeConfig: async () => ({}),
  wakeReport: async () => ({}),
}

/** Enough of a Tensor for `runModels` and `silenceEmbedding` to construct one. */
class FakeTensor {
  type: string
  data: Float32Array
  dims: number[]
  constructor(type: string, data: Float32Array, dims: number[]) {
    this.type = type
    this.data = data
    this.dims = dims
  }
}

const QUIET = 0.25

/**
 * An engine with a fake runtime, so the ring can be driven without ONNX.
 *
 * `melInputs` keeps every frame the melspectrogram was handed, which is how the test tells noise at
 * the silence floor from digital silence. `kw` counts classifier calls, which is the observation the
 * guard is about.
 */
function engine(keyword = 'dafeiyu') {
  const wake = new WakeEngine(stubApi as never)
  wake.config.keyword = keyword
  wake.ort = { Tensor: FakeTensor } as never
  const seen = { mel: 0, emb: 0, kw: 0, melInputs: [] as Float32Array[] }
  wake.models = {
    mel: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async (feeds: Record<string, FakeTensor>) => {
        seen.mel += 1
        seen.melInputs.push(feeds.input.data)
        return { output: { data: new Float32Array(5 * 32).fill(1) } }
      },
    },
    emb: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => {
        seen.emb += 1
        return { output: { data: new Float32Array(96).fill(QUIET) } }
      },
    },
    kw: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => {
        seen.kw += 1
        return { output: { data: new Float32Array(1).fill(0) } }
      },
    },
  } as never
  return { wake, seen }
}

function frame(value: number) {
  return new Float32Array(1280).fill(value)
}

describe('the ring before the first real audio', () => {
  it('warms from noise at the silence floor, not from digital zero', async () => {
    const { wake, seen } = engine()
    const embedding = await wake.silenceEmbedding()

    // `ceil(76 / 5) + 4` frames, so the 76 mel frames the embedding consumes are all produced.
    assert.equal(seen.mel, 20, 'not enough quiet audio was run to fill a mel window')
    assert.equal(seen.emb, 1, 'the quiet embedding took more than one inference')
    assert.equal(embedding.length, 96)

    let peak = 0
    let nonzero = 0
    for (const input of seen.melInputs) {
      for (const value of input) {
        peak = Math.max(peak, Math.abs(value))
        if (value !== 0) nonzero += 1
      }
    }
    // Digital zero is a different regime rather than a quieter one, because the melspectrogram model
    // takes a logarithm - so a frame of zeros here would be the wrong fixture even though it looks
    // like the quieter choice.
    assert.ok(nonzero > 0, 'the warm-up audio was digital silence')
    assert.ok(peak > 0.001 && peak <= 0.004, `warm-up amplitude ${peak} is not the silence floor`)
  })

  it('fills the ring with the quiet room and calls it ready to score', async () => {
    const { wake } = engine()
    wake.quietEmbedding = await wake.silenceEmbedding()

    wake.reset()

    assert.equal(wake.embeddingHistory.length, 28, 'a 大肥鱼 ring is 28 slots')
    assert.equal(wake.ringFill, 28, 'a quiet room is a valid ring, so nothing is withheld')
    for (const row of wake.embeddingHistory) {
      assert.equal(row.length, 96)
      // The assertion that would have caught the original bug: no all-zero row reaches the classifier.
      assert.ok(row.every((value) => value === QUIET), 'a zeroed slot survived the reset')
    }
  })

  it('leaves the ring unscorable rather than zeroed when no quiet room can be computed yet', async () => {
    const { wake } = engine()
    // No models loaded, so `quietEmbedding` is undefined.
    wake.reset()

    assert.equal(wake.ringFill, 0, 'a zero-filled ring was declared ready to score')
    assert.ok(wake.embeddingHistory.every((row) => row.every((value) => value === 0)))
  })

  it('computes the quiet room before the reset, so `load()` cannot leave a zeroed ring', async () => {
    const { wake } = engine()
    const order: string[] = []
    // `load()` returns early once the models are in, and `engine()` puts fakes there to drive the
    // ring without ONNX - so this one test has to start from an engine that has not loaded.
    wake.models = undefined
    wake.ensureRuntime = (async () => wake.ort) as never
    wake.ort = {
      Tensor: FakeTensor,
      InferenceSession: {
        create: async () => ({
          inputNames: ['input'],
          outputNames: ['output'],
          run: async () => ({ output: { data: new Float32Array(96).fill(QUIET) } }),
        }),
      },
    } as never
    wake.silenceEmbedding = (async () => {
      order.push('quiet')
      return new Float32Array(96).fill(QUIET)
    }) as never
    const reset = wake.reset.bind(wake)
    wake.reset = (() => {
      order.push('reset')
      reset()
    }) as never

    await wake.load()

    assert.deepEqual(order, ['quiet', 'reset'], 'the ring was reset before a quiet room existed')
    assert.equal(wake.ringFill, 28, '`load()` left a ring that will never be scored')
    assert.ok(wake.embeddingHistory.every((row) => row.every((value) => value === QUIET)))
  })

  it('does not reach the classifier until every slot holds audio', async () => {
    const { wake, seen } = engine()
    // No quiet room, so the ring starts zeroed and has to fill from the stream. A mel frame yields
    // five mel buffers and an embedding eats eight, so 28 embeddings need 59 frames: 58 is one short.
    wake.reset()
    wake.running = true

    for (let i = 0; i < 58; i += 1) await wake.runModels(frame(0.1) as never, false)
    assert.equal(seen.kw, 0, 'the classifier was asked about a ring that was still filling')
    assert.equal(wake.ringFill, 27, 'the ramp is not the one this test was written against')

    await wake.runModels(frame(0.1) as never, false)
    assert.equal(wake.ringFill, 28)
    assert.equal(seen.kw, 1, 'the classifier never scored a full ring')
  })

  it('keeps the ring per keyword, so the shipped classifier still gets its 16', () => {
    const { wake } = engine('hey_jarvis')
    wake.reset()
    assert.equal(wake.embeddingHistory.length, 16, 'the shipped keyword was widened along with the custom one')
  })
})
