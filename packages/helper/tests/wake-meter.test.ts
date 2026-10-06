import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine, CONSECUTIVE_WINDOWS } from '../assets/wake.js'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/**
 * The meter's hold on a fired reading, read out of the page rather than restated here.
 *
 * A test that carried its own copy of the number would go on testing the number it copied: the
 * page could shorten the hold to nothing and every assertion below would still pass, because the
 * assertion would be moving with it. Anchored on the declaration so the read fails loudly if the
 * constant is renamed or dropped.
 */
const WAKE_HOLD_MS = Number(/^const WAKE_HOLD_MS = (\d+)$/m.exec(shell)?.[1])
assert.ok(Number.isFinite(WAKE_HOLD_MS) && WAKE_HOLD_MS > 0,
          'WAKE_HOLD_MS is not declared in shell.js, so nothing below is measuring the real hold')

/**
 * The live wake meter: the score of the window the classifier just looked at.
 *
 * It is a diagnostic surface — the ball itself deliberately shows no wake state, so a score that is
 * climbing towards the threshold and a score that is nowhere near it look identical from outside.
 * Two halves, and both can lie in ways nothing else would notice:
 *
 *   * the engine half has to report *every* window. A meter fed only from `detected` would show
 *     nothing at all until the moment it was no longer needed, and one fed from `publish` would put
 *     the helper's menu on the hot path of the wake feature eight times a second.
 *   * the page half turns a fraction into a length. Off-by-a-clamp or a fraction read as a
 *     percentage paints a bar that is confidently wrong, which is worse than no bar at all.
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

/** A score as the classifier hands it over: through a `Float32Array`, so it comes back rounded. */
const f32 = (value: number) => Math.fround(value)

type Report = { score: number; above: boolean; streak: number; threshold: number }

type Fixture = ReturnType<typeof engine>

const fixtures: Fixture[] = []

afterEach(() => {
  for (const { wake } of fixtures) {
    if (wake.cooldownTimer !== undefined) clearTimeout(wake.cooldownTimer)
    if (wake.detectedTimer !== undefined) clearTimeout(wake.detectedTimer)
  }
  fixtures.length = 0
})

/**
 * An engine whose classifier returns scripted scores and whose meter reports are collected.
 *
 * `reportCalls` counts what reached the helper over IPC, so a test can say "the score never went
 * there" rather than merely "the score went to the page too".
 */
function engine() {
  const state = {
    scores: [] as number[],
    windows: 0,
    fires: [] as number[],
    reports: [] as Report[],
    reportCalls: 0,
    failOnReport: false,
  }
  const api = {
    wakeConfig: async () => ({}),
    wakeReport: async () => { state.reportCalls += 1; return {} },
  }
  const wake = new WakeEngine(api as never, {
    onScore: (update: Report) => {
      // A page that throws must not be able to stop the microphone: the same contract `onStatus` has.
      if (state.failOnReport) throw new Error('the page blew up drawing the meter')
      state.reports.push(update)
    },
  })
  wake.config.keyword = 'dafeiyu'
  wake.config.threshold = 0.95
  wake.ort = { Tensor: FakeTensor } as never
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
  wake.quietEmbedding = new Float32Array(96).fill(QUIET)
  wake.reset()
  // The reset above happened before `running` was set, and it reported: a meter that is up while the
  // engine is not listening must not open on the last stream's reading.
  state.reports.length = 0
  wake.running = true
  wake.detected = (async (score: number) => { state.fires.push(score) }) as never
  const fixture = { wake, state }
  fixtures.push(fixture)
  return fixture
}

function frame(value: number) {
  return new Float32Array(1280).fill(value)
}

/** Run frames until exactly `scores.length` more windows have been scored. */
async function feed({ wake, state }: Fixture, speechActive: boolean, ...scores: number[]) {
  const target = state.windows + scores.length
  state.scores.push(...scores)
  let guard = 0
  while (state.windows < target) {
    await wake.runModels(frame(0.1) as never, speechActive)
    guard += 1
    if (guard > 4000) throw new Error('no window was scored: the engine stopped consuming frames')
  }
  assert.equal(state.windows, target, 'more windows were scored than the fixture was given')
}

