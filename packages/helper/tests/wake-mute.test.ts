import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine } from '../assets/wake.js'

/**
 * Scoring while the ball talks.
 *
 * `/speak` returns audio that plays out of the speakers the microphone sits beside, and the
 * positives were synthesised in exactly the voices Edge TTS produces, so a copy of the ball's
 * own speech arriving at the classifier is close to a positive sample. `mute()` is what stops
 * that from waking the ball mid-reply.
 *
 * The engine is exercised as a real instance rather than through an extracted function: the
 * whole point of the change is a branch order inside `processChunk`, and a copy of that
 * function would be free to get the order right by accident.
 */

const stubApi = {
  wakeConfig: async () => ({}),
  wakeReport: async () => ({}),
}

/** One frame of a steady signal. */
function frame(value: number) {
  return new Float32Array(1280).fill(value)
}

/**
 * An engine that reaches `processChunk` without loading any model.
 *
 * `runVad` and `runModels` are the two calls the frame would otherwise make into ONNX, and
 * counting their invocations is the whole observation: a muted engine must not reach either.
 */
function engine() {
  const wake = new WakeEngine(stubApi as never)
  wake.running = true
  const seen = { vad: 0, models: 0 }
  wake.runVad = async () => {
    seen.vad += 1
    return false
  }
  wake.runModels = async () => {
    seen.models += 1
  }
  wake.vadState.h = { data: new Float32Array(128).fill(0) }
  wake.vadState.c = { data: new Float32Array(128).fill(0) }
  return { wake, seen }
}

describe('the wake word while the ball is speaking', () => {
  it('scores normally with nothing muted', async () => {
    const { wake, seen } = engine()
    await wake.processChunk(frame(0.1) as never)
    assert.equal(seen.models, 1, 'an unmuted engine must reach the classifier')
  })

  it('does not reach the VAD or the classifier while muted', async () => {
    const { wake, seen } = engine()
    wake.mute()
    await wake.processChunk(frame(0.1) as never)
    await wake.processChunk(frame(0.1) as never)
    assert.equal(seen.vad, 0, 'muted audio still ran the VAD')
    assert.equal(seen.models, 0, 'a muted frame reached the classifier')
  })

  it('scores again after unmute, so the feature is not switched off by a reply', async () => {
    const { wake, seen } = engine()
    wake.mute()
    await wake.processChunk(frame(0.1) as never)
    wake.unmute()
    await wake.processChunk(frame(0.1) as never)
    assert.equal(seen.models, 1)
  })

  it('drops the mel buffer on mute, so pre-mute audio cannot fire a late detection', async () => {
    // The classifier scores a whole ring, sized per keyword - 28 slots for 大肥鱼, 16 for the shipped
    // `hey_jarvis` - and `reset()` is what clears it. Without the reset the frames recorded before
    // the mute are still in the ring when playback ends, which is the tail of a reply the model is
    // then asked about as if it were live speech.
    //
    // The buffers are seeded directly rather than accumulated through `runModels`, because that
    // method needs a loaded ONNX runtime and this is the one test that only cares about what
    // `mute()` clears. Note the asymmetry the real `reset()` has: the mel queue is emptied while
    // the embedding ring is refilled in full, so the ring is never short - it holds a quiet room.
    // This engine has no models loaded, so there is nothing to compute that from and the refill
    // falls back to zeros; `wake-ring.test.ts` is where the quiet room itself is asserted.
    const { wake } = engine()
    wake.melBuffer.push(new Float32Array(32).fill(1))
    for (let i = 0; i < wake.embeddingHistory.length; i += 1) {
      wake.embeddingHistory[i] = new Float32Array(96).fill(1)
    }

    wake.mute()
    assert.equal(wake.melBuffer.length, 0, 'the mel queue survived the mute')
    assert.ok(wake.embeddingHistory.every((embedding) => embedding.every((value) => value === 0)),
      'the embedding ring still holds pre-mute audio')
  })

  it('clears the buffers on unmute too, so the speakers cannot bleed past the mute', async () => {
    // `mute()` clears what came before it. This clears what arrives during it: on a device where
    // echo cancellation was refused, those frames are the reply itself. They are seeded rather
    // than pushed through `processChunk`, which early-returns precisely so they never get there —
    // what this asserts is the reset on the way out, not the early return.
    const { wake } = engine()
    wake.mute()
    wake.melBuffer.push(new Float32Array(32).fill(1))

    wake.unmute()
    assert.equal(wake.melBuffer.length, 0, 'bleed that arrived while muted stayed queued')
  })

  it('keeps recording an utterance that started before playback began', async () => {
    // Order matters here. The dictation branch is checked first on purpose: a recording in flight
    // is collecting the silence that ends it, and dropping those frames would resolve every
    // utterance as "no speech was heard" the moment a reply started.
    const { wake, seen } = engine()
    let heard: unknown
    const recording = wake.dictate({ silenceMs: 10, maxSeconds: 5 }).then((value) => { heard = value })
    // One frame to put the engine into its recording state.
    await wake.processChunk(frame(0.1) as never)
    const before = wake.dictation?.frames.length as number

    wake.mute()
    await wake.processChunk(frame(0.001) as never)
    assert.equal(wake.dictation?.frames.length, before + 1,
      'muting dropped a frame from an utterance in flight')
    assert.equal(seen.models, 0, 'an in-flight utterance re-entered the classifier')

    wake.unmute()
    // `runVad` is stubbed false, so `heard` stays false and the utterance would only stop at
    // `maxFrames` five seconds later. End it the way a silent room would.
    wake.finishDictation({ announce: false })
    await recording
    assert.equal(heard, undefined, 'an utterance nobody spoke into resolved as content')
  })
})