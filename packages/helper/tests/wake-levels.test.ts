import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine, WAVE_BARS } from '../assets/wake.js'

/**
 * The live level history behind the ball's waveform.
 *
 * The engine is the only place the level can be measured from — it holds the microphone and
 * every frame passes through `processChunk` — so this is the half of the feature that is
 * testable without a page: the ring, its scroll direction, and when it is emptied. The
 * drawing half is asserted by shape in `menu.test.ts`, the same way the rest of the page is.
 */

const stubApi = {
  wakeConfig: async () => ({}),
  wakeReport: async () => ({}),
}

/**
 * An engine that never reaches the models: the level tap is all that is under test.
 * @returns a running engine whose VAD and classifier are inert.
 */
function engine() {
  const wake = new WakeEngine(stubApi as never)
  wake.running = true
  wake.runVad = async () => false
  wake.runModels = async () => {}
  // A loaded engine already owns its VAD recurrent state, so `reset()` only fills it. Without
  // this the stub would look like an engine that never loaded and would take the branch that
  // allocates through the runtime — a path `dictate()` can never reach, since it needs
  // `running`, which is only set after the models are in.
  wake.vadState.h = { data: new Float32Array(128).fill(0) }
  wake.vadState.c = { data: new Float32Array(128).fill(0) }
  return wake
}

/** One frame of a steady signal, whose RMS is the value itself. */
function frame(value: number) {
  return new Float32Array(1280).fill(value)
}

/**
 * The history is a `Float32Array`, so a level comes back with float32 rounding. Compare
 * with a tolerance rather than for bit equality: 0.004 reads back as 0.004000000189989805.
 * @param actual - the measured level.
 * @param expected - the level the frame was filled with.
 */
function assertLevel(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} is not ${expected}`)
}

describe('wake level history', () => {
  it('starts as a full window of silence', () => {
    const wake = engine()
    assert.equal(wake.waveform().length, WAVE_BARS)
    assert.ok(wake.waveform().every((level) => level === 0))
  })

  it('measures one RMS level per frame, newest at the right edge', async () => {
    const wake = engine()
    await wake.processChunk(frame(0.5))
    const bars = wake.waveform()
    // The newest sample lands at the right, which is the edge the official row scrolls in
    // from, and everything before it is still the silence the engine started from.
    assert.equal(bars.at(-1), 0.5)
    assert.equal(bars.at(-2), 0)
    assert.equal(bars[0], 0)
  })

  it('keeps exactly the newest window and scrolls older levels to the left', async () => {
    const wake = engine()
    // A ramp instead of a constant, so a bar that landed in the wrong slot is visible.
    for (let index = 1; index <= WAVE_BARS + 3; index += 1) await wake.processChunk(frame(index / 1000))
    const bars = wake.waveform()
    assert.equal(bars.length, WAVE_BARS)
    assertLevel(bars[0], 4 / 1000)
    assertLevel(bars[bars.length - 1], (WAVE_BARS + 3) / 1000)
    // Oldest to newest, monotonically: no slot was overwritten out of order.
    for (let index = 1; index < bars.length; index += 1) {
      assert.ok(bars[index] > bars[index - 1], `bar ${index}`)
    }
  })

  it('starts each utterance from silence, and records into the same history', async () => {
    const wake = engine()
    await wake.processChunk(frame(0.5))
    assert.equal(wake.waveform().at(-1), 0.5)
    // `dictate` resolves only when the recording ends; it is settled below instead.
    const utterance = wake.dictate({ silenceMs: 1000, maxSeconds: 5 })
    // The wake word and its chime are not part of the sentence the ball is drawing.
    assert.ok(wake.waveform().every((level) => level === 0))
    // Frames recorded into an utterance feed the waveform too: one tap, two consumers.
    await wake.processChunk(frame(0.25))
    assert.equal(wake.waveform().at(-1), 0.25)
    wake.finishDictation({ announce: false })
    assert.equal(await utterance, undefined)
  })
})

describe('wake scoring buffers', () => {
  it('forgets the wake word when a dictation ends, so the ball cannot re-arm itself', async () => {
    const wake = engine()
    // The chain exactly as a detection leaves it: the wake word still sits in the mel window
    // and the embedding ring, VAD last saw speech, and the cooldown has long since expired
    // (it is 2.5 s, an utterance nobody speaks into runs for 6 s). Scoring is skipped for the
    // whole utterance, so none of this advanced — and on resume the classifier would read the
    // wake word again and fire, opening a second dictation the user never asked for.
    wake.vadState.h = { data: new Float32Array(128).fill(1) }
    wake.vadState.c = { data: new Float32Array(128).fill(1) }
    wake.melBuffer = [new Float32Array(32).fill(1)]
    wake.embeddingHistory = [new Float32Array(96).fill(1)]
    wake.speechActive = true
    const utterance = wake.dictate({ silenceMs: 1000, maxSeconds: 5 })
    wake.finishDictation({ announce: false })
    assert.equal(await utterance, undefined)
    assert.deepEqual(wake.melBuffer, [])
    assert.equal(wake.embeddingHistory.length, 16, 'the ring is rebuilt at its full length')
    for (const embedding of wake.embeddingHistory) {
      assert.ok(embedding.every((value) => value === 0), 'no embedding of the wake word survives')
    }
    // The VAD's recurrent state is part of the same stream and carries the same history.
    for (const tensor of [wake.vadState.h, wake.vadState.c]) {
      assert.ok(tensor.data.every((value: number) => value === 0), 'the VAD state is back to zero')
    }
    // Two independent guards, because either one alone would still let the stale audio through:
    // an empty window has nothing to score, and silence is not speech.
    assert.equal(wake.speechActive, false)
  })
})
