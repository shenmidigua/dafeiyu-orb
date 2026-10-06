/**
 * The release face: what the ball wears the moment the pointer lets go of a carried ball.
 *
 * `drag` was already a slot, but it is a *state* — worn for as long as the ball is being carried —
 * so it has exactly one exit, and that exit went straight back to the resting loop. A carry that
 * starts with one animation and ends with a different one is the whole gesture; ending it on an
 * unrelated idle face is what made the drop read as "the drag stopped" rather than "the ball landed".
 *
 * The three things easy to get wrong, all pinned below:
 *
 *   * the *edges*. Setting `dragging = false` is not a repaint. `finishPointer` already called
 *     `syncGif()` for the release position, and that call happens with no drop shown — so the drop
 *     has to be played as its own event, after it. The one-shot carries a `step` for the same
 *     reason `click` and `wake` do: a new `dataset.mode` is what makes the `<img>` reload the GIF
 *     from its first frame instead of holding the last one. Without the step, a second drag in the
 *     same session replays nothing at all.
 *   * the *priority*. The drop sits directly under `drag` and above everything else. Under, because
 *     picking the ball up again must cut the drop short — being carried is the more current fact.
 *     Above, because it is the other half of the gesture the user just finished, and it would be
 *     absurd for a click reaction triggered by the same pointerup to cover it.
 *   * the *cold cache*. `refreshFrames()` normally has the frame in hand, but the first drag after
 *     a restart can beat the burst cycle. This is the one reaction the user is guaranteed to be
 *     staring at, so an uncached frame is fetched on demand rather than skipped — and the redraw
 *     that drops the drag face is deliberately not withheld while that read is in flight, or the
 *     ball would freeze on the carry until it came back.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

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

const DROP = 'data:image/gif;base64,DROP'
const DRAG = 'data:image/gif;base64,DRAG'
const IDLE = 'data:image/gif;base64,IDLE'

interface GifInputs {
  dragging?: boolean
  dragSrc?: string
  dropShown?: { src: string; step: number }
  clickShown?: { src: string; step: number }
  wakeShown?: { src: string; step: number }
  doneShown?: { src: string; step: number }
  idleSrc?: string
}

/**
 * Run `syncGif` with every pose this test is not about left undefined, and report the mode it chose.
 *
 * The one-shot reactions and the agent's own frames are disarmed rather than stubbed with a
 * sentinel, so a change that moves a new branch above the drop shows up as this function's answer
 * changing instead of as a silent behaviour change in the orb.
 */
