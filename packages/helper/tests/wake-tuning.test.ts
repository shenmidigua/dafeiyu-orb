/**
 * The "finished speaking" pause as a setting rather than a constant.
 *
 * Three places decide what the recorder ends on, and each can be wrong on its own:
 *
 *   * the profile (`orb-wake.json` → `dictation.silenceMs`, milliseconds) — host tests pin that;
 *   * the page's engine (`assets/wake.js`), which turns the number into a frame count;
 *   * and the message that carries a change to a ball that is already listening.
 *
 * This file covers the last two. The conversion is the part worth pinning: the recorder counts 80 ms
 * frames, so a milliseconds value that is not a multiple of 80 rounds, and zero — the value a
 * missing or clamped-to-nothing setting would produce — would end the recording on its first frame
 * and look exactly like a microphone that never opened.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine } from '../assets/wake.js'

/** An engine that never touches the models or the microphone. */
function engine(): WakeEngine {
  const wake = new WakeEngine({ wakeConfig: async () => ({}), wakeReport: async () => ({}) } as never)
  wake.running = true
  // `reset()` would otherwise want a real ONNX Tensor for the VAD's recurrent state; a plain object
  // with a zeroed buffer is all the engine itself ever touches.
  wake.vadState.h = { data: new Float32Array(128).fill(0) } as never
  wake.vadState.c = { data: new Float32Array(128).fill(0) } as never
  return wake
}

/** One 16 kHz frame: `FRAME_SIZE / SAMPLE_RATE` is exactly 80 ms. */
function frame(): Float32Array {
  return new Float32Array(1280)
}

/** One 80 ms frame: `FRAME_SIZE / SAMPLE_RATE` is exactly this. */
const FRAME_MS = 80

describe('the pause as an engine setting', () => {
  it('ships 2.2 s and takes a new value from the settings page', () => {
    const wake = engine()
    assert.equal(wake.silenceMs(), 2200, 'the shipped default, in milliseconds')

    // Exactly the payload the helper forwards for the slider: `{ type: 'tuning', dictation }`.
    wake.configure({ dictation: { enabled: true, silenceMs: 3500, maxSeconds: 15, autoSend: false } } as never)
    assert.equal(wake.silenceMs(), 3500, 'the next utterance ends on the new pause')
  })

  it('leaves the fields the message did not mention alone', () => {
    const wake = engine()
    wake.configure({
      autoExpandOnWake: false,
      dictation: { enabled: true, silenceMs: 1000, maxSeconds: 30, autoSend: true },
    } as never)
    // A slider message is `{ dictation: { silenceMs } }` and nothing else. If a partial payload reset
    // the other fields, moving one number would quietly change three settings.
    wake.configure({ dictation: { silenceMs: 4000 } } as never)
    assert.equal(wake.silenceMs(), 4000)
    assert.equal(wake.config.dictation.maxSeconds, 30, 'the recording cap was reset by a partial update')
    assert.equal(wake.config.dictation.autoSend, true)
    assert.equal(wake.config.dictation.enabled, true)
    assert.equal(wake.autoExpand(), false, 'the panel setting was reset by a partial update')
  })

  it('never takes a pause that would break the recorder', () => {
    const wake = engine()
    for (const [value, expected] of [[0, 300], [-5, 300], [99_000, 10_000], [1234.6, 1235]] as const) {
      wake.configure({ dictation: { silenceMs: value } } as never)
      assert.equal(wake.silenceMs(), expected, `silenceMs ${value}`)
    }
    // Not a number at all keeps what was there: the panel must not be able to zero the window by
    // sending something the engine cannot read.
    for (const value of [undefined, null, '3500', Number.NaN]) {
      wake.configure({ dictation: { silenceMs: value } } as never)
      assert.equal(wake.silenceMs(), 1235, `silenceMs ${String(value)}`)
    }
  })
})

describe('the pause as a frame count', () => {
  it('converts milliseconds to the recorder frames it actually counts', async () => {
    const cases: [number, number][] = [
      [2200, Math.round(2200 / FRAME_MS)], // 27.5 -> 28 frames
      [1000, Math.round(1000 / FRAME_MS)], // 12.5 -> 13
      [3500, Math.round(3500 / FRAME_MS)], // 43.75 -> 44
      [10_000, Math.round(10_000 / FRAME_MS)], // 125
    ]
    for (const [silenceMs, frames] of cases) {
      const wake = engine()
      const utterance = wake.dictate({ silenceMs, maxSeconds: 30 })
      assert.equal(wake.dictation?.silenceFrames, frames, `${silenceMs} ms should be ${frames} frames`)
      wake.finishDictation({ announce: false })
      await utterance
    }
  })

  it('uses the configured pause when the caller does not name one', async () => {
    const wake = engine()
    wake.configure({ dictation: { silenceMs: 5000 } } as never)
    const utterance = wake.dictate({ maxSeconds: 30 })
    assert.equal(wake.dictation?.silenceFrames, Math.round(5000 / FRAME_MS), 'the setting, not a built-in constant')
    wake.finishDictation({ announce: false })
    await utterance
  })

  it('falls back rather than building a window out of a broken number', async () => {
    // `Math.round(NaN / 80)` is NaN, and `quiet >= NaN` is never true — the recording would then run
    // to `maxSeconds` every time, which is what "the ball stopped listening when I paused" looks like.
    for (const silenceMs of [Number.NaN, undefined, null, '3500'] as const) {
      const wake = engine()
      const utterance = wake.dictate({ silenceMs: silenceMs as unknown as number, maxSeconds: 0.5 })
      assert.equal(wake.dictation?.silenceFrames, Math.round(2200 / FRAME_MS), `silenceMs ${String(silenceMs)}`)
      wake.finishDictation({ announce: false })
      await utterance
    }
  })

  it('ends a spoken utterance on the pause and on nothing else', async () => {
    const wake = engine()
    let speech = true
    wake.runVad = async () => speech
    const utterance = wake.dictate({ silenceMs: 1000, maxSeconds: 5 })
    // 13 frames of speech first, so the recorder has something to have heard.
    for (let index = 0; index < 13; index += 1) await wake.collectDictation(frame())
    assert.notEqual(wake.dictation, undefined, 'speech does not end an utterance')
    speech = false
    for (let index = 0; index < 12; index += 1) await wake.collectDictation(frame())
    assert.notEqual(wake.dictation, undefined, '12 quiet frames is not yet the 13 that make 1 s')
    await wake.collectDictation(frame())
    assert.equal(wake.dictation, undefined, 'the 13th quiet frame ends the utterance')
    assert.ok(await utterance, 'the utterance came back as audio')
  })
})
