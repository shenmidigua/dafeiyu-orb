import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine } from '../assets/wake.js'

/**
 * How many windows in a row have to cross the threshold before the ball wakes.
 *
 * This is the whole of the sensitivity complaint. The first rule was "one window above the threshold
 * fires", and a window lands every 128 ms of speech, so an hour of talking offered ~28k independent
 * chances to cross: 5.9 wake-ups per hour of held-out speech, measured by `dsh_orb/wake_eval.py`. The
 * threshold itself was already spent - everything the helper can be configured with, up to the 0.99 it
 * clamps to, gave the same 5.9, because no negative clip ever scored in that band.
 *
 * What the negatives cannot fake is duration. Three windows in a row is ~0.26 s longer than one, which
 * a real phrase holds and an isolated spike does not, and `dsh_orb/wake_rule_probe.py` measures the
 * result on the same held-out clips: 5.9 -> 0 wake-ups per hour, recall unchanged at 100%. These tests
 * pin the ways that measurement can silently stop being true - a run shorter than the constant says,
 * a run surviving a gap or a reset, and a detection leaving a banked run behind that fires the next
 * alarm for free.
 */

const stubApi = {
  wakeConfig: async () => ({}),
  wakeReport: async () => ({}),
}

/** Enough of a Tensor for `runModels` to construct one. */
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
 * The score as the classifier would hand it over.
 *
 * `kw.run` returns a `Float32Array`, so a 0.99 in a scripted score comes back as 0.9900000095367432.
 * Rounding the expectation through the same type keeps the assertions about *which* window fired
 * instead of turning every one of them into a tolerance check.
 */
const f32 = (value: number) => Math.fround(value)

type Fixture = ReturnType<typeof engine>

/** Every fixture built by a test, so the 2.5 s cooldown timer does not outlive the assertion. */
const fixtures: Fixture[] = []

afterEach(() => {
  for (const { wake } of fixtures) {
    if (wake.cooldownTimer !== undefined) clearTimeout(wake.cooldownTimer)
    if (wake.detectedTimer !== undefined) clearTimeout(wake.detectedTimer)
  }
  fixtures.length = 0
})

/**
 * An engine whose classifier returns a scripted score per window.
 *
 * The scores are queued rather than derived from audio on purpose: what is under test is the decision
 * rule, and a fixture that produced its own scores would only be testing the fixture. `windows` counts
 * classifier calls so `feed()` can drive exactly as many windows as it was handed scores for, and
 * `fires` records the score each detection carried, so a test can tell "fired once" from "fired".
 */
function engine() {
  const wake = new WakeEngine(stubApi as never)
  wake.config.keyword = 'dafeiyu'
  wake.config.threshold = 0.95
  wake.ort = { Tensor: FakeTensor } as never
  const state = { scores: [] as number[], windows: 0, fires: [] as number[] }
  wake.models = {
    mel: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => ({ output: { data: new Float32Array(5 * 32).fill(1) } }),
    },
    emb: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => ({ output: { data: new Float32Array(96).fill(QUIET) } }),
    },
    kw: {
      inputNames: ['input'],
      outputNames: ['output'],
      run: async () => {
        const score = state.scores.shift() ?? 0
        state.windows += 1
        return { output: { data: new Float32Array(1).fill(score) } }
      },
    },
  } as never
  // The ring is normally filled by `load()`; a quiet room is the same ring without ONNX.
  wake.quietEmbedding = new Float32Array(96).fill(QUIET)
  wake.reset()
  wake.running = true
  // Stubbed, so a test measures detections instead of the tone and the pending 4 s hold.
  wake.detected = (async (score: number) => { state.fires.push(score) }) as never
  const fixture = { wake, state }
  fixtures.push(fixture)
  return fixture
}

function frame(value: number) {
  return new Float32Array(1280).fill(value)
}