function modeFor(inputs: GifInputs): string {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const factory = new Function('deps', `
    const { document, pageClosed, syncSleep, dragging, dragSrc, dropShown, clickShown, arriveShown,
            wakeShown, doneShown, typingSrc, replySrc, toolSrc, thinkingSrc, speakSrc, speakActive,
            voiceSrc, dictationPhase, idleSrc, hoverSrc, introTimer, napShown, skitInfo, running,
            asking, tccGateVisible, attachedSelection, expanded, avatarSrc, freezeGif, Date,
            sleepFrameAt, skitFrame, hoverIntroSrc, introUntil, hovering, webfetchSrc, agentState,
            agentTool, WEB_FETCH_TOOL, brokeNow, dragIntroSrc, dragIntroUntil } = deps
    ${pageFunction(shell, 'syncGif')}
    return syncGif
  `)
  const syncGif = factory({
    document: { querySelector: () => gif },
    pageClosed: () => false,
    syncSleep: () => {},
    // The poor face is off here: whether the account is nearly empty is a question about the
    // resting loop, and every case in this file is about the release. The real predicate is walked
    // in `dsh_orb/walk_poor_sequence.mjs`, against the installed page.
    brokeNow: () => false,
    dragging: inputs.dragging ?? false,
    dragSrc: inputs.dragSrc ?? (inputs.dragging ? DRAG : undefined),
    // The carry is painted in two halves once a pickup clip is configured: the intro while its
    // hold lasts, then the hang loop. These cases are about the release, which requires the carry
    // to still be the thing on screen — so no pickup is in flight and `dragSrc` decides.
    dragIntroSrc: undefined,
    dragIntroUntil: 0,
    dropShown: inputs.dropShown,
    clickShown: inputs.clickShown,
    // Named because a branch above the release now reads it, and disarmed because no greeting is
    // in progress in these cases. Leaving it out is a `ReferenceError` in the harness, not a
    // failed expectation — which reads as a broken test file rather than as the change it caught.
    arriveShown: undefined,
    wakeShown: inputs.wakeShown,
    doneShown: inputs.doneShown,
    typingSrc: undefined,
    replySrc: undefined,
    toolSrc: undefined,
    thinkingSrc: undefined,
    speakSrc: undefined,
    speakActive: false,
    voiceSrc: undefined,
    dictationPhase: 'idle',
    idleSrc: inputs.idleSrc ?? IDLE,
    hoverSrc: undefined,
    hoverIntroSrc: undefined,
    introUntil: 0,
    hovering: false,
    introTimer: undefined,
    napShown: undefined,
    skitInfo: undefined,
    skitFrame: undefined,
    sleepFrameAt: () => undefined,
    running: false,
    asking: () => false,
    tccGateVisible: false,
    attachedSelection: '',
    expanded: false,
    avatarSrc: 'data:image/gif;base64,AVATAR',
    freezeGif: () => {},
    Date,
    // No tool is running in any of these cases, so the fetch face stays disarmed — which is also
    // what shows it sits below the release rather than above it.
    webfetchSrc: undefined,
    agentState: '',
    agentTool: '',
    WEB_FETCH_TOOL: 'web_fetch',
  }) as () => void
  syncGif()
  assert.notEqual(gif.dataset.mode, undefined, 'syncGif fell through every branch without painting')
  return gif.dataset.mode as string
}

describe('the release face in syncGif', () => {
  it('wears the drop while the release is playing', () => {
    assert.equal(modeFor({ dropShown: { src: DROP, step: 1 } }), 'drop-1')
  })

  it('outranks the resting loop, which is what it replaced', () => {
    // Without this the drop would be invisible: the ball would simply stop wearing the drag face
    // and go back to idle, which is precisely the exit this slot was added to remove.
    assert.notEqual(modeFor({ dropShown: { src: DROP, step: 1 } }), 'idle')
  })

  it('outranks the click reaction from the same pointerup', () => {
    // `finishPointer` returns `true` for a drag so the click never plays, but the two can still
    // collide when a turn ends inside the drop. The gesture the user just finished wins.
    assert.equal(modeFor({
      dropShown: { src: DROP, step: 2 },
      clickShown: { src: 'data:image/gif;base64,CLICK', step: 1 },
    }), 'drop-2')
  })

  it('yields to a new carry, because being carried is the more current fact', () => {
    // Drag → drop → drag again without pause. The first drop must not hold the face hostage.
    assert.equal(modeFor({ dragging: true, dragSrc: DRAG, dropShown: { src: DROP, step: 1 } }), 'drag')
  })

  it('goes back to the resting loop once the release is over', () => {
    assert.equal(modeFor({ dropShown: undefined }), 'idle')
  })
})

/**
 * Build a `playDropFrame` with a frame already resolved, and report the modes it paints.
 *
 * The page's `playDropFrame` calls the ambient `setTimeout`/`clearTimeout` rather than taking them
 * as parameters, so the harness swaps the globals for the duration of a play instead of injecting
 * them — that is also what lets `dropStep` survive across two gestures in one harness, which is
 * the whole point of the step test below. The frame is supplied already resolved, so what is under
 * test is the one-shot bookkeeping rather than the read.
 *
 * `loops` is the flag `timedFrameOf` reads off the frame's own bytes, and it decides how the hold
 * is scheduled: a clip that stops on its last frame can be parked there, one that restarts on its
 * own cannot.
 */