function endCooldown({ wake }: Fixture) {
  if (wake.cooldownTimer !== undefined) clearTimeout(wake.cooldownTimer)
  wake.cooldownTimer = undefined
  wake.coolingDown = false
}

describe('the score the engine reports', () => {
  it('reports every window, not just the ones that fire', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.1, 0.2, 0.3)
    assert.deepEqual(fixture.state.reports.map((report) => report.score),
                     [f32(0.1), f32(0.2), f32(0.3)],
                     'the meter is fed only from windows that did something')
    assert.deepEqual(fixture.state.fires, [], 'nothing here should have woken the ball')
  })

  it('never sends a score to the helper', async () => {
    const fixture = engine()
    const before = fixture.state.reportCalls
    await feed(fixture, true, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1)
    assert.equal(fixture.state.reportCalls, before,
                 'the score is crossing IPC, which puts the helper on the wake path eight times a second')
  })

  it('reports the threshold it is scoring against, not a copy of it', async () => {
    const fixture = engine()
    fixture.wake.configure({ threshold: 0.4 } as never)
    await feed(fixture, true, 0.5)
    assert.equal(fixture.state.reports[0]?.threshold, 0.4,
                 'the meter is drawing its line at a threshold the engine is not using')
  })

  it('tells "past the line" from "counted": a window over the threshold can add nothing to the run', async () => {
    const fixture = engine()
    // Over the line three times over, but the VAD hears no speech, so the rule counts none of them.
    await feed(fixture, false, 0.99, 0.99, 0.99)
    assert.deepEqual(fixture.state.reports.map((report) => report.above), [true, true, true],
                     'a window over the threshold was not reported as over it')
    assert.deepEqual(fixture.state.reports.map((report) => report.streak), [0, 0, 0],
                     'a gated window was counted towards a wake')
  })

  it('counts a run up to the number of windows the rule needs, then starts over', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99, 0.99)
    // The window that fires is reported with the run it completed, not with the zero it is reset to:
    // the meter has to be able to show all the dots lit and *then* the ball wake, or the last thing
    // the user sees before a detection is a bar that appears to have given up one window early.
    assert.deepEqual(fixture.state.reports.map((report) => report.streak),
                     [1, 2, CONSECUTIVE_WINDOWS],
                     `a run should climb to ${CONSECUTIVE_WINDOWS} on the window that fires`)
    assert.equal(fixture.state.fires.length, 1)

    // Below the line, so the run restarts from nothing.
    endCooldown(fixture)
    await feed(fixture, true, 0.0)
    assert.equal(fixture.state.reports.at(-1)?.streak, 0, 'a window under the threshold kept the run')
    assert.equal(fixture.state.reports.at(-1)?.above, false)
  })

  it('clears the meter on a reset, so a mute cannot leave a live-looking reading behind', async () => {
    const fixture = engine()
    await feed(fixture, true, 0.99, 0.99)
    fixture.wake.reset()
    const last = fixture.state.reports.at(-1)
    assert.deepEqual(last, { score: 0, above: false, streak: 0, threshold: 0.95 },
                     'the ring was emptied and the meter still shows the score of the audio that went with it')
  })

  it('keeps scoring when the page throws while drawing', async () => {
    const fixture = engine()
    fixture.state.failOnReport = true
    await feed(fixture, true, 0.99, 0.99, 0.99)
    assert.deepEqual(fixture.state.fires, [f32(0.99)],
                     'a broken meter stopped the ball from waking')
  })
})

/**
 * A stand-in for the elements `paintWakeMeter` writes to.
 *
 * Every field is recorded rather than merely accepted, because what the test is about is *what was
 * written*: a stub that swallowed the writes would make every assertion below pass against a
 * function that drew nothing.
 */
