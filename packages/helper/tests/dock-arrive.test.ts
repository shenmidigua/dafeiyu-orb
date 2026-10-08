/**
 * The docked arrival: the clip the strip plays when the pointer comes to rest on it.
 *
 * Docking hides the ball and leaves a 34px strip against a screen edge. That strip has always done
 * one thing 鈥?a drag pulls the ball back out 鈥?and this adds the other half: a hover plays a clip.
 * What makes it worth pinning is that every part of it is a decision rather than a mechanism.
 *
 *   * the *surface*. The strip is 34px wide and 288px tall and it is the whole of what is on screen,
 *     so `pointerOnBallOrPanel()` cannot be the test 鈥?the ball and the card are `visibility: hidden`
 *     and drawn at `--ball-column` inside that window, and no pointer can ever be on either. The band
 *     is the strip's own box plus the helper's capture margin on the inward edge, and the two
 *     handlers that can see the pointer have to ask *it* while the ball is docked.
 *   * the *dwell*. A hand crossing the strip on its way somewhere else is not a hover, and the clip
 *     is a whole gesture, so a crossing that plays it makes every trip down the edge of the screen
 *     fire one. `DOCK_ARRIVE_DWELL_MS` is that threshold, and it has to be armed on entry and
 *     dropped on exit rather than tested once.
 *   * the *hold*. The clip repeats itself (`loop=0`), so nothing announces the end of a pass and the
 *     image element would simply play it again. It is cut at one pass, and the ball then wears
 *     whatever the rest of `syncGif` says 鈥?which is checked against the page's real `syncGif`, not
 *     against a stub that would agree with anything.
 *   * the *dock*. The dock survives, and the ball is still not the user's to move — it is *shown*,
 *     not handed over. `enterUi` used to unsnap here, and the whole point of the slot is that it
 *     still does not: the strip is the only way back out, and a hover that pulled the ball out from
 *     under a passing pointer was the bug, not the feature. What the hover does do is bring the ball
 *     half way out of the edge, so the clip it plays is on something the user can see.
 *
 * The last case is the one that must not be a case at all: a pack that names no clip, or names one
 * that is not on disk, has to leave the strip exactly as it was. `fetchDockArrive` answers `null` for
 * every one of those and `playDockArrive` returns without painting, without throwing and without
 * scheduling 鈥?and the drag out of the dock, which never goes through here, is unaffected.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
const memes = readFileSync(join(here, '../src/memes.ts'), 'utf8')

/** A named `function name(...) { 鈥?}` cut out by brace matching, `async` included. */
function pageFunction(name: string): string {
  // Anchored so a name is never matched inside a longer one: `function actually` contains
  // `function act`, and the suffix would be whatever the comment above it said.
  const found = new RegExp(`(?:^|[^\\w$])(?:async )?function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = found.index + (found[0].startsWith('async ') ? 'async '.length : 0)
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let i = open; i < shell.length; i += 1) {
    if (shell[i] === '{') depth += 1
    else if (shell[i] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/** A `const NAME = 12` in the page, as a number. */
function number(name: string): number {
  const found = new RegExp(`const ${name} = ([0-9]+)\\b`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  return Number(found[1])
}

const DOCK_ARRIVE_DWELL_MS = number('DOCK_ARRIVE_DWELL_MS')
/**
 * Whether the page pulls the ball out of its strip on a hover.
 *
 * Off while the pull-out is retired. The three suites below assert what the gesture *does*, so they are skipped
 * rather than rewritten while it is parked: the assertions stay exactly as they were and come back with the
 * feature, which is the point of parking it rather than deleting it. `it('parks the hover pull-out…')` below is
 * what pins the parked state itself.
 */
const DOCK_HOVER_ENABLED = /const DOCK_HOVER_ENABLED = (true|false)/.exec(shell)?.[1] === 'true'
/**
 * One pass of the clip, as the *frame* carries it.
 *
 * The page used to own this number as `DOCK_ARRIVE_HOLD_MS`, measured once against a file that was then
 * cut from 30 frames to 22 — the constant stayed behind at 1280 ms, and the extra 400 ms was enough for
 * the entrance to begin its second pass before the loop replaced it. The read that hands the frame over
 * measures the length (`gifDurationMs`), so the page reads `ms` and owns nothing.
 */
const CLIP_MS = 880
const DOCK_ARRIVE_MARGIN_PX = number('DOCK_ARRIVE_MARGIN_PX')
const DOCK_PEEK_RELEASE_PX = number('DOCK_PEEK_RELEASE_PX')
const CAPTURE_MARGIN = Number(/const CAPTURE_MARGIN = (\d+)/.exec(main)?.[1])

const CLIP = 'data:image/gif;base64,ARRIVE'
const LOOP = 'data:image/gif;base64,LOOP'
const IDLE = 'data:image/gif;base64,IDLE'
const CLICK = 'data:image/gif;base64,CLICK'
/** One edge's arrival: the entrance it plays and the loop it hands over to. */
type Edge = { file: { src: string; ms: number; loops: boolean }; loop: string | null }

/** The clip as `timedFrameOf` hands one over: one pass of the arrival file, which loops. */
const CLIP_TIMED = { src: CLIP, ms: CLIP_MS, loops: true }
/** The docked arrival the page holds: the entrance plus the loop worn after it, or none. */
const CLIP_FRAME = { file: CLIP_TIMED, loop: null }
const CLIP_LOOPED = { file: CLIP_TIMED, loop: LOOP }
/**
 * The channel's answer, as the picker sends it: one entrance and loop per edge.
 *
 * The harness is about the strip's own behaviour — the dwell, the hand-over, the teardown — and every
 * case in it is about one edge, so the shared clip is handed over for both. The per-edge resolution
 * itself is `memes.test.ts`'s job, where the config is read.
 */
const edges = (frame: Edge | { left: Edge; right: Edge } | null | undefined) =>
  frame === null || frame === undefined || 'left' in frame ? frame : { left: frame, right: frame }
/** The same answer with the two edges telling each other apart, for the edge-selection cases. */
const LEFT_CLIP = 'data:image/gif;base64,ARRIVE-LEFT'
const LEFT_LOOP = 'data:image/gif;base64,LOOP-LEFT'

/** The docked picture's shift, read out of its own stylesheet rule: `translateX(<n>px)`, or `null`. */
function dockedShift(selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = new RegExp(`${escaped} \\{[\\s\\S]*?\\n\\}`).exec(css)?.[0]
  if (rule === undefined) return null
  const found = /translateX\((-?[\d.]+)px\)/.exec(rule)
  return found === null ? null : Number(found[1])
}

/** A clock that keeps every scheduled callback, so the dwell and the hold can be told apart. */
class FakeClock {
  private next = 1
  readonly pending = new Map<number, { ms: number; callback: () => void }>()
  private savedSet: typeof setTimeout | undefined
  private savedClear: typeof clearTimeout | undefined

  install(): void {
    this.savedSet = globalThis.setTimeout
    this.savedClear = globalThis.clearTimeout
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      const id = this.next
      this.next += 1
      this.pending.set(id, { ms, callback })
      return id
    }) as never
    globalThis.clearTimeout = ((id: number) => {
      this.pending.delete(id)
    }) as never
  }

  restore(): void {
    globalThis.setTimeout = this.savedSet as never
    globalThis.clearTimeout = this.savedClear as never
  }

  /** Every timer still pending, in milliseconds 鈥?one entry per live callback. */
  get delays(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms)
  }

  /** Fire the pending callbacks, oldest first, and report how many ran. */
  fireAll(): number {
    const running = [...this.pending.entries()]
    this.pending.clear()
    for (const [, timer] of running) timer.callback()
    return running.length
  }
}

/** The strip's own box, as the page measures it. Docked right on a 2560px display. */
const BAR = { left: 2526, top: 8, right: 2560, bottom: 296 }
const ON_STRIP = { clientX: 2540, clientY: 150 }

interface Harness {
  readonly clock: FakeClock
  /** What the image element is showing, or `undefined` while nothing has painted it. */
  painted(): string | undefined
  /** The source the image element is on, which is how "went back to the resting frame" is read. */
  shown(): string | undefined
  /** What the body is wearing 鈥?`docked` is the state this whole slot hangs off. */
  readonly classes: Set<string>
  /** The sources the page handed to a decoder, in order. */
  warm(): readonly string[]
  /** How many times the ball was asked back out of the dock. Must stay zero throughout. */
  readonly unsnaps: () => number
  /** How many questions the helper's pointer feed has been given. */
  readonly asks: () => number
  enter(point?: { clientX: number; clientY: number }): void
  leave(): void
  /** Something else takes the ball's face — a click, a carry — while the clip is up. */
  cue(face: 'click' | 'dragging' | 'dock-drag'): void
  /** Run `body` on the fake clock, so anything it schedules is countable. */
  run(body: () => void): void
  /** Let the microtask queue drain on the fake clock, for the on-demand read. */
  flush(): Promise<void>
}

/**
 * Build the page's own `enterUi` / `leaveUi` / `beginDockArrive` / `playDockArrive` / `syncGif` over
 * a stubbed bridge and a stubbed element, and report what they do.
 *
 * `cached` is the frame the page already holds: a real one for the ordinary case, `undefined` for a
 * hover that beats the frame sweep, and `null` for a pack that names no clip at all. `fetched` is
 * what the on-demand read answers, so the two can be told apart.
 *
 * `syncGif` is the page's own, with every pose this test is not about disarmed 鈥?so a clip that
 * changed hands, or a branch that moved, shows up here as this harness's answer changing.
 */
function harness(options: {
  /** The clip the page already holds: one shared clip, which is served for both edges, or the pair. */
  cached: Edge | { left: Edge; right: Edge } | null | undefined
  fetched?: Edge | null
  docked?: string | undefined
}): Harness {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const classes = new Set<string>(options.docked === undefined ? [] : ['docked', `docked-${options.docked}`])
  const counts = { unsnaps: 0, asks: 0 }
  const factory = new Function('deps', `
    const { gif, classes, dockTab, document, DOCK_ARRIVE_DWELL_MS,
            DOCK_ARRIVE_MARGIN_PX, DOCK_PEEK_RELEASE_PX, injected, api } = deps
    let docked = injected.DOCKED
    let dockPointerInside = false
    let dockHoverTimer
    let dockArriveFrame = injected.FRAME
    let dockArriveShown
    let dockArriveStep = 0
    let dockArriveTimer
    let dockArrivePending = false
    // The peek is the page's other half of this hover. Here it is the flag alone: dockPeeked stays
    // false, so pointerOnUi never takes its exception for a showing ball and the strip remains the
    // whole of the surface this file is about.
    let dockPeeked = false
    let hovering = false
    let suppressExpand = false
    let collapseTimer
    let dragging = false
    let carriedFromDock = false
    let collapsing = false
    let expanded = false
    let pinned = false
    let running = false
    let pointerAt
    let clickShown
    let dropShown
    let wakeShown
    let askShown
    let failShown
    let doneShown
    let arriveShown
    let dragSrc
    let dragIntroSrc
    let dragIntroUntil = 0
    let typingSrc
    let typingAt = 0
    let replySrc
    let thinkingSrc
    let toolSrc
    let speakSrc
    let speakActive = false
    let voiceSrc
    let dictationPhase = 'idle'
    let idleSrc = injected.IDLE
    let hoverSrc
    let hoverIntroSrc
    let introUntil = 0
    let avatarSrc = injected.AVATAR
    let sleepInfo
    let sleepTimer
    let restStartAt = 0
    let napShown
    let skitFrame
    let skitInfo
    let agentState = ''
    let agentTool = ''
    let poorSrc
    let balanceCny = null
    let poorBelow = 0
    let tccGateVisible = false
    let attachedSelection = ''
    let pending
    const pageClosed = () => false
    const applyHover = (next) => { hovering = next }
    const startHoverIntro = () => {}
    const stopHoverIntro = () => {}
    const asking = () => false
    const scheduleCollapse = () => {}
    const setExpanded = async () => {}
    // The peek asks the main process to grow the window, and does nothing when it has no channel to
    // ask on — so a stub that does nothing is the page's own answer here, not a simplification.
    const openDockPeek = async () => {}
    const closeDockPeek = async () => { dockPeeked = false }
    const brokeNow = () => false
    const sleepFrameAt = () => undefined
    const freezeGif = () => {}
    const syncSleep = () => { clearTimeout(sleepTimer); sleepTimer = undefined; napShown = undefined }
    ${pageFunction('syncGif')}
    async function unsnapDocked() {
      if (docked === undefined) return
      suppressExpand = true
      applyDocked(undefined)
      await api.unsnap()
    }
    function applyDocked(side) {
      docked = side === 'left' || side === 'right' ? side : undefined
      classes.delete('docked')
      classes.delete('docked-left')
      classes.delete('docked-right')
      if (docked !== undefined) classes.add('docked')
      if (docked !== undefined) classes.add('docked-' + docked)
      clearDockHoverTimer()
      clearDockArrive()
      dockTab.hidden = docked === undefined
    }
    function clearDockHoverTimer() {
      if (dockHoverTimer === undefined) return
      clearTimeout(dockHoverTimer)
      dockHoverTimer = undefined
    }
    ${pageFunction('pointerInDockBand')}
    ${pageFunction('pointerOnBallOrPanel')}
    ${pageFunction('pointerOnUi')}
    ${pageFunction('inside')}
    ${pageFunction('loopsForever')}
    ${pageFunction('timedFrameOf')}
    ${pageFunction('fetchDockArrive')}
    ${pageFunction('dockArriveFor')}
    // The page's own warmer, as the page has it: it hands each src to a decoder and forgets it. Nothing
    // here decodes, so it is the call and not the decode that the harness is holding to.
    const warmDockArriveFrame = (frame) => {
      if (frame === undefined || frame === null) return
      injected.warmed.push(frame.file.src)
      if (frame.loop !== null) injected.warmed.push(frame.loop)
    }
    ${pageFunction('playDockArrive')}
    ${pageFunction('clearDockArrive')}
    ${pageFunction('stopDockArriveTimer')}
    ${pageFunction('enterUi')}
    ${pageFunction('leaveUi')}
    ${pageFunction('beginDockArrive')}
    return {
      enter: (point) => { pointerAt = point; if (!pointerOnUi(point)) return; enterUi() },
      leave: () => { pointerAt = undefined; leaveUi() },
      cue: (face) => {
        if (face === 'click') { clickShown = { src: injected.CLICK, step: 1 }; syncGif() }
        // The pull-out as the page actually runs it: handDockDragToBall starts by calling
        // unsnapDocked(), and that is what tears the clip down — applyDocked(undefined) clears
        // the arrival, because a clip playing on the strip has nothing left to be about once
        // the strip is gone. Reproduced here so this case tests the page's ordering rather than
        // a simplified one, and so the carry face below is asked for after the teardown.
        else if (face === 'dock-drag') { void unsnapDocked(); dragging = true; carriedFromDock = true; dragSrc = injected.DRAG; syncGif() }
        else { dragging = true; dragSrc = injected.DRAG; syncGif() }
      },
      painted: () => gif.dataset.mode,
      shown: () => gif.src,
      hovered: () => hovering,
      warm: () => injected.warmed,
      classes,
      unsnaps: () => injected.counts.unsnaps,
      asks: () => injected.counts.asks,
    }
  `)
  const built = factory({
    gif,
    classes,
    document: { querySelector: () => gif },
    dockTab: {
      hidden: options.docked === undefined,
      offsetParent: {},
      getBoundingClientRect: () => BAR,
    },
    DOCK_ARRIVE_DWELL_MS,
    DOCK_ARRIVE_MARGIN_PX,
    DOCK_PEEK_RELEASE_PX,
    injected: {
      DOCKED: options.docked,
      FRAME: edges(options.cached),
      IDLE,
      CLICK,
      DRAG: 'data:image/gif;base64,DRAG',
      AVATAR: 'data:image/gif;base64,AVATAR',
      counts,
      /** The sources the page handed to a decoder, in order, so the warming can be read. */
      warmed: [] as string[],
    },
    api: {
      unsnap: async () => { counts.unsnaps += 1; return { docked: undefined } },
      memeDockArrive: async () => edges(options.fetched ?? null),
    },
  }) as {
    enter: (point?: { clientX: number; clientY: number }) => void
    leave: () => void
    cue: (face: 'click' | 'dragging' | 'dock-drag') => void
    painted: () => string | undefined
    shown: () => string | undefined
    hovered: () => boolean
    classes: Set<string>
    unsnaps: () => number
    asks: () => number
  }
  const clock = new FakeClock()
  const onClock = <T>(body: () => T): T => {
    clock.install()
    try {
      return body()
    } finally {
      clock.restore()
    }
  }
  return {
    clock,
    painted: built.painted,
    shown: built.shown,
    hovered: built.hovered,
    classes,
    unsnaps: built.unsnaps,
    asks: built.asks,
    enter: (point = ON_STRIP) => onClock(() => built.enter(point)),
    leave: () => onClock(() => built.leave()),
    cue: (face) => onClock(() => built.cue(face)),
    run: (body) => onClock(body),
    flush: async () => {
      // The on-demand read resolves on a microtask, and the play it re-enters schedules its hold on
      // whatever clock is ambient at that point 鈥?so the clock goes on around the flush too. No
      // macrotask boundary is crossed, so the test framework's own timers are never swapped.
      clock.install()
      try {
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        clock.restore()
      }
    },
  }
}

if (DOCK_HOVER_ENABLED) describe('the docked strip plays its arrival clip on a hover', () => {
  it('plays on the first turn after the hand arrives, and comes down after one pass of the clip', () => {
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    // The wait this slot used to keep before playing is gone, and the zero is deliberate: measured on
    // this machine it was 121 ms of the 127 ms between the hand reaching the strip and the entrance
    // appearing, which is the whole of what the hand feels on a thing it touched on purpose. See the
    // note on `DOCK_ARRIVE_DWELL_MS`.
    assert.equal(DOCK_ARRIVE_DWELL_MS, 0, 'the hand is waiting for a rest period again')
    assert.equal(page.painted(), undefined, 'the arrival went up in the same turn as the peek was asked for')
    // The timer still runs, so the entrance lands on the next task rather than inside the pointer event.
    assert.deepEqual(page.clock.delays, [DOCK_ARRIVE_DWELL_MS], 'something other than the wait was armed')
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1', 'the hover did not play the arrival')
    assert.equal(page.shown(), CLIP, 'and the strip was not given the clip')
    // One pass of the clip, timed by the length the frame carries — the page owns no constant for it, so
    // a file that is re-cut hands over on its own last frame. See `CLIP_MS`.
    assert.deepEqual(page.clock.delays, [CLIP_MS])
    page.run(() => page.clock.fireAll())
    // Back to whatever else `syncGif` says, and docked that is *nothing*: `syncGif` returns before the
    // idle branch and before the frozen `still` one, because a docked ball wears the strip's faces or
    // wears none, and `freezeGif` would repaint the element from a canvas and flash it over the clip.
    // So the element keeps the arrival it was already showing — the strip has not taken it off.
    assert.equal(page.painted(), 'dock-arrive-1', 'the arrival outstayed its own clip')
    assert.deepEqual(page.clock.delays, [], 'and left nothing behind')
  })

  it('tears the clip down for a pointer that only crossed the strip', () => {
    // The wait this replaces existed for this case, and what it bought was that a crossing never *showed*
    // the clip. Playing at once gives that up — a crossing now paints the entrance for the turn it takes
    // the pointer to leave — and what has to survive it is the teardown: the crossing must not leave the
    // entrance standing on a strip the hand has abandoned, and nothing may be left armed behind it.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1', 'the entrance never went up for the crossing to drop')
    page.leave()
    assert.deepEqual(page.clock.delays, [], 'the crossing left a timer armed behind it')
    assert.equal(page.clock.fireAll(), 0)
    // `clearDockArrive` takes the shown clip down; the mode the element is already wearing is not what
    // `syncGif` reads — it reads `dockArriveShown`, which the leave has emptied. So a crossing shows the
    // entrance for as long as the pointer is in the strip and no longer, and the next hover starts from a
    // fresh step rather than resuming this one.
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-2', 'the next hover resumed the crossing instead of starting over')
  })

  it('hands the ball over on the clip\'s own length, not on a number the page owns', () => {
    // The regression this pins was reported from the screen: "it played once and then played the beginning
    // again". The entrance had been cut from 30 frames of 40 ms to 22, the page still cut it at a
    // hand-measured 1280 ms, and the 400 ms left over was enough for the decoder to start the file over
    // before the loop replaced it. The length now comes from the frame, so there is nothing to re-measure
    // when the file changes.
    // The page must not *own* a hold for a clip it is handed the length of. Matched on the declaration
    // rather than on the name: `playDockArrive`'s own comment explains why that constant is gone, and a
    // search for the name would be asserting on the prose.
    assert.equal(/const DOCK_ARRIVE_HOLD_MS\b/.test(shell), false,
      'the page still declares a hold for a clip it is handed the length of')
    assert.match(pageFunction('playDockArrive'), /\}, entrance\.ms\)/,
      'the arrival is not cut at the frame\'s own measured length')

    // The behaviour, with a clip whose length is not the old constant: the hold is exactly one pass.
    const shorter = harness({ cached: { file: { src: CLIP, ms: 640, loops: true }, loop: null }, docked: 'right' })
    shorter.enter()
    shorter.run(() => shorter.clock.fireAll())
    assert.deepEqual(shorter.clock.delays, [640], 'the hand-over did not follow the clip it was given')

    // And the smear this was reported as, kept as arithmetic rather than as a story: the old constant was
    // 1280 ms and the clip is 880, so the ball wore the entrance for 400 ms after that clip had already
    // run out — a third of a pass of a file that had finished. If the numbers ever stop describing that,
    // this note is what says the fix no longer has a defect behind it.
    const OLD_CONSTANT_MS = 1280
    assert.equal(OLD_CONSTANT_MS - CLIP_MS, 400, 'the overshoot the old constant left is no longer 400 ms')
    assert.ok(OLD_CONSTANT_MS - CLIP_MS < CLIP_MS,
      'the old constant is no longer cutting this clip past its own length')
  })

  it('plays the clip of the edge the ball is standing on', () => {
    // The two edges want mirrored pictures — the ball is drawn flush against a screen edge looking into
    // the screen — so the picker answers for both and this is what picks between them. A left-docked ball
    // plays the left clip; a right-docked one plays the right, and never the other way round.
    const twoEdges = {
      left: { file: { src: LEFT_CLIP, ms: 500, loops: true }, loop: LEFT_LOOP },
      right: { file: CLIP_TIMED, loop: LOOP },
    }
    const left = harness({ cached: twoEdges, docked: 'left' })
    left.enter()
    left.run(() => left.clock.fireAll())
    assert.equal(left.shown(), LEFT_CLIP, 'a left-docked ball did not play the left entrance')
    assert.deepEqual(left.clock.delays, [500], 'its hold did not follow the left clip\'s own length')
    left.run(() => left.clock.fireAll())
    assert.equal(left.shown(), LEFT_LOOP, 'and it did not hand over to the loop of its own edge')

    const right = harness({ cached: twoEdges, docked: 'right' })
    right.enter()
    right.run(() => right.clock.fireAll())
    assert.equal(right.shown(), CLIP, 'a right-docked ball did not play the right entrance')
  })

  it('frames the clip the other way round on the left edge, where the unmirrored clips are drawn', () => {
    // The two edges play mirrored pictures of each other, so a shift calibrated on one is wrong on the
    // other: `冒泡 1登场水平翻转.gif` has its subject at x 302..499 of a 500px canvas and wants pulling left,
    // while `冒泡 1登场.gif` has its at x 0..191 and wants pulling right. Measured through
    // `getBoundingClientRect()`, the shipped `-44px` leaves only 86 of the 144 visible px carrying any
    // picture at all on the left edge, and `+44px` fills the band.
    const right = dockedShift('body.docked #ball-gif')
    const left = dockedShift('body.docked-left #ball-gif')
    assert.equal(right, -44, 'the mirrored clips are no longer framed by the shift this test knows')
    assert.equal(left, 44, 'the left edge is not framing its own, unmirrored clips')
    assert.equal(left, -right, 'the two shifts are no longer the same pull in opposite directions')
    assert.match(css, /translateX\(44px\) translateY\(-10px\) scale\(0\.9\)/,
      'the row and the scale are no longer shared with the right edge, which are the same question on either side')
  })

  it('never wears the idle loop while it is docked, not even in the gap before the clip', () => {
    // The strip's own faces are the arrival and the loop it hands over to. The idle loop belongs to a
    // ball that is free, and a docked ball that showed it would be a strip greeting the pointer with
    // the face of a ball nobody is looking at — for the whole of the dwell, which is the gap between
    // the peek appearing and the entrance starting.
    //
    // Three halves, because there are three ways a face could get there. `syncGif` has to leave the
    // element alone while docked — before the idle loop *and* before the frozen `still`, which would
    // repaint it from a canvas and flash over the clip — and the peek has to strip the idle loop the
    // ball carried into the dock, since nothing else would take it off.
    assert.match(pageFunction('syncGif'), /if \(docked !== undefined\) return\n\s*const broke = brokeNow\(\)/,
      'syncGif still reaches the idle loop while the ball is docked')
    assert.match(pageFunction('syncGif'), /if \(docked !== undefined\) return[\s\S]*?if \(gif\.dataset\.mode === 'still'\) return/,
      'and the early return sits above the frozen frame, not below it')
    assert.match(pageFunction('openDockPeek'), /removeAttribute\('src'\)/,
      'and the peek does not strip the face the ball came out of the dock wearing')

    // The behaviour, on the page's own `syncGif`: docked, the loop is not worn between the strip's faces.
    const page = harness({ cached: CLIP_LOOPED, docked: 'right' })
    page.run(() => page.clock.fireAll())
    assert.notEqual(page.shown(), IDLE, 'the idle loop is on the ball while the strip owns it')
    page.leave()
    assert.notEqual(page.shown(), IDLE, 'the idle loop came back with the strip')
  })

  it('and never puts a frozen frame on it either, which is what flickered', () => {
    // The regression this pins. Letting a docked ball fall through to `still` looks harmless — the
    // avatar is a still frame, and the ball is on screen for 120ms before the arrival — but
    // `freezeGif` does not leave a still frame: it paints the element to a canvas and writes that
    // back as its source. On every hover that canvas was committed over the clip just as the entrance
    // ended, which is the flicker.
    //
    // Matched on the call, not on the word: both functions *mention* freezing in their comments, and a
    // regex over the source would be asserting on the prose.
    assert.equal(/[^.\w]freezeGif\(/.test(pageFunction('openDockPeek')), false,
      'the peek freezes the ball onto a canvas while docked')
    const painter = pageFunction('syncGif')
    const bailout = painter.indexOf('if (docked !== undefined) return')
    assert.notEqual(bailout, -1, 'syncGif does not bail out while the ball is docked')
    assert.ok(bailout < painter.search(/[^.\w]freezeGif\(/),
      'the bailout is above the frozen frame, so a docked ball can still reach it')
  })

  it('and the idle loop is waiting the moment the dock is given up', () => {
    // The other half, so the exclusion cannot be read as "the idle loop is gone": undocking hands the
    // ball back, and a free ball at rest wears its loop as it always did.
    const page = harness({ cached: CLIP_LOOPED, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    page.cue('dock-drag')
    assert.equal(page.classes.has('docked'), false, 'the pull did not give the dock up')
    assert.equal(page.painted(), 'idle', 'a ball that is free again is not wearing the frozen frame')
  })

  it('rests on the loop the pack named, once the entrance has finished', () => {
    // The entrance plays one pass, then the loop takes over and stays: no hold is armed for it,
    // because it is not a clip that ends — it is the resting face, and it ends with the hover.
    const page = harness({ cached: CLIP_LOOPED, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1', 'the entrance did not play')
    assert.equal(page.shown(), CLIP, 'the entrance was not the clip it named')
    assert.deepEqual(page.clock.delays, [CLIP_MS], 'the entrance had no hold')
    page.run(() => page.clock.fireAll())
    assert.equal(page.shown(), LOOP, 'the loop did not take over after the entrance')
    assert.equal(page.painted(), 'dock-arrive-1', 'and it did not start a new step to do it')
    assert.deepEqual(page.clock.delays, [], 'a loop was given a hold it should not have')
    // And it stays — until the pointer leaves, which is what ends a loop that has no hold of its own.
    page.run(() => page.clock.fireAll())
    assert.equal(page.shown(), LOOP, 'the loop came down without the pointer leaving')
    page.leave()
    assert.equal(page.painted(), 'dock-arrive-1', 'the loop came down with the pointer')
  })

  it('plays on every hover, not once per page', () => {
    // The strip is a thing the user comes back to. A second visit takes a new step, which is what
    // makes the image element reload the clip from its first frame rather than hold the pose the
    // last visit stopped on.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1')
    page.run(() => page.clock.fireAll())
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-2', 'the second hover reused the first clip鈥檚 mode')
  })

  it('holds for a hover that arrives while the clip is already playing', () => {
    // A re-entry mid-clip restarts it rather than stacking a second hold: one image element, one
    // clip, and the hold measured from the hover that is current.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    page.leave()
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-2')
    assert.deepEqual(page.clock.delays, [CLIP_MS], 'a hover left more than one hold pending')
    assert.equal(page.clock.fireAll(), 1, 'more than one hold was still able to end the clip')
    assert.equal(page.painted(), 'dock-arrive-2')
  })

  it('takes the clip down when the pointer leaves partway through', () => {
    // "Takes down" is the arrival *state*, not the element: docked, `syncGif` no longer repaints, so
    // what proves the teardown is that nothing is holding the clip up any more — no hold armed, and
    // the next hover starts a fresh step rather than inheriting this one.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    page.leave()
    assert.deepEqual(page.clock.delays, [], 'the clip outlived the hand and left its hold armed')
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-2', 'the next hover did not start from a clean step')
  })

  it('reads a frame that has not arrived yet, and plays it when it does', async () => {
    // The first hover after a restart can beat the frame sweep. It reads rather than skipping, and a
    // second hover inside that read joins it instead of starting a second one.
    const page = harness({ cached: undefined, fetched: CLIP_FRAME, docked: 'left' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), undefined, 'the cold cache painted a clip it did not have')
    assert.deepEqual(page.clock.delays, [], 'the cold cache scheduled a hold for a clip it never got')
    await page.flush()
    assert.equal(page.painted(), 'dock-arrive-1')
    assert.deepEqual(page.clock.delays, [CLIP_MS])
  })

  it('plays nothing at all when the pack names no clip, and never throws', async () => {
    // The shipped default, a misspelled slot and a file that is not on disk are all the same answer:
    // the strip behaves exactly as it did before this slot existed.
    const missing = harness({ cached: null, fetched: null, docked: 'right' })
    missing.enter()
    missing.run(() => missing.clock.fireAll())
    await missing.flush()
    assert.equal(missing.painted(), undefined)
    assert.deepEqual(missing.clock.delays, [])
    // A channel the helper is too old to have is the same answer, not an exception.
    assert.match(pageFunction('fetchDockArrive'), /typeof api\.memeDockArrive !== 'function'/)
  })
})

if (DOCK_HOVER_ENABLED) describe("the clip is a cue, and the ball's own hand outranks it", () => {
  it('wins over the faces below it, and loses to a carry', () => {
    // Above the click reaction, because the hand that pulled the strip is the gesture in progress;
    // below the drop, because it is the other half of that same gesture. And a carry cuts it off
    // outright: the strip is being dragged and the ball is on its way out.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1')
    page.cue('dragging')
    assert.equal(page.painted(), 'drag', 'the clip covered a ball that is being carried')
  })

  it('is cut off by a carry out of the dock, which has no carry face to replace it with', () => {
    // The same interruption, from the pull the clip is actually competing with: the pointer rested on
    // the strip, the arrival played, and then the user dragged the strip instead of just touching it.
    //
    // The clip does not survive it, and that is `applyDocked(undefined)` rather than the precedence
    // below: pulling the ball out runs `unsnapDocked`, whose first act is `applyDocked` — which calls
    // `clearDockArrive`, because a clip playing *on the strip* has nothing left to be about once the
    // strip is gone. So the arrival is torn down before `syncGif` is ever asked.
    //
    // What the precedence is then asked is the interesting half: the carry that took its place wears
    // no face of its own — the ball was hidden here a moment ago and there is no pose to lift out of
    // — so the answer is *not* the hang loop the ball press would have got. It is the drop, whose
    // restart is the hand-off's own `playDropFrame()`; this harness stubs that call out, which is why
    // the resting loop is what is left to see here. `dock-tab-drag.test.ts` is where the hand-off's
    // `carriedFromDock = true` + `playDropFrame()` is pinned, against the real function.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    assert.equal(page.painted(), 'dock-arrive-1')
    page.cue('dock-drag')
    assert.notEqual(page.painted(), 'dock-arrive-1', 'the arrival clip outlived the hand that pulled the strip')
    assert.notEqual(page.painted(), 'drag', 'the dock pull came out wearing a carry face it does not have')
    assert.equal(page.painted(), 'idle', 'and with the drop stubbed out there is nothing left for it to wear')
  })

  it('and the clip has to be started to be seen at all', () => {
    // The branch is only reachable while it is up, which is what makes the precedence above it a
    // question rather than a decoration.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.leave()
    page.cue('click')
    assert.equal(page.painted(), 'click-1', 'the click reaction never got its turn')
  })
})

if (DOCK_HOVER_ENABLED) describe('the arrival never takes the ball out of its dock', () => {
  it('leaves the dock alone, on every path a hover takes', () => {
    // The semantic change this slot is: `enterUi` used to unsnap a docked ball after 800ms, and a
    // hover that pulls the ball out from under a pointer that was only passing by is worse than no
    // greeting at all. The strip's drag is the one way back, and it does not come through here.
    assert.equal(/void unsnapDocked\(\)/.test(pageFunction('enterUi')), false, 'enterUi still unsnaps on a hover')
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    page.run(() => page.clock.fireAll())
    page.run(() => page.clock.fireAll())
    page.leave()
    assert.equal(page.unsnaps(), 0, 'the clip pulled the ball back out of its dock')
    assert.equal(page.classes.has('docked'), true, 'and the page stopped wearing the docked state')
    assert.equal(page.classes.has('docked-right'), true)
  })

  it('does not wear the normal hover face while the ball is hidden behind the strip', () => {
    // `applyHover(true)` starts the hover intro, a face the *visible* ball wears on a normal hover.
    // While docked the ball is `visibility: hidden`, so a docked hover must not reach it: the intro
    // would play on a ball nobody can see and then get thrown over by the arrival clip the strip is
    // actually for. The strip's greeting is `beginDockArrive` alone.
    const page = harness({ cached: CLIP_FRAME, docked: 'right' })
    page.enter()
    assert.equal(page.hovered(), false, 'the docked hover flipped the normal hover state')
    page.leave()
    assert.equal(page.hovered(), false, 'and leaving did not leave it set')
  })

  it('is reachable at all, which the ball and the card are not while docked', () => {
    // The band is the strip's own box, because that is the only thing on screen: the ball is
    // `visibility: hidden` and drawn a whole window's width in, so `pointerOnBallOrPanel()` answers
    // no for every point of a docked window 鈥?including the ones the main process is capturing over.
    const band = pageFunction('pointerInDockBand')
    assert.match(band, /dockTab\.getBoundingClientRect\(\)/, 'the band is measured off the strip')
    assert.match(band, /DOCK_ARRIVE_MARGIN_PX/, 'and widened by the helper鈥檚 own capture margin')
    assert.equal(DOCK_ARRIVE_MARGIN_PX, CAPTURE_MARGIN,
      `the band is ${DOCK_ARRIVE_MARGIN_PX}px wider than the strip, and the helper captures ${CAPTURE_MARGIN}px more`)
    assert.match(band, /point\.clientY >= rect\.top && point\.clientY <= rect\.bottom/,
      'and not widened vertically: a clip from 8px above the bar answers a pointer nowhere near it')
  })

  it('is asked instead of the ball, by everything that can see the pointer', () => {
    // `pointerOnUi` is the one answer to "is the pointer on us": while docked the ball and the card
    // are not on screen at all, so the band is what it has to name. Docked is the early return, so
    // the free-ball test can only be reached when there is no dock to answer instead.
    const ui = pageFunction('pointerOnUi')
    assert.match(ui, /if \(docked === undefined\) return pointerOnBallOrPanel\(\)/)
    assert.match(ui, /return pointerInDockBand\(point\)/, 'and the strip is what a docked pointer is asked about')
    assert.match(shell, /if \(!pointerOnUi\(event\)\) return/, 'the enter handler asks it')
    assert.match(shell, /const on = pointerOnUi\(event\)/, 'and so does the move handler')
    assert.match(shell, /if \(pointerOnUi\(point\)\) enterUi\(\)/, 'and so does the helper鈥檚 own pointer feed')
  })

  it('answers the helper鈥檚 own pointer crossing with the clip, not with an unsnap', () => {
    // The main process sends the crossing itself, because a pointer that jumps can cross and stop
    // between two events. That path goes through the same `enterUi`, so it plays the clip too.
    assert.match(shell, /api\.onPointer\(\(point\) => \{/, 'the pointer feed is gone')
    const feed = /api\.onPointer\(\(point\) => \{[\s\S]*?\n  \}\)/.exec(shell)?.[0] ?? ''
    assert.match(feed, /enterUi\(\)/, 'the feed does not reach the clip at all')
    assert.equal(/unsnap/.test(feed), false, 'the feed still pulls the ball out of its dock')
  })
})

describe('the hover pull-out is parked', () => {
  it('does nothing on a hover, and says so in one place', () => {
    // Parked as of this change: the frame that grew out of the strip is not wanted, and a hover that does nothing
    // is the whole of "dropped for now". Both halves of the gesture read one flag, so nothing is left half-shown —
    // the peek that grows the window and the arrival clip that greets it go off together.
    assert.equal(DOCK_HOVER_ENABLED, false, 'the hover pull-out was switched back on; delete this suite and the skips above')

    // The flag is actually consulted, in both places, and consulted first: a guard after the work it guards would
    // not stop the work.
    const body = (name: string) => {
      const at = shell.indexOf(`function ${name}(`)
      assert.notEqual(at, -1, `${name} is missing from the page`)
      return shell.slice(at, shell.indexOf('\n  }', at))
    }
    const arrive = body('beginDockArrive')
    assert.match(arrive, /if \(!DOCK_HOVER_ENABLED\) return/, 'the arrival no longer checks the flag')
    const peek = body('openDockPeek')
    assert.match(peek, /if \(!DOCK_HOVER_ENABLED\) return/, 'the peek no longer checks the flag')
    assert.ok(
      peek.indexOf('DOCK_HOVER_ENABLED') < peek.indexOf('dockPeeked = true'),
      'the peek checks the flag after it has already claimed the hover',
    )

    // And what is *not* parked: the press that drags the ball out is a different gesture with its own listener,
    // and it has to keep working or the ball could never leave its strip again.
    assert.match(shell, /function handDockDragToBall\(/, 'the drag-out gesture was removed with the hover')
    assert.doesNotMatch(body('handDockDragToBall'), /DOCK_HOVER_ENABLED/, 'the drag-out was parked along with the hover')
  })
})

describe('the arrival reaches every layer the other one-shots go through', () => {
  it('is a slot of its own, named once per layer', () => {
    // Five layers, and a slot missing from any one of them fails silently: the strip simply never
    // changes face, and every test that only reads the picker still passes.
    assert.match(memes, /dockArrive\(\): Promise<DockArriveEdges \| null>/, 'the picker answers for it')
    assert.match(memes, /async dockArrive\(\)/, 'and reads the slot')
    assert.match(memes, /readDockArrive\(record\.dockArrive\)/, 'from its own key in the config')
    assert.match(memes, /DOCK_ARRIVE_DEFAULTS/, 'with the loop-less default when the profile names none')
    assert.match(main, /ipcMain\.handle\('orb:meme-dock-arrive'/, 'the helper answers the channel')
    assert.match(preload, /memeDockArrive\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-dock-arrive'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeDockArrive\(\)/, 'and the page asks for the frame')
    assert.match(pageFunction('syncGif'), /if \(dockArriveShown !== undefined\)/, 'the pose is reachable from syncGif')
    assert.match(pageFunction('playDockArrive'), /dockArriveStep \+= 1/, 'a new step is what replays the clip')
    assert.match(pageFunction('refreshFrames'), /fetchDockArrive\(\)/, 'and it is prefetched with the other named frames')
    // The per-edge half, which is the same kind of silent-miss wiring: a `left` the picker reads but the
    // page never asks about is a left edge playing the right edge's picture, and vice versa.
    assert.match(memes, /const left = text\('left'\)/, 'the config reader drops the left clip')
    assert.match(memes, /const leftLoop = text\('leftLoop'\)/, 'and its loop')
    assert.match(memes, /timedFrame\(current\.dockArrive\.left, current\.dirs\)/, 'the left clip is never resolved')
    assert.match(pageFunction('fetchDockArrive'), /'right' in frames \|\| 'left' in frames/, 'the page does not read the per-edge answer')
    assert.match(pageFunction('playDockArrive'), /dockArriveFor\(docked\)/, 'and does not pick the edge it is standing on')
    assert.match(pageFunction('dockArriveFor'), /side === 'left' \? dockArriveFrame\.left : dockArriveFrame\.right/,
      'the edge the ball is docked to does not choose the clip')
  })

  it('does not touch the arrival slot it sits beside', () => {
    // `arrive` is the greeting the ball turns up with as the page opens; this is a hand coming to
    // rest on the strip. One slot, one event 鈥?a pack that draws both names both.
    const slot = /async arrive\(\) \{[\s\S]*?\n    \},/.exec(memes)?.[0] ?? ''
    assert.notEqual(slot, '', 'the arrival slot is gone')
    assert.equal(/dockArrive/.test(slot), false, 'the greeting now reads the docked slot')
  })
})

describe('the hover shows the ball before it plays the clip', () => {
  it('asks for the peek, and puts the ball back when the pointer leaves', () => {
    // The ball is shown by the helper growing the window, and the page's half of that is one class.
    // Both ends are pinned because either alone is a hover that does nothing visible: the class with
    // no window is a ball drawn `--ball-column` into a 34px rect, and the window with no class is a
    // ball that `body.docked` still says is hidden.
    assert.match(pageFunction('beginDockArrive'), /void openDockPeek\(\)/,
      'the hover never brings the ball out')
    assert.match(pageFunction('leaveUi'), /void closeDockPeek\(\)/,
      'the ball is left standing on a strip the pointer has abandoned')
    assert.match(pageFunction('openDockPeek'), /api\.peekDock\(\)/, 'the page never asks the helper to grow the window')
    assert.match(pageFunction('openDockPeek'), /classList\.add\('docked-peek'\)/, 'and never shows the ball when it has')
    assert.match(pageFunction('closeDockPeek'), /api\.unpeekDock\(\)/, 'the window is never given back')
    assert.match(pageFunction('closeDockPeek'), /classList\.remove\('docked-peek'\)/)
  })

  it('shows the ball only once the window it is drawn in has grown', () => {
    // The one ordering in the peek that matters. The ball is drawn at `--ball-column` inside the
    // window, so a class put on first paints a slice of ball clipped by the edge of a 34px strip for
    // as long as the round trip takes.
    const open = pageFunction('openDockPeek')
    assert.ok(open.indexOf('await api.peekDock()') < open.indexOf("classList.add('docked-peek')"),
      'the ball is shown before the window it is drawn in has grown')
    // The pointer is re-checked after that await, because the round trip is long enough for it to
    // have left the strip or for the pull out of the dock to have started.
    assert.match(open, /if \(!dockPeeked \|\| docked !== side\) return/, 'the peek lands over a hover that has gone')
  })

  it('leaves the strip exactly as it was against a helper that has no peek', () => {
    // The channel is the whole mechanism: with nowhere to show the ball, playing the clip on an
    // element that is off the screen is exactly the state this exists to end. So a missing channel
    // is answered, not walked into.
    assert.match(pageFunction('openDockPeek'), /typeof api\.peekDock !== 'function'\) return/)
    assert.match(pageFunction('closeDockPeek'), /typeof api\.unpeekDock !== 'function'\) return/)
  })

  it('counts the showing ball as something the pointer is on', () => {
    // Otherwise the peek dismisses itself the moment the hand moves from the strip toward the ball it
    // has just revealed: `docked` is still set, so the strip branch of the ordinary test answers "no"
    // for it, and the ball drops back behind the edge out from under the hand.
    const ui = pageFunction('pointerOnUi')
    assert.match(ui, /if \(dockPeeked && point !== undefined\)/,
      'and the ball the peek has just put on screen is a place the pointer can be')
    assert.match(ui, /ball\.getBoundingClientRect\(\)/, 'tested against where it actually is drawn')
  })

  it('lets the peeking ball be left with slack, so a resting hand cannot flicker it away', () => {
    // The ball is flush with the screen's inner edge, so its own boundary is the last pixel column a
    // hand can be on — and leaving is what dismisses the peek. Without a margin wider than the ball,
    // one pixel of tremor flips the answer and the strip flickers under a hand that never left it.
    // The two directions are therefore given different bars: the exit test is the ball's rect grown by
    // DOCK_PEEK_RELEASE_PX, while entering still goes through the strip's own band.
    const ui = pageFunction('pointerOnUi')
    assert.match(ui, /const slack = DOCK_PEEK_RELEASE_PX/,
      'the exit test reads its margin by name, so the constant is what is being asserted')
    assert.match(ui, /rect\.left - slack && point\.clientX <= rect\.right \+ slack/,
      'and the ball is tested with room to spare on both sides')
    assert.match(ui, /rect\.top - slack && point\.clientY <= rect\.bottom \+ slack/,
      'vertically too: a hand resting above the ball should not dismiss it either')
    assert.match(ui, /return pointerInDockBand\(point\)/,
      'but the strip is untouched, so a peek still takes a hand to raise it rather than merely to keep it')
    assert.equal(/inside\(ball\.getBoundingClientRect\(\), point\)/.test(ui), false,
      'the bare rect is gone: it is what had no tolerance')
  })

  it('answers the same question differently just outside the ball than just inside it', () => {
    // The source assertions above pin the *shape*; this one runs the function. The question is
    // whether a hand a few pixels off a showing ball still counts, because that band is the whole
    // difference between a strip that flickers and one that does not.
    //
    // The ball is laid out where `peekBallOrigin` puts it — flush with the inner screen edge — so
    // the strip and the ball sit next to each other with nothing between, and the pointer is asked
    // about both in the same breath.
    const BALL = { left: 1904, top: 480, right: 2192, bottom: 768 }
    const STRIP = { left: 2014, top: 480, right: 2048, bottom: 768 }
    const probe = new Function('deps', `
      const { ball, dockTab, DOCK_ARRIVE_MARGIN_PX, DOCK_PEEK_RELEASE_PX } = deps
      let docked = 'right'
      let dockPeeked = false
      function inside(rect, at) {
        return rect.width > 0 && rect.height > 0
          && at.clientX >= rect.left && at.clientX <= rect.right
          && at.clientY >= rect.top && at.clientY <= rect.bottom
      }
      function pointerOnBallOrPanel() { return false }
      ${pageFunction('pointerInDockBand')}
      ${pageFunction('pointerOnUi')}
      return { at: (x) => pointerOnUi({ clientX: x, clientY: 624 }), peek: () => { dockPeeked = true } }
    `)({
      ball: { getBoundingClientRect: () => ({ ...BALL, width: BALL.right - BALL.left, height: BALL.bottom - BALL.top }) },
      dockTab: { hidden: false, offsetParent: {}, getBoundingClientRect: () => STRIP },
      DOCK_ARRIVE_MARGIN_PX,
      DOCK_PEEK_RELEASE_PX,
    })

    const at = (x: number) => probe.at(x)
    // Hidden ball: only the strip counts, and its own margin — the peek has not been raised, so
    // there is nothing on the screen but a 34px line to aim at.
    assert.equal(at(2030), true, 'the middle of the strip is the strip')
    assert.equal(at(2010), true, `the strip counts out to ${DOCK_ARRIVE_MARGIN_PX}px past its own edge`)
    assert.equal(at(1980), false, 'but not anywhere near the ball while it is still hidden')

    probe.peek()
    const edge = BALL.left
    // On the ball, and just off it: both still on us. This is the band that used to be 1px wide.
    assert.equal(at(edge + 100), true, 'the middle of a showing ball is on the ball')
    assert.equal(at(edge - 1), true, 'one pixel inside the edge is still the ball')
    assert.equal(at(edge - 1), true, 'and the answer is the same one pixel, not a stateful one')
    assert.equal(at(edge - (DOCK_PEEK_RELEASE_PX - 1)), true,
      `a hand ${DOCK_PEEK_RELEASE_PX - 1}px off the ball still counts — the release bar`)
    assert.equal(at(edge - (DOCK_PEEK_RELEASE_PX - 1)), true, 'and it is stable there, not a single read')
    // Past the bar: gone, and gone deliberately rather than by a rounding accident.
    assert.equal(at(edge - DOCK_PEEK_RELEASE_PX), true,
      `the release bar is inclusive: ${DOCK_PEEK_RELEASE_PX}px off is the last pixel that keeps it`)
    assert.equal(at(edge - (DOCK_PEEK_RELEASE_PX + 1)), false,
      `and ${DOCK_PEEK_RELEASE_PX + 1}px off is a real departure, so a hand that means to leave still can`)
    assert.equal(at(3000), false, 'the far side of the ball is a departure too')
    // The vertical slack, which the report was not about but the same tremor applies to.
    assert.equal(at(edge + 100), true, 'sanity: the same point reads the same twice')
    assert.ok(DOCK_PEEK_RELEASE_PX > DOCK_ARRIVE_MARGIN_PX,
      `the release bar (${DOCK_PEEK_RELEASE_PX}) is wider than the strip margin (${DOCK_ARRIVE_MARGIN_PX}), which is what makes the two directions differ`)
  })

  it('drops the peek with the dock, without asking the helper to put the window back', () => {
    // Pulling the ball out reaches `applyDocked(undefined)` *before* the helper is asked to slide it,
    // and the helper has to still believe the ball is standing at the edge for that slide to start
    // where the peek left it. So the page's half is dropped here and `unpeekDock` is deliberately not
    // called — a call to `closeDockPeek` would re-park the ball off the screen mid-hand-off.
    const apply = pageFunction('applyDocked')
    assert.match(apply, /dockPeeked = false/, 'a stale peek outlives the dock it belonged to')
    assert.match(apply, /classList\.remove\('docked-peek'\)/, 'and the ball is left on screen for it')
    assert.equal(/unpeekDock/.test(apply), false, 'the pull re-parks the ball before the helper has slid it')
  })

  it('is one body class, pinned in the stylesheet to the display edge', () => {
    // Peeked, the window is the overlay rect, so a strip positioned against *its* edge leaves the
    // display — and the strip is the hand the peek is for. Which edge the display is can be read off
    // the ball and only off the ball: it is `--ball-column` plus half a ball into the window.
    assert.match(css, /body\.docked\.docked-peek #ball \{\s*\n\s*visibility: visible;/,
      'the ball is never shown, so nothing is on screen to greet the pointer')
    assert.match(css, /body\.docked\.docked-peek #dock-tab \{\s*\n\s*top: var\(--ball-row\);/,
      'the strip leaves its row')
    assert.match(css, /body\.docked\.docked-peek\.docked-right #dock-tab \{[\s\S]*?left: calc\(var\(--ball-column\) \+ var\(--ball\) \/ 2 - 34px\);/,
      'and leaves the right edge, which is the one the hand is on')
    assert.match(css, /body\.docked\.docked-peek\.docked-left #dock-tab \{[\s\S]*?left: calc\(var\(--ball-column\) \+ var\(--ball\) \/ 2\);/,
      'and the left one')
    // The ball is *shown*, not handed over: the docked `pointer-events: none` is left standing, so
    // the strip is still the only way out of the dock.
    const peek = /body\.docked\.docked-peek #ball \{[\s\S]*?\}/.exec(css)?.[0] ?? ''
    assert.notEqual(peek, '', 'the peek rule is missing')
    assert.equal(/pointer-events/.test(peek), false, 'the peek made the ball the user\'s to click')
  })

  it('is wired through every layer the arrival is', () => {
    assert.match(preload, /peekDock\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:dock-peek'\)/,
      'the preload does not expose the peek')
    assert.match(preload, /unpeekDock\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:dock-unpeek'\)/)
    assert.match(main, /ipcMain\.handle\('orb:dock-peek'/, 'the helper does not answer it')
    assert.match(main, /ipcMain\.handle\('orb:dock-unpeek'/)
    // Its own channels rather than `orb:unsnap-smooth`'s: a peek keeps the dock, and the pull out of
    // it gives the dock up. One channel for both would be a hover that unsnaps the ball.
    assert.match(main, /placement\.peek\(\)/, 'the helper has no peek to run')
    assert.match(main, /placement\.unpeek\(\)/)
  })
})