function dropHarness(
  holdMs: number,
  loops = false,
): { modes: string[]; play: () => void; fire: () => void } {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const factory = new Function('deps', `
    const { gif, fetchDrop, ONE_SHOT_MIN_MS } = deps
    let dropFrame = { src: deps.DROP, ms: deps.HOLD, loops: deps.LOOPS }
    let dropShown
    let dropTimer
    let dropStep = 0
    const syncGif = () => {
      if (dropShown !== undefined) {
        const mode = \`drop-\${dropShown.step}\`
        if (gif.dataset.mode !== mode) { gif.dataset.mode = mode; gif.src = dropShown.src }
        return
      }
      gif.dataset.mode = 'idle'
    }
    ${pageFunction(shell, 'oneShotHoldMs')}
    ${pageFunction(shell, 'playDropFrame')}
    return { play: playDropFrame }
  `)
  let pending: (() => void) | undefined
  const modes: string[] = []
  const built = factory({
    gif,
    fetchDrop: async () => null,
    ONE_SHOT_MIN_MS: 900,
    DROP,
    HOLD: holdMs,
    LOOPS: loops,
  }) as { play: () => void }
  const timer = { cb: undefined as (() => void) | undefined }

  return {
    modes,
    play: () => {
      // The page's own `setTimeout`/`clearTimeout` are the globals this function calls, so they
      // are installed on the factory's realm for the duration of the play rather than injected.
      const savedSet = globalThis.setTimeout
      const savedClear = globalThis.clearTimeout
      globalThis.setTimeout = ((cb: () => void) => { timer.cb = cb; return 1 }) as never
      globalThis.clearTimeout = (() => { timer.cb = undefined }) as never
      try {
        built.play()
      } finally {
        globalThis.setTimeout = savedSet
        globalThis.clearTimeout = savedClear
      }
      modes.push(gif.dataset.mode as string)
    },
    fire: () => {
      assert.notEqual(timer.cb, undefined, 'no hold was scheduled, so the drop would never end')
      ;(timer.cb as () => void)()
      modes.push(gif.dataset.mode as string)
    },
  }
}

describe('playing the release frame', () => {
  it('takes a new step every time, so a second drag replays instead of freezing', () => {
    // Same `src`, two gestures. Without the step the second `syncGif` would see an unchanged mode
    // and leave the image element on the GIF's last frame — the drop would simply not appear.
    const harness = dropHarness(1500)
    harness.play()
    assert.equal(harness.modes[0], 'drop-1')
    harness.fire()
    assert.equal(harness.modes[1], 'idle')

    harness.play()
    assert.equal(harness.modes[2], 'drop-2',
      'the second release reused the first mode, so the GIF would not have restarted')
    harness.fire()
    assert.equal(harness.modes[3], 'idle')
  })

  it('returns to the resting loop when the hold expires', () => {
    const played = dropHarness(1500)
    played.play()
    assert.equal(played.modes[0], 'drop-1')
    played.fire()
    assert.equal(played.modes[1], 'idle', 'the drop outstayed its own animation')
  })

  it('holds for at least the one-shot floor, however short the GIF claims to be', () => {
    // A mis-measured GIF reporting 40ms would otherwise flash for a single frame and look like
    // nothing happened at all. The floor is the same one `click` and `wake` use — and it applies
    // to a clip that stops on its own, which can be parked on that last frame indefinitely.
    const played = dropHarness(40)
    let heldMs = 0
    const savedSet = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void, ms: number) => { heldMs = ms; void cb; return 1 }) as never
    try {
      const factory = new Function('deps', `
        const { gif, fetchDrop, ONE_SHOT_MIN_MS } = deps
        let dropFrame = { src: deps.DROP, ms: deps.HOLD, loops: false }
        let dropShown
        let dropTimer
        let dropStep = 0
        const syncGif = () => {}
        ${pageFunction(shell, 'oneShotHoldMs')}
        ${pageFunction(shell, 'playDropFrame')}
        return playDropFrame
      `)
      const gif = { dataset: {} as { mode?: string } }
      const play = factory({
        gif, fetchDrop: async () => null, ONE_SHOT_MIN_MS: 900, DROP, HOLD: 40,
      }) as () => void
      play()
    } finally {
      globalThis.setTimeout = savedSet
    }
    assert.equal(heldMs, 900, 'a 40ms GIF was trusted over the one-shot floor')
  })

  it('gives a clip that restarts on its own one pass and no floor', () => {
    // The floor exists so a short *cue* can be read. A clip that loops cannot be held that way:
    // holding a 480ms bell for 900ms means watching it ring twice, and the hand-off would land
    // somewhere inside the second pass rather than before the first restart.
    const played = dropHarness(480, true)
    let heldMs = 0
    const savedSet = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void, ms: number) => { heldMs = ms; void cb; return 1 }) as never
    try {
      const factory = new Function('deps', `
        const { gif, fetchDrop, ONE_SHOT_MIN_MS, ONE_SHOT_CUT_MS } = deps
        let dropFrame = { src: deps.DROP, ms: deps.HOLD, loops: true }
        let dropShown
        let dropTimer
        let dropStep = 0
        const syncGif = () => {}
        ${pageFunction(shell, 'oneShotHoldMs')}
        ${pageFunction(shell, 'playDropFrame')}
        return playDropFrame
      `)
      const gif = { dataset: {} as { mode?: string } }
      const play = factory({
        gif, fetchDrop: async () => null, ONE_SHOT_MIN_MS: 900, ONE_SHOT_CUT_MS: 70, DROP, HOLD: 480,
      }) as () => void
      play()
    } finally {
      globalThis.setTimeout = savedSet
    }
    assert.equal(heldMs, 408, 'a looping clip was held past its own pass')
    assert.ok(heldMs < 480, 'the hold landed on the restart the clip makes at its own length')
  })
})