function fakeNode() {
  const classes = new Set<string>()
  const style: Record<string, string> = {}
  const children: Array<ReturnType<typeof fakeNode>> = []
  const node = {
    style: {
      values: style,
      setProperty(name: string, value: string) { style[name] = value },
    },
    classList: {
      toggle(name: string, on: boolean) {
        if (on) classes.add(name)
        else classes.delete(name)
      },
      has: (name: string) => classes.has(name),
    },
    textContent: '',
    children,
    // `buildWakeMeter` builds the dots through these two, so a stub without them would make it throw
    // rather than making it draw the wrong number of dots.
    append(child: ReturnType<typeof fakeNode>) { children.push(child) },
    replaceChildren() { children.length = 0 },
  }
  return node
}

/**
 * The page's drawing half, running against a stand-in for the document.
 *
 * The state variables are declared inside the same scope as the functions under test — they live
 * in `main()`'s closure in the real page — so `applyWakeScore` writes the values `paintWakeMeter`
 * then reads, exactly as it does live. Handing them in as separate stubs would let the test pass
 * with the two halves wired to different variables.
 *
 * The clock is a dependency for the same reason: the hold on a fired reading is the one piece of
 * meter state that ends by itself, and a test that could not move the clock could only check that
 * it started, never that it stops. `setTimeout` is captured rather than run so the hold's own
 * expiry can be fired on demand instead of by waiting 2.6 s per test.
 */
function meterHarness() {
  const meter = fakeNode()
  const fill = fakeNode()
  const score = fakeNode()
  const streak = fakeNode()
  const timers: Array<() => void> = []
  let now = 1_000_000
  const factory = new Function('deps', `
    const { wakeMeter, wakeMeterFill, wakeMeterScore, wakeMeterStreak, document, CONSECUTIVE_WINDOWS,
            WAKE_HOLD_MS, Date, setTimeout, clearTimeout, syncWake } = deps
    let wakeScore = 0
    let wakeAbove = false
    let wakeStreak = 0
    let wakeThreshold = 0.95
    let wakeHeld
    let wakeDrawn = 0
    ${pageFunction(shell, 'buildWakeMeter')}
    ${pageFunction(shell, 'wakeScoreIn')}
    ${pageFunction(shell, 'holdWake')}
    ${pageFunction(shell, 'heldWake')}
    ${pageFunction(shell, 'applyWakeScore')}
    ${pageFunction(shell, 'paintWakeMeter')}
    return {
      buildWakeMeter,
      wakeScoreIn,
      holdWake,
      heldWake,
      applyWakeScore,
      paintWakeMeter,
      read: () => ({ wakeScore, wakeAbove, wakeStreak, wakeThreshold, held: wakeHeld }),
    }
  `)
  let syncCalls = 0
  // The real `syncWake` paints whenever it decides the bar belongs on screen, and `holdWake` relies
  // on that: taking a hold has to be able to bring the bar up on its own, because the hold is what
  // keeps a fired reading on screen through the recording that follows. A stub that only counted
  // would let `holdWake` draw nothing and every assertion below still pass against the wrong value,
  // so this one paints too - and it is bound after the factory runs because `paintWakeMeter` lives
  // in the same scope it is handed into.
  let paintFromSync: () => void = () => {}
  const page = factory({
    wakeMeter: meter,
    wakeMeterFill: fill,
    wakeMeterScore: score,
    wakeMeterStreak: streak,
    document: {
      createElement: () => fakeNode(),
    },
    CONSECUTIVE_WINDOWS,
    WAKE_HOLD_MS,
    Date: { now: () => now },
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length },
    clearTimeout: () => {},
    // The other half of what the real one does - deciding whether the meter belongs on screen - is
    // tested against its own harness below, so here it is only counted.
    syncWake: () => { syncCalls += 1; paintFromSync() },
  }) as {
    buildWakeMeter: () => void
    wakeScoreIn: (detail: unknown) => number | undefined
    holdWake: (score: number | undefined) => void
    heldWake: () => { score: number } | undefined
    applyWakeScore: (update: unknown) => void
    paintWakeMeter: () => void
    read: () => { wakeScore: number; wakeAbove: boolean; wakeStreak: number; wakeThreshold: number; held: unknown }
  }
  paintFromSync = page.paintWakeMeter
  /** Move the clock past the hold and run whatever the page scheduled for its expiry. */
  const advance = (ms: number) => {
    now += ms
    const due = timers.splice(0, timers.length)
    for (const callback of due) callback()
  }
  return { meter, fill, score, streak, page, advance, at: () => now, syncCalls: () => syncCalls }
}