/** Run frames until exactly `scores.length` more classifier windows have been scored. */
async function feed({ wake, state }: Fixture, speechActive: boolean, ...scores: number[]) {
  const target = state.windows + scores.length
  state.scores.push(...scores)
  let guard = 0
  // A window is emitted at most once per frame - a drain removes eight mel frames and a frame adds
  // five, so the buffer cannot come back over 76 twice in one frame - which is what makes driving to
  // an exact count possible. The guard covers the failure mode where scoring stops altogether, such as
  // a ring that has started filling again, which would otherwise hang the suite instead of failing it.
  while (state.windows < target) {
    await wake.runModels(frame(0.1) as never, speechActive)
    guard += 1
    if (guard > 4000) throw new Error('no window was scored: the engine stopped consuming frames')
  }
  assert.equal(state.windows, target, 'more windows were scored than the fixture was given')
}

/** Let the cooldown expire without waiting 2.5 s for the timer that does it in production. */
function endCooldown({ wake }: Fixture) {
  if (wake.cooldownTimer !== undefined) clearTimeout(wake.cooldownTimer)
  wake.cooldownTimer = undefined
  wake.coolingDown = false
}

describe('windows in a row before the ball wakes', () => {
  it('does not wake on two windows, however far above the threshold', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99)
    assert.deepEqual(fixture.state.fires, [],
                     'two windows fired, so the rule is still the single-window one')
  })

  it('wakes on the third window in a row', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99, 0.99)
    assert.deepEqual(fixture.state.fires, [f32(0.99)], 'the third consecutive window did not fire')
  })

  it('counts a run, not a total: a window below the threshold starts the count over', async () => {
    const gap = engine()
    // Two, a gap, two more. Four windows above the threshold, never three in a row.
    await feed(gap, true, 0.99, 0.99, 0.0, 0.99, 0.99)
    assert.deepEqual(gap.state.fires, [], 'a run survived a window below the threshold')

    // The same shape with the run completed, so the assertion above cannot be satisfied by a fixture
    // in which nothing ever fires.
    const completed = engine()
    await feed(completed, true, 0.99, 0.99, 0.0, 0.99, 0.99, 0.99)
    assert.deepEqual(completed.state.fires, [f32(0.99)], 'the run after the gap never completed')
  })

  it('still applies the VAD gate to every window of the run', async () => {
    const fixture = engine()
    await feed(fixture, false, 0.99, 0.99, 0.99)
    assert.deepEqual(fixture.state.fires, [], 'three loud windows without speech fired')
  })

  it('starts over after a reset, so a mute cannot bank two windows', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99)
    fixture.wake.reset()
    await feed(fixture, true, 0.99, 0.99)
    assert.deepEqual(fixture.state.fires, [],
                     'a run from before the reset counted towards the one after it')
  })

  it('clears the run when it fires, so the next wake needs three fresh windows', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99, 0.99)
    assert.equal(fixture.state.fires.length, 1)

    endCooldown(fixture)

    await feed(fixture, true, 0.99)
    assert.equal(fixture.state.fires.length, 1, 'a banked run fired on its first window')
    await feed(fixture, true, 0.99)
    assert.equal(fixture.state.fires.length, 1, 'two windows after the cooldown fired')
    await feed(fixture, true, 0.99)
    assert.equal(fixture.state.fires.length, 2, 'three fresh windows after the cooldown did not fire')
  })

  it('does not count windows heard during the cooldown towards the next run', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99, 0.99)
    assert.equal(fixture.state.fires.length, 1)

    // Still cooling down and the phrase is still being said: five loud windows that must neither fire
    // nor accumulate towards the next alarm.
    await feed(fixture, true, 0.99, 0.99, 0.99, 0.99, 0.99)
    assert.equal(fixture.state.fires.length, 1, 'the cooldown suppressed nothing')

    endCooldown(fixture)
    await feed(fixture, true, 0.99, 0.99)
    assert.equal(fixture.state.fires.length, 1, 'windows from inside the cooldown were banked')
  })
})