describe('the release edge in finishPointer', () => {
  it('plays the drop on the way out of a carry', () => {
    // The regression in one assertion: the release path repaints for the landing position and
    // then returns, so without a `playDropFrame()` in it the carry silently ends on the idle loop.
    const body = pageFunction(shell, 'finishPointer')
    const dragBranch = body.slice(body.indexOf('if (dragging)'))
    assert.match(dragBranch, /playDropFrame\(\)/,
      'finishPointer ends a drag without ever playing the release frame')
  })

  it('repaints before it plays, so an uncached frame cannot freeze the ball on the drag face', () => {
    // Order matters and is invisible in a screenshot: `playDropFrame` may have to read a whole GIF
    // over IPC, and during that read `dragging` is already false, so nothing else would take the
    // drag face off. The `syncGif()` that drops it must therefore come first.
    const body = pageFunction(shell, 'finishPointer')
    const dragBranch = body.slice(body.indexOf('if (dragging)'))
    const repaint = dragBranch.indexOf('syncGif()')
    const play = dragBranch.indexOf('playDropFrame()')
    assert.notEqual(repaint, -1, 'the release no longer repaints at all')
    assert.ok(repaint < play, 'the drop is played before the drag face is taken off')
  })

  it('only fires on a carry, never on a plain click', () => {
    // A click is `dragging === false` at this point and it has its own reaction. The non-carry tail
    // of `finishPointer` must not reach the drop, or every tap on the ball would land it.
    const body = pageFunction(shell, 'finishPointer')
    const play = body.indexOf('playDropFrame()')
    assert.notEqual(play, -1, 'the release frame is never played')
    // Everything after the `if (dragging)` block is the plain-click path, and it ends in
    // `return false`. The drop has to sit before that block closes.
    const tail = body.indexOf('return false')
    assert.notEqual(tail, -1, 'finishPointer no longer has a non-carry exit to check against')
    assert.ok(play < tail, 'the drop is played on the plain-click path as well')
  })

  it('plays it once per carry, not once per pointer event that ends one', () => {
    // `pointerup`, `pointercancel` and `lostpointercapture` all funnel into `finishPointer`, and a
    // real release fires two of them. `dragging` is already false by then, so the single call site
    // inside the branch is what makes the second one a no-op.
    const body = pageFunction(shell, 'finishPointer')
    const branch = body.slice(body.indexOf('if (dragging)'), body.indexOf('return true'))
    const calls = branch.split('playDropFrame()').length - 1
    assert.equal(calls, 1, 'the carry branch plays the release frame more than once')
  })
})