/** A named `function name(...) { … }` cut out by brace matching. */
function pageFunction(source: string, name: string): string {
  const head = source.indexOf(`function ${name}(`)
  assert.notEqual(head, -1, `${name} is missing from the page`)
  const start = source.slice(head - 6, head) === 'async ' ? head - 6 : head
  const open = source.indexOf('{', head)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/** The value the bar's width is derived from: `width: calc(var(--wake-score) * 100%)`. */
function barValue(meter: ReturnType<typeof fakeNode>): number {
  const raw = meter.style.values['--wake-score']
  assert.notEqual(raw, undefined, 'the fill was never given a length')
  return Number(raw)
}

/**
 * `syncWake`, running against a stand-in for the page, reporting whether the meter ended up visible.
 *
 * The meter's whole promise is "this is the score the microphone is being judged by", so the states
 * it is *not* up in matter as much as the ones it is: a bar left on screen over a released
 * microphone is a live-looking readout of nothing.
 */
function syncWakeHarness(inputs: { wakeState: string; dictationPhase?: string; held?: number }) {
  const classes = new Set<string>()
  const badge = { textContent: '', hidden: true, title: '' }
  const ball = {
    title: '',
    removeAttribute(name: string) { if (name === 'title') delete (this as { title?: string }).title },
  }
  const meter = { hidden: true }
  let paints = 0
  const factory = new Function('deps', `
    const { document, pageClosed, dictationPhase, wakeState, wakeMeter, paintWakeMeter, messages,
            expanded, wakeKeyword, KEYWORD_NAMES, wakeDetail, heldWake } = deps
    ${pageFunction(shell, 'syncWake')}
    return syncWake
  `)
  const syncWake = factory({
    document: {
      body: {
        classList: {
          toggle(name: string, on: boolean) {
            if (on) classes.add(name)
            else classes.delete(name)
          },
        },
      },
      querySelector: (selector: string) => (selector === '#wake-badge' ? badge : ball),
    },
    pageClosed: () => false,
    dictationPhase: inputs.dictationPhase,
    wakeState: inputs.wakeState,
    wakeMeter: meter,
    paintWakeMeter: () => { paints += 1 },
    heldWake: () => (inputs.held === undefined ? undefined : { score: inputs.held }),
    messages: {
      wakeRecording: 'recording',
      wakeTranscribing: 'transcribing',
      wakeLoading: 'loading',
      wakeDetected: 'detected',
      wakeUnavailable: 'unavailable',
      wakeFailed: 'failed: {why}',
      wakeListening: 'say {word}',
    },
    expanded: false,
    wakeKeyword: 'dafeiyu',
    KEYWORD_NAMES: { hey_jarvis: 'Hey Jarvis', dafeiyu: '大肥鱼大肥鱼' },
    wakeDetail: '',
  }) as () => void
  return { syncWake, meter, classes, paints: () => paints }
}

describe('when the meter is on screen', () => {
  it('is up while the engine is listening, and stays up through a detection', () => {
    const listening = syncWakeHarness({ wakeState: 'listening' })
    listening.syncWake()
    assert.equal(listening.meter.hidden, false, 'the meter is down while the engine is listening')

    const detected = syncWakeHarness({ wakeState: 'detected' })
    detected.syncWake()
    assert.equal(detected.meter.hidden, false, 'the meter drops the moment the ball wakes')
  })

  it('is down for the whole of a recording, which is the one stretch nothing scores', () => {
    // `runModels` is skipped for the whole utterance — `processChunk` hands those frames to the
    // recorder instead — so the last reading on screen is the wake word that opened it, not the
    // sentence being spoken. A live-looking bar over a microphone that is not being scored is a
    // number about nothing, and it is the bar a user reads as "it woke and the score was there".
    const fixture = syncWakeHarness({ wakeState: 'detected', dictationPhase: 'recording' })
    fixture.syncWake()
    assert.equal(fixture.meter.hidden, true, 'the meter stayed up over a recording, which is not scored')
  })

  it('stays up for a recording that a held reading is keeping alive', () => {
    const fixture = syncWakeHarness({ wakeState: 'detected', dictationPhase: 'recording', held: 0.99 })
    fixture.syncWake()
    assert.equal(fixture.meter.hidden, false,
                 'the reading that fired was taken off screen by the recording it started')
  })

  it('is up while the transcript is being waited for, because that is scored audio too', () => {
    // The engine lets go of the microphone only while *recording*; `finishDictation` hands the
    // sentence to the host and the wake models begin scoring again immediately. The page waits up to
    // `DICTATION_TIMEOUT_MS` for the transcript, and the engine reports `listening` again within a
    // few seconds of the recording ending — so for most of that wait the engine's state is
    // `listening`, not `detected`, and that is the state a wake lands in. The bar was hidden here,
    // which is the wake the user heard with no reading beside it. Both states are checked because
    // the detection hold is real for the first few seconds of the wait; an assertion that only used
    // `detected` would pass against a rule that hid the bar for the rest of it.
    for (const state of ['listening', 'detected']) {
      const fixture = syncWakeHarness({ wakeState: state, dictationPhase: 'transcribing' })
      fixture.syncWake()
      assert.equal(fixture.meter.hidden, false,
                   `the meter is down while the engine is listening for the next wake word (${state})`)
    }
  })

  it('is down whenever there is no live score behind it', () => {
    for (const state of ['disabled', 'loading', 'error']) {
      const fixture = syncWakeHarness({ wakeState: state })
      fixture.syncWake()
      assert.equal(fixture.meter.hidden, true, `the meter is up in the ${state} state`)
    }
  })

  it('redraws on the way up, so it opens on the engine\'s reading and not the last stream\'s', () => {
    const fixture = syncWakeHarness({ wakeState: 'listening' })
    fixture.syncWake()
    assert.equal(fixture.paints(), 1, 'the meter was shown without being drawn')
    const hidden = syncWakeHarness({ wakeState: 'disabled' })
    hidden.syncWake()
    assert.equal(hidden.paints(), 0, 'the meter was drawn while it was hidden')
  })
})

describe('the meter under the ball', () => {
  it('draws the score as a fraction of the track, and the readout as the score itself', () => {
    const { meter, score, page } = meterHarness()
    page.applyWakeScore({ score: 0.412, above: false, streak: 0, threshold: 0.95 })
    // A fraction, not a percentage: the sheet multiplies it by the track's own width, so writing
    // 41.2 here would paint the fill 41 tracks wide.
    assert.equal(barValue(meter), 0.412, 'the bar is not the score as a fraction of the track')
    assert.equal(score.textContent, '0.412', 'the readout does not carry the score')
  })

  it('puts the threshold line where the engine scores against, not at a fixed place', () => {
    const { meter, page } = meterHarness()
    page.applyWakeScore({ score: 0, above: false, streak: 0, threshold: 0.6 })
    assert.equal(meter.style.values['--wake-threshold'], '0.6',
                   'the line is drawn at the wrong threshold')
    page.applyWakeScore({ score: 0, above: false, streak: 0, threshold: 0.95 })
    assert.equal(meter.style.values['--wake-threshold'], '0.95', 'the line did not follow the engine')
  })

  it('marks the bar only for a window that actually crossed the threshold', () => {
    const { meter, page } = meterHarness()
    page.applyWakeScore({ score: 0.9, above: false, streak: 0, threshold: 0.95 })
    assert.equal(meter.classList.has('hot'), false, 'a window under the threshold was marked as over it')
    page.applyWakeScore({ score: 0.96, above: true, streak: 1, threshold: 0.95 })
    assert.equal(meter.classList.has('hot'), true, 'a window over the threshold was not marked')
  })

  it('shows the run as dots, and the run reaching the rule as all of them lit', () => {
    const { streak, page, meter } = meterHarness()
    page.buildWakeMeter()
    assert.equal(streak.children.length, CONSECUTIVE_WINDOWS,
                 'the meter has a different number of dots than the rule has windows')
    const lit = () => streak.children.filter((dot) => dot.classList.has('on')).length
    page.applyWakeScore({ score: 0.9, above: false, streak: 0, threshold: 0.95 })
    assert.equal(lit(), 0, 'a dead run lit a dot')
    page.applyWakeScore({ score: 0.99, above: true, streak: 1, threshold: 0.95 })
    assert.equal(lit(), 1, 'the first window of a run did not light its dot')
    page.applyWakeScore({ score: 0.99, above: true, streak: 2, threshold: 0.95 })
    assert.equal(lit(), 2, 'the second window of a run did not light its dot')
    // The engine resets the run on the window that fires, so the meter has to be able to go back to
    // none lit without a state change of its own.
    page.applyWakeScore({ score: 0.99, above: true, streak: 0, threshold: 0.95 })
    assert.equal(lit(), 0, 'a fired run left its dots lit')
    assert.equal(meter.classList.has('hot'), true, 'the firing window is still over the threshold')
  })

  it('clamps a stray score instead of drawing outside the track', () => {
    const { meter, page } = meterHarness()
    page.applyWakeScore({ score: 1.4, above: false, streak: 0, threshold: 0.95 })
    assert.equal(barValue(meter), 1, 'a score above 1 was passed on to the sheet')
    page.applyWakeScore({ score: -0.2, above: false, streak: 0, threshold: 0.95 })
    assert.equal(barValue(meter), 0, 'a negative score was passed on to the sheet')
  })

  it('ignores a malformed report rather than drawing nonsense', () => {
    const { meter, page, score } = meterHarness()
    page.applyWakeScore({ score: 0.5, above: false, streak: 0, threshold: 0.95 })
    const before = { bar: barValue(meter), text: score.textContent }
    page.applyWakeScore(null)
    page.applyWakeScore('score 0.9')
    page.applyWakeScore({ score: Number.NaN, above: false, streak: 0, threshold: Number.NaN })
    assert.deepEqual({ bar: barValue(meter), text: score.textContent }, before,
                     'a report that is not a score overwrote the last real one')
  })

  it('holds the reading that fired, so the chime can still be explained after it', () => {
    const { meter, page, streak } = meterHarness()
    page.buildWakeMeter()
    const lit = () => streak.children.filter((dot) => dot.classList.has('on')).length
    // The window that fires: the engine reports the run complete and then clears it, and the ball
    // chimes on that same window. Everything the user could read is gone within one window unless
    // the page keeps it.
    page.holdWake(0.981)
    page.applyWakeScore({ score: 0.02, above: false, streak: 0, threshold: 0.95 })
    assert.equal(barValue(meter), 0.981, 'the fired reading was overwritten by the next window')
    assert.equal(lit(), CONSECUTIVE_WINDOWS, 'the run that fired is not shown as a complete run')
    assert.equal(meter.classList.has('hot'), true, 'the held reading is not drawn as over the line')
    assert.equal(meter.classList.has('held'), true, 'the held reading is not marked as a record')
    assert.equal(barValue(meter) > 0.95, true)
  })

  it('survives the reset that ends the recording it started', () => {
    const { meter, page } = meterHarness()
    page.holdWake(0.981)
    // `finishDictation` empties the ring and reports a zero on the way out; the chime is seconds old
    // by then and the bar is the only thing left that says what woke the ball.
    page.applyWakeScore({ score: 0, above: false, streak: 0, threshold: 0.95 })
    page.applyWakeScore({ score: 0, above: false, streak: 0, threshold: 0.95 })
    assert.equal(barValue(meter), 0.981, 'the held reading was cleared by the next zero')
  })

  it('lets go of the held reading when the hold ends, and asks the page to re-decide the screen', () => {
    const { meter, page, advance, syncCalls } = meterHarness()
    page.holdWake(0.981)
    page.applyWakeScore({ score: 0.02, above: false, streak: 0, threshold: 0.95 })
    // Taking a hold asks the page once already, so the count is not zero here and asserting that it
    // is non-zero would pass on the take alone. What this measures is the *second* ask, the one the
    // expiry makes: the hold is the only meter state that ends by itself, so it is the only state
    // that can leave the bar up over a microphone nothing is scoring unless it says so.
    const afterTake = syncCalls()
    advance(WAKE_HOLD_MS + 1)
    assert.equal(page.heldWake(), undefined, 'the hold never ends, so a stale reading can outlive its reason')
    assert.equal(syncCalls() > afterTake, true,
                 'the hold expired without asking whether the meter still belongs on screen')
    page.applyWakeScore({ score: 0.02, above: false, streak: 0, threshold: 0.95 })
    assert.equal(barValue(meter), 0.02, 'the live reading did not come back after the hold')
    assert.equal(meter.classList.has('held'), false, 'the record marking outlived the hold')
  })

  it('asks the page to re-decide the screen when a hold is taken', () => {
    const { page, syncCalls } = meterHarness()
    assert.equal(syncCalls(), 0, 'something asked before a hold was even taken')
    // A hold is one of the two things that can keep the bar on screen - `syncWake` reads it directly
    // - so taking one has to re-decide the screen, the same way letting one expire does. Drawing
    // without re-deciding only touches the half that cannot bring the bar back: the reading is
    // there, and not shown. Both edges of the hold go through the one function that owns the screen.
    page.holdWake(0.99)
    assert.equal(syncCalls() > 0, true,
                 'the hold was taken without asking whether the bar belongs on screen')
  })

  it('a later fire replaces the hold rather than stacking on it', () => {
    const { page, advance, meter } = meterHarness()
    page.holdWake(0.96)
    advance(Math.floor(WAKE_HOLD_MS / 2))
    page.holdWake(0.99)
    advance(Math.floor(WAKE_HOLD_MS / 2) + 1)
    assert.equal(page.heldWake()?.score, 0.99, 'the second fire was cut short by the first one\'s timer')
    // Not `f32` here: this score is handed in directly rather than read back out of the classifier's
    // tensor, so it is the exact number the page was given, and rounding it would be measuring a
    // conversion that never happened.
    assert.equal(barValue(meter), 0.99)
  })

  it('draws a crossing the instant it happens, and animates only a fall', () => {
    const { fill, page } = meterHarness()
    page.applyWakeScore({ score: 0.2, above: false, streak: 0, threshold: 0.95 })
    // A run that fires is three windows and the chime is two windows later, so a fill that eases
    // upwards is still climbing when the wake is heard: the bar would explain the decision after the
    // fact. Rising lengths are written straight through.
    page.applyWakeScore({ score: 0.97, above: true, streak: 1, threshold: 0.95 })
    assert.equal(fill.classList.has('falling'), false,
                 'a rising reading was animated, so the bar can lag the window that crossed')
    page.applyWakeScore({ score: 0.3, above: false, streak: 0, threshold: 0.95 })
    assert.equal(fill.classList.has('falling'), true,
                 'a falling reading is not animated, so every quiet window snaps the bar back')
  })

  it('reads the score a detection fired at out of the engine\'s own detail', () => {
    const { page } = meterHarness()
    assert.equal(page.wakeScoreIn('score 0.987'), 0.987, 'the engine reports the score and the page drops it')
    // Anything else leaves the hold to fall back to the live reading, which is the same window.
    for (const detail of [undefined, '', 'ready', 'score ', null]) {
      assert.equal(page.wakeScoreIn(detail), undefined, `"${String(detail)}" was read as a score`)
    }
  })
})
