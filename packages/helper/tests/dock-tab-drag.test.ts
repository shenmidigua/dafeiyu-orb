/**
 * Pulling the ball back out of its docked tab.
 *
 * Docking hides the ball and leaves a 6px bar flush with a screen edge, so that bar is the only way
 * back in — and bringing the ball out is one gesture split across three things that have to agree:
 * the bar's own layout (`floating.css`), the strip `geometry.ts` sizes the window to, and the rect
 * the page reports to the helper, which is what decides whether the window captures the mouse at
 * all (`syncHitTest` in `shell.js`, polled by `overCapturedRegion` in `main.ts`).
 *
 * A click-through window delivers nothing to the renderer — measured, see `setHitTest` in
 * `main.ts` — so a rect the page forgets to report is a gesture the page never hears about. The
 * ball's own press reports its rects for exactly that reason; these are the same tests for the tab,
 * and they are what the tab's drag is missing.
 *
 * The invariants are read out of the three sources rather than restated, so a change to any one of
 * them is a change to what these assert.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
const geometry = readFileSync(join(here, '../src/geometry.ts'), 'utf8')

/** A `const NAME = 12` in the source, as a number. */
function number(source: string, name: string): number {
  const found = new RegExp(`const ${name} = ([0-9]+)\\b`).exec(source)
  assert.notEqual(found, null, `${name} is missing`)
  return Number(found[1])
}

/** The body of a `x.addEventListener('event', (event) => { … })` registration, by brace matching. */
function listener(source: string, target: string, event: string): string {
  // Anchored on the closing quote as well: `'pointerdown'` is a prefix of nothing here, but
  // `'pointermove'` is a prefix of `'pointermove-something'` in principle, and the wrong one would
  // quietly hand back the listener next door.
  const found = new RegExp(`${target}\\.addEventListener\\('${event}'[,)]`).exec(source)
  assert.notEqual(found, null, `${target} has no ${event} listener`)
  const head = found.index
  const open = source.indexOf('{', source.indexOf('=>', head))
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(head, i + 1)
    }
  }
  throw new Error(`${target}'s ${event} listener never closes`)
}

const BALL_SIZE = number(geometry, 'BALL_SIZE')
const DOCK_TAB_WIDTH = number(geometry, 'DOCK_TAB_WIDTH')
const DOCK_GLOW = number(geometry, 'DOCK_GLOW')
const DOCK_HOVER_MARGIN = number(geometry, 'DOCK_HOVER_MARGIN')
const DOCK_IN_PAD = number(geometry, 'DOCK_IN_PAD')
const DOCK_OVERLAP = Math.round(BALL_SIZE / 3)
const DOCK_HIT_WIDTH = DOCK_TAB_WIDTH + DOCK_GLOW + DOCK_HOVER_MARGIN
const CAPTURE_MARGIN = number(main, 'CAPTURE_MARGIN')
const DOCK_DRAG_OFF_PX = number(shell, 'DOCK_DRAG_OFF_PX')
const DOCK_HOVER_DELAY_MS = number(shell, 'DOCK_HOVER_DELAY_MS')
const DOCK_TAB_INSET = number(shell, 'DOCK_TAB_INSET')
/**
 * The page's own copy of the module's `DOCK_IN_PAD`, checked against it below.
 *
 * The hand-off needs a distance from the display edge, and the bar's box only says where the edge
 * *is* — nothing on screen is drawn at the ball's slot while the ball is hidden. So the page carries
 * a second copy of a number the helper owns, which is the kind that drifts silently: it would keep
 * working, and every pull out of the dock would start the ball a few pixels from where the helper
 * has it parked.
 */
const SHELL_DOCK_IN_PAD = number(shell, 'DOCK_IN_PAD')
const POLL_MS = Number(/setInterval\(\(\) => \{[\s\S]*?\}, (\d+)\)/.exec(main)?.[1])

/** A named `function name(...) { … }` cut out by brace matching. */
function pageFunction(name: string): string {
  // Anchored so a name is never matched inside a longer one. `function actually` contains
  // `function act`, and the suffix would be whatever the comment above it said.
  const found = new RegExp(`(?:^|[^\\w$])function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = (found as RegExpExecArray).index + (found as RegExpExecArray)[0].length - `function ${name}(`.length
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

/** The laid-out box of the docked strip, as `getBoundingClientRect` reports one. */
interface Bar {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * Run the page's own `handDockDragToBall`, with the bar the geometry would have put on screen.
 *
 * `clientX`/`clientY` and `screenX`/`screenY` differ by the window's own origin, and the hand-off
 * has to convert between the two: the bar is measured in the page's viewport while the ball is moved
 * in screen coordinates. Handing both to the page, on a window that is not at the display's origin,
 * is what makes a conversion that dropped one of them fail here rather than on a desktop.
 */
function handOff(input: {
  side: string
  bar: Bar
  /** The window's own top-left on the display, which is what the two spaces differ by. */
  window: { x: number; y: number }
  /** Where the pointer was *before* the move that crossed the threshold, if not the same place. */
  was?: { x: number; y: number }
}, pointer: { x: number; y: number }) {
  const was = input.was ?? pointer
  const factory = new Function('deps', `
    const { dockTab, ball, side, DOCK_IN_PAD, DOCK_TAB_INSET } = deps
    let docked = side
    let lastOrigin
    let lastScreenX = deps.wasScreenX
    let lastScreenY = deps.wasScreenY
    let lastClientX = deps.wasClientX
    let lastClientY = deps.wasClientY
    let pointer = { dx: 0, dy: 0, startX: deps.startX, startY: deps.startY }
    let dockPointerInside = true
    let dragging = false
    let carriedFromDock = false
    let undocking = false
    let unsnaps = 0
    let smoothUnsnaps = 0
    let drops = 0
    /**
     * Whether the page had already set dragging when the undock was asked for.
     *
     * This is the one thing about the ordering inside the hand-off that is not cosmetic: the page's
     * real unsnapDocked sets skipDockCommit only when a drag is in progress, and that flag is what
     * keeps the release from putting the ball under the cursor. So the stub reads the live variable at
     * the moment it is called, which is how a reorder that broke it would show up here as false.
     */
    let draggingAtUnsnap = null
    const unsnapDocked = async () => { unsnaps += 1 }
    const unsnapDockedSmooth = async () => { smoothUnsnaps += 1; draggingAtUnsnap = dragging }
    const startDragIntro = () => {}
    const playDropFrame = () => { drops += 1 }
    const syncGif = () => {}
    ${pageFunction('handDockDragToBall')}
    handDockDragToBall(deps.was)
    return {
      origin: lastOrigin,
      pointer,
      dragging,
      carriedFromDock,
      undocking,
      drops,
      unsnapped: unsnaps,
      smoothUnsnapped: smoothUnsnaps,
      draggingAtUnsnap,
      docked,
      screenX: deps.was.screenX,
      screenY: deps.was.screenY,
      nowScreenX: lastScreenX,
    }
  `)
  return factory({
    dockTab: { getBoundingClientRect: () => input.bar },
    // The page reads the ball's own box for its width, which the right-hand dock needs: the ball is
    // placed by its *left* edge, so setting it in from a bar on the right means taking the whole ball
    // off. Read from the element rather than restated in the page, exactly as the bar is.
    ball: { getBoundingClientRect: () => ({ width: BALL_SIZE }) },
    side: input.side,
    DOCK_IN_PAD,
    DOCK_TAB_INSET,
    startX: pointer.x + input.window.x,
    startY: pointer.y + input.window.y,
    wasScreenX: was.x + input.window.x,
    wasScreenY: was.y + input.window.y,
    wasClientX: was.x,
    wasClientY: was.y,
    was: {
      screenX: was.x + input.window.x,
      screenY: was.y + input.window.y,
      clientX: was.x,
      clientY: was.y,
    },
  }) as {
    origin: { x: number; y: number }
    pointer: { dx: number; dy: number; startX: number; startY: number }
    dragging: boolean
    carriedFromDock: boolean
    undocking: boolean
    drops: number
    draggingAtUnsnap: boolean | null
    unsnapped: number
    smoothUnsnapped: number
    docked: string | undefined
    screenX: number
    screenY: number
    nowScreenX: number
  }
}

/** The tab's laid-out width, which is the rect the page reports and therefore the strip that captures. */
const TAB_WIDTH_PX = Number(/\bwidth:\s*([0-9.]+)px/.exec(/#dock-tab \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '')?.[1])

describe('the docked tab is the only way back in', () => {
  it('gives the tab a press of its own, so a hover is not a precondition', () => {
    // `DOCK_HOVER_DELAY_MS` looks like the way out, but it hangs off `enterUi()`, and that used to
    // be gated on the pointer being on the *ball* or the *panel* — while docked the ball is drawn at
    // `--ball-column` inside a 34px window, so the pointer can never be on it. What the hover does
    // now is play the arrival clip (see `dock-arrive.test.ts`); the press is the route that actually
    // exists, and it is the only one.
    assert.match(shell, /dockTab\.addEventListener\('pointerdown'/, 'the tab is pressable in its own right')
    assert.equal(DOCK_HOVER_DELAY_MS, 800, 'and the hover timer is the 800ms one, not a second route')
    assert.match(css, /body\.docked #ball,[\s\S]*?pointer-events: none/, 'with the ball untouchable while docked')
  })

  it('keeps the strip the geometry module sizes the window to', () => {
    assert.match(geometry, /DOCK_HIT_WIDTH = DOCK_TAB_WIDTH \+ DOCK_GLOW \+ DOCK_HOVER_MARGIN/, 'the strip is the sum of its parts')
    assert.equal(DOCK_HIT_WIDTH, 34, 'so DOCK_HIT_WIDTH is 34px')
    // The bar used to be laid out at the 6px it is drawn as, and `syncHitTest` reports
    // `element.getBoundingClientRect()` — the element's *box*, not its picture. So the region the
    // helper polled against was 6px wide while the geometry it was sizing the window from said 34,
    // and the 28px of strip between the bar and the window's inward edge captured nothing: a press
    // there landed on `body`, which has no listener. The bar's box is now the strip, and the 6px
    // picture is drawn inside it by `::after`, flush with the screen edge.
    assert.equal(TAB_WIDTH_PX, DOCK_HIT_WIDTH, `the tab reports ${TAB_WIDTH_PX}px where the geometry calls ${DOCK_HIT_WIDTH}px hittable`)
    assert.match(css, /#dock-tab::after \{[\s\S]*?\bwidth:\s*6px/, 'and the bar it draws is still the 6px it always was')
  })

  it('draws the 6px bar against the edge the strip is flush with', () => {
    // The box grew inward, so the picture has to be pinned to the outward side of it or the bar
    // would drift 28px clear of the screen edge it is supposed to be docked to. `overflow: hidden`
    // is what keeps the glow — a 6px spread, wider than the bar — from drawing outside the box and
    // over desktop the window is not capturing.
    assert.match(css, /body\.docked-left #dock-tab::after \{\s*\n\s*left: 0;/, 'the left bar is drawn at the left edge')
    assert.match(css, /body\.docked-right #dock-tab::after \{\s*\n\s*right: 0;/, 'and the right bar at the right edge')
    assert.match(css, /#dock-tab \{[\s\S]*?overflow: hidden/, 'the box clips what it does not capture over')
  })
})

describe('a pull on the tab', () => {
  it('widens the capture regions, the way the ball already does', () => {
    // The ball's press reports its rects before the pointer can outrun them — `syncHitTest` is what
    // keeps the window from going click-through under a drag in progress. The tab's press did not,
    // so the window went click-through as soon as the pointer left the bar, and after that the page
    // heard no more moves at all.
    assert.match(listener(shell, 'ball', 'pointerdown'), /syncHitTest\(\)/, 'the ball reports on its press')
    assert.match(listener(shell, 'dockTab', 'pointerdown'), /syncHitTest\(\)/, 'and so must the tab')
  })

  it('can reach its own threshold inside the strip that is still capturing', () => {
    // The pull-off distance is measured from where the press landed. Every move after the pointer
    // leaves the capturing strip is a move the page never receives, so the threshold has to be
    // crossable inside it — otherwise the drag only ever starts when one coalesced move happens to
    // jump the whole 24px before the helper's poll (below) turns the window click-through.
    const reachable = TAB_WIDTH_PX + CAPTURE_MARGIN
    assert.equal(POLL_MS, 33, 'the poll that decides it runs every 33ms')
    assert.ok(
      DOCK_DRAG_OFF_PX <= reachable,
      `a ${DOCK_DRAG_OFF_PX}px pull cannot be measured inside the ${reachable}px that stays captured`,
    )
  })

  it('keeps following the hand after the hand-off has cleared the dock', () => {
    // The hand-off calls `unsnapDocked()`, which runs `applyDocked(undefined)` — so from the move
    // *after* the threshold there is no `docked` left. The tab's move listener opened with
    // `if (pointer === undefined || docked === undefined) return`, which meant the gesture was
    // accepted exactly once: the ball was put down on the ball's centre at the hand-off and then
    // never moved again, while the hand carried on to the far side of the screen. This is not a
    // theory — a live pull on the real ball left it frozen at the hand-off point through three
    // successive carries of 150px each.
    //
    // The guard has to admit a ball that is already in the hand. `dragging` is that state, and it is
    // set by the hand-off itself, so the pair `docked !== undefined || dragging` is what a live
    // gesture is — and nothing else in this listener may read the cleared `docked`.
    const move = listener(shell, 'dockTab', 'pointermove')
    assert.match(
      move,
      /pointer === undefined \|\| \(docked === undefined && !dragging\)\) return/,
      'the guard must still accept the moves that arrive after the ball is out of the dock',
    )
    // The direction of the pull is measured against the edge the gesture started on. It cannot be
    // read off `docked` either — gone by the second move — so it is latched on the press and held.
    assert.match(move, /dockSide === 'right'/, 'the direction comes from the latched side')
    assert.doesNotMatch(move, /docked === 'right'/, 'not from the state the hand-off clears')
    const down = listener(shell, 'dockTab', 'pointerdown')
    assert.match(down, /dockSide = docked/, 'and the latch is taken where the dock is still known')
    // And once the ball is out, the threshold cannot be re-crossed: `inward` is zero for the rest of
    // the gesture, so the hand-off runs once rather than on every move.
    assert.match(move, /const inward = dragging\s*\n?\s*\? 0/, 'the pull is measured only until it is recognised')
  })

  it('comes out of the dock dropping, with neither pickup nor hang in front of it', () => {
    // The two drags look alike and are not. A press on the *ball* closes a hand on something the
    // user could see, so the pickup (`dragIntroSrc`, 拎起) plays and the ball rises out of its own
    // resting pose into the carry, where it then hangs (`dragSrc`, 悬空) for as long as it is held.
    //
    // A pull out of the *dock* has neither. Nothing is being held — the ball was hidden behind the
    // strip a moment ago and what this gesture does is bring it back on screen — so a lift reads as
    // the ball being picked up off a floor it was never standing on, and a hang loop reads as
    // something hanging from a hand that never took hold of it. What actually happened is that the
    // ball came off the edge, and the clip for that is the drop (`dropFrame`, 下落).
    //
    // So the pull-out plays the drop immediately, and the release plays it again: coming out of the
    // strip is the fall from the strip, letting go is the fall to wherever it lands, and both are the
    // ball dropping. `playDropFrame` restarts its own one-shot on every call, so the second pass is
    // fresh rather than the tail of the first.
    //
    // The mechanism is a flag rather than a change to `dragging`, because `dragging` is load-bearing
    // well past the picture — the hit-test region, the suppressed hover and the docking all read it.
    // `carriedFromDock` only tells `syncGif` to skip the carry face; everything else about the
    // gesture is untouched.
    const hand = pageFunction('handDockDragToBall')
    assert.doesNotMatch(hand, /startDragIntro\(\)/, 'a pull out of the dock must not play the pickup')
    assert.match(hand, /carriedFromDock = true/, 'the carry is marked as one with no face of its own')
    assert.match(hand, /playDropFrame\(\)/, 'and the drop is what it plays instead')
    assert.match(hand, /syncGif\(\)/, 'it still reports the face change, which is what shows the ball')
    assert.match(hand, /dragging = true/, 'and the carry is what it hands over to')
    // The flag is what `syncGif` actually reads, so the test above is only half of it: the carry
    // branch has to be the one that honours it, or setting it would change nothing.
    assert.match(pageFunction('syncGif'), /dragging && dragSrc !== undefined && !carriedFromDock/,
      'and `syncGif` is where the faceless carry is honoured')
    // The ball's own press keeps the pickup, and the hang loop with it. Without this the test above
    // would pass just as well against a page that had lost the lift everywhere.
    const ballMove = listener(shell, 'ball', 'pointermove')
    assert.match(ballMove, /startDragIntro\(\)/, 'picking the ball itself up still plays the lift')
    assert.doesNotMatch(pageFunction('ballGrabOffset') + ballMove, /carriedFromDock = true/,
      'and a ball press is never marked as a faceless carry')
  })

  it('undocks instead of carrying: the ball travels in and the hand never takes it', () => {
    // The feel, and the one thing about it that is a decision rather than a mechanism. A pull out of
    // the dock used to hand the ball to the pointer, so it came to rest under the cursor and followed
    // the hand from there. What it does instead is undock: the helper slides the ball back on screen
    // over `DOCK_SLIDE_OUT_MS`, the drop plays across that whole travel, and the pointer is left with
    // the two jobs it actually has — recognising the pull and ending it.
    //
    // It is a guard in the move handler rather than a change to the hand-off, because the travel has
    // to keep being the helper's: a `moveBall` at any point of the slide overwrites `this.origin` and
    // bumps the animation generation, which places the ball at the pointer and cuts the slide off at
    // whatever frame it had reached. So the moves are ignored for the whole gesture, not just for the
    // slide — the pointer is still down and still moving when the slide ends, and a ball that
    // travelled and then snapped onto the cursor would read as two gestures rather than one.
    const move = listener(shell, 'dockTab', 'pointermove')
    const guarded = /if \(undocking\) return([\s\S]*?)void moveBall\(/.exec(move)
    assert.notEqual(guarded, null, 'the pull-out is not guarded against the hand carrying the ball')

    // And the guard has to be *above* the move it stops, not after it — the check above would pass on
    // a page that moved the ball first and then remembered not to.
    assert.ok(
      move.indexOf('if (undocking) return') < move.lastIndexOf('void moveBall('),
      'the guard was placed after the move it is supposed to prevent',
    )

    // The other half is that the flag is actually set, and cleared, by the two ends of the gesture.
    assert.match(pageFunction('handDockDragToBall'), /undocking = true/,
      'the pull-out does not mark itself as an undock')
    assert.match(listener(shell, 'dockTab', 'pointerdown'), /undocking = false/,
      'a fresh press on the strip inherits the last gesture\u2019s undock')
    assert.match(listener(shell, 'ball', 'pointerdown'), /undocking = false/,
      'and so does a press on the ball, which is the drag that *is* a carry')

    // Behaviourally, against the page's own hand-off: the flag is set, and it is set alongside the
    // face rather than instead of it.
    const one = handOff(
      { side: 'left', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 0, y: 96 } },
      { x: 12, y: 54 },
    )
    assert.equal(one.undocking, true, 'the hand-off did not mark the pull as an undock')
    assert.equal(one.carriedFromDock, true, 'nor as the faceless carry it also is')
    assert.equal(one.dragging, true, 'the gesture is still the ball\u2019s own drag state')
  })

  it('starts the undock with a drag already in progress, so the release lets the ball be', () => {
    // The ordering inside the hand-off, which is not cosmetic. The page's own `unsnapDocked` sets
    // `skipDockCommit` only when `dragging` is already true, and that flag is what stops the release
    // from moving the ball — a release without it puts the ball under the cursor, which is the follow
    // coming back in through the door marked "pointerup" instead of through a move.
    //
    // Asserted by reading the live value at the moment the undock is asked for, rather than by
    // comparing two `indexOf` results: what matters is what the page *saw*, not which line came first.
    const one = handOff(
      { side: 'left', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 0, y: 96 } },
      { x: 12, y: 54 },
    )
    assert.equal(one.smoothUnsnapped, 1, 'the undock was not asked for')
    assert.equal(
      one.draggingAtUnsnap,
      true,
      'the undock ran before `dragging` was set, so the release would put the ball under the cursor',
    )
    // The face is played after the undock, which is only about which of the two the frame shows first.
    assert.equal(one.drops, 1, 'the drop was not played on the way out')
  })

  it('hands the gesture to the ball instead of ending it', () => {
    // `unsnapDocked()` clears `docked`, and the tab's move handler used to return the moment it did —
    // so the ball slid back to `DOCK_IN_PAD` from the edge and stopped there, wherever the pointer
    // was and however fast it was still moving. The threshold crossing is where the gesture changes
    // hands: capture stays on the tab (it is the element the press started on, so it is the element
    // that keeps receiving the moves) and `dragging` becomes the ball's own flag, which is what
    // `syncGif` and `moveBall` below read.
    const move = listener(shell, 'dockTab', 'pointermove')
    assert.match(move, /moveBall\(/, 'the pull carries the ball')
    assert.match(move, /handDockDragToBall\(/, 'and the ball\u2019s own drag state takes the gesture over')
    const hand = pageFunction('handDockDragToBall')
    assert.match(hand, /void unsnapDockedSmooth\(\)/,
      'the dock is released on the way out, and smoothly: the ball has to be seen travelling out of the edge')
    assert.doesNotMatch(hand, /\bunsnapDocked\(\)/,
      'and not with the one-frame variant, which is for the callers that are finishing a gesture')
    assert.match(hand, /dragging = true/, 'the ball is carried from here, not dropped at the edge')
  })

  it('leaves the ball to the slide on the move that crossed the threshold', () => {
    // The slide out is the main process's — `unsnapDockedSmooth` starts it — and it is cancelled by
    // any newer `moveBall`, which overwrites `origin` and bumps the animation generation before the
    // slide has drawn a frame. The tab's move handler used to apply the crossing move straight after
    // the hand-off (`void moveBall(event.screenX - pointer.dx, ...)`, kept for a coalesced 24px
    // jump), and that one call is enough to turn the whole slide into the teleport it was added to
    // remove: the ball would be put on the pointer and never seen coming out of the edge.
    //
    // Nothing is lost by not applying it. A hand that is still moving sends its next move within a
    // few milliseconds and that move takes over mid-slide; a hand that has stopped is served by the
    // slide itself, which is aimed at the same slot.
    const move = listener(shell, 'dockTab', 'pointermove')
    const handOffBlock = /if \(inward > DOCK_DRAG_OFF_PX && !dragging\) \{([\s\S]*?)\n    \}/.exec(move)
    assert.notEqual(handOffBlock, null, 'the hand-off block is gone from the tab\u2019s move handler')
    const body = handOffBlock[1]
    assert.match(body, /handDockDragToBall\(/, 'the hand-off no longer runs')
    assert.doesNotMatch(body, /moveBall\(/,
      'the crossing move is applied here, which cancels the slide out before it can be seen')
    // And the move *after* it is still applied, or the ball would never follow the hand at all.
    assert.match(move, /if \(!dragging \|\| collapsing\) return\n([\s\S]*?)void moveBall\(/,
      'nothing moves the ball once the carry is under way')
  })

  it('takes hold of the ball by its centre, so the ball follows the hand', () => {
    // The feel this hand-off has, and the reason `dx`/`dy` are the ball's half-width rather than the
    // distance to its corner. Every later move computes `screen - dx`, so a `dx` of `half` is a ball
    // *centred* on the pointer and a `dx` of `screen - left` is a ball whose corner trails the hand by
    // whatever the press happened to land on. The strip is 34px against the edge while the ball is a
    // ball's width wide, so those two readings are 144px apart — the difference between the ball
    // tracking the cursor and the whole ball sliding out from under the edge.
    //
    // What must *not* change is where the ball is put: the helper's slot, or a release re-docks it.
    // Both are asserted here because they are the pair that a careless edit collapses into one.
    const one = handOff(
      { side: 'left', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 0, y: 96 } },
      { x: 12, y: 54 },
    )
    assert.equal(one.pointer.dx, BALL_SIZE / 2, 'the grab is the pointer-to-centre offset')
    assert.equal(one.pointer.dy, BALL_SIZE / 2, 'in both axes')
    assert.equal(one.origin.x, DOCK_IN_PAD, 'and the ball is still put on the helper\u2019s docked slot')
    // The consequence, stated the way the move handler uses it: a move of the pointer carries the
    // ball's centre by the same amount, so the ball tracks the hand rather than trailing it.
    const at = { x: 700, y: 400 }
    assert.deepEqual(
      { x: at.x - one.pointer.dx + BALL_SIZE / 2, y: at.y - one.pointer.dy + BALL_SIZE / 2 },
      at,
      'the ball\u2019s centre did not land on the pointer',
    )
  })

  it('holds the page\u2019s copy of the parking pad to the helper\u2019s own', () => {
    // `DOCK_IN_PAD` is one of only two numbers the page restates from `geometry.ts` — `DOCK_TAB_INSET`
    // is the other — and it is the one whose drift is invisible: the ball's slot is not drawn while
    // it is docked, so a copy that fell a few pixels out of step would only show as a pull that
    // starts with a small jump. Read both sides rather than restating either.
    assert.equal(
      SHELL_DOCK_IN_PAD,
      DOCK_IN_PAD,
      `the page parks the ball ${SHELL_DOCK_IN_PAD}px inside the display edge where the helper parks it ${DOCK_IN_PAD}px`,
    )
  })

  it('puts the ball on the helper\u2019s docked slot, from the bar', () => {
    // Run the page's own `handDockDragToBall` against a bar where the CSS puts it — 8px down the
    // window — on a window that is off the display, which is where a docked one always is. The ball
    // is parked the way the geometry parks a docked one, and the hand-off must put it there and move
    // it laterally by nothing at all: it is standing still at that moment, so any other offset is a
    // jump. (The grab it leaves behind is a separate question, and it is not zero — see the centre
    // case below.)
    //
    // The y is `DOCK_TAB_INSET + the window's own y`, and both terms are the bar's: the box is drawn
    // that far below the window's top edge, and the screen-to-page conversion adds the origin. The
    // inset does **not** cancel with anything on this side of the calculation — it does in the real
    // one, where `dockedTabBounds` has already put the window `DOCK_GLOW` above the ball's row, which
    // is what `geometry.test.ts`'s end-to-end case pins.
    const left = handOff(
      { side: 'left', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 0, y: 96 } },
      { x: 12, y: 54 },
    )
    assert.deepEqual(left.origin, { x: DOCK_IN_PAD, y: DOCK_TAB_INSET + 96 }, 'the left hand-off')
    // The right dock, with the window the strip actually is: a 34px box flush with the display's
    // right edge, which is where `dockedTabBounds` puts it, so the window's left edge is
    // `display.right - 34` and the bar's viewport x is 0..34 like the left dock's. What differs is
    // the window's own origin — that is the conversion the hand-off has to do — and the ball's
    // parking slot, which is a ball's width in from the display edge rather than a nudge in from the
    // bar.
    //
    // This case used to assert the ball's left edge at `2560 - 288 - 12`, which is where a ball
    // would sit if the bar's *right* edge were the display edge: a ball's width past its slot, on
    // which side the `DOCK_OVERLAP` re-dock line is — 35px the wrong way, meaning a release
    // re-docked the ball and the grab offset carried the error through the whole drag. See the
    // comment in `handDockDragToBall`.
    const right = handOff(
      { side: 'right', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 2560 - DOCK_HIT_WIDTH, y: 96 } },
      { x: 17, y: 54 },
    )
    assert.deepEqual(
      right.origin,
      { x: 2560 - BALL_SIZE - DOCK_IN_PAD, y: DOCK_TAB_INSET + 96 },
      'the right hand-off',
    )
  })

  it('starts the right-hand drag where the helper parked the ball, not a ball\u2019s width past it', () => {
    // The bug this is for, stated as the invariant that was broken: the hand-off's landing point is
    // the ball's docked slot ({@link insideBallOrigin} in `geometry.ts`), and the question is only
    // whether the page can recover that slot from the bar. It can, because the bar is that box's
    // edge-most 6px — but only from its left edge, since the box is flush with the display edge and a
    // ball is 288px wide against a 34px strip.
    //
    // Checked on all three shapes of display, and against the geometry module's own arithmetic
    // rather than restated: a window on a second display to the left of the primary is included
    // because every term here is signed and an anchor taken from the wrong edge is not.
    for (const side of ['left', 'right'] as const) {
      for (const display of [{ x: 0, width: 2560 }, { x: 0, width: 1920 }, { x: -1920, width: 1920 }]) {
        // `dockedTabBounds`: the strip is `DOCK_HIT_WIDTH` wide, flush with the display edge.
        const tabLeft = side === 'left' ? display.x : display.x + display.width - DOCK_HIT_WIDTH
        // `insideBallOrigin`: `DOCK_IN_PAD` in from the display edge on both sides.
        const slot = side === 'left'
          ? display.x + DOCK_IN_PAD
          : display.x + display.width - BALL_SIZE - DOCK_IN_PAD
        const landed = handOff(
          {
            side,
            bar: { left: 0, top: DOCK_TAB_INSET, right: DOCK_HIT_WIDTH, bottom: 296 },
            window: { x: tabLeft, y: 96 },
          },
          { x: 17, y: 54 },
        )
        assert.equal(
          landed.origin.x,
          slot,
          `a ${side}-docked ball on a display at ${display.x} was handed over ${landed.origin.x - slot}px from its slot`,
        )
      }
    }
  })

  it('lets go of the gesture where the pointer is, not where the ball was', () => {
    // The grab offset is the whole of what follows: `finishPointer` ends the drag at `screenX - dx`,
    // and the tab's move handler re-derives every position the same way. A grab taken from the bar
    // instead — the ball is parked off the edge, a ball's width from the pointer — is a release a
    // ball's width from the hand, which is the "it did not stay where I let go of it" complaint in
    // its original form. Anchoring on the centre is the same identity with the ball's middle as the
    // point that has to land on the pointer.
    const one = handOff(
      { side: 'left', bar: { left: 0, top: 8, right: 34, bottom: 296 }, window: { x: 0, y: 96 } },
      { x: 12, y: 54 },
    )
    assert.equal(one.dragging, true, 'the ball is carried')
    assert.equal(one.smoothUnsnapped, 1, 'and the dock was released, smoothly, as a leg of the pull')
    assert.equal(one.pointer.startX, one.screenX, 'the pull is still measured from where it started')
    // The ball's centre is where the hand is, in the numbers the move handler actually works in:
    // every position the drag takes is `screen - dx`, so the centre of that is the pointer's own.
    // Note which space that is — the ball is moved in screen coordinates, and the bar that was
    // measured is not.
    assert.equal(one.screenX - one.pointer.dx + BALL_SIZE / 2, one.screenX, 'the grab centres the ball on the pointer')
    assert.equal(one.screenY - one.pointer.dy + BALL_SIZE / 2, one.screenY, 'in both axes')
    // And a move keeps it there: the ball is put at `pointer - dx`, so the centre of that is the
    // pointer's own — the ball travels the distance the hand did, no more and no less.
    const moved = { x: one.screenX + 388, y: one.screenY + 350 }
    assert.deepEqual(
      {
        x: moved.x - one.pointer.dx + BALL_SIZE / 2,
        y: moved.y - one.pointer.dy + BALL_SIZE / 2,
      },
      { x: moved.x, y: moved.y },
      'the ball trailed the pointer instead of tracking it',
    )
  })

  it('lands under the hand even when one coalesced move crosses the whole threshold', () => {
    // The press is delivered, and then nothing until a single move 40px in: this is the flick the
    // whole bug was reported as. The hand-off is measured from where the pointer *was* when that move
    // arrived, so the ball comes out from under the edge on the hand rather than a jump behind it.
    const jumped = handOff(
      {
        side: 'left',
        bar: { left: 0, top: 8, right: 34, bottom: 296 },
        window: { x: 0, y: 96 },
        was: { x: 12, y: 54 },
      },
      { x: 52, y: 54 },
    )
    assert.deepEqual(jumped.origin, { x: DOCK_IN_PAD, y: DOCK_TAB_INSET + 96 },
      'the ball was placed from the move that crossed the threshold rather than from the press')
    // What has to hold is the identity, not the number: the ball's centre recovered from the offset
    // the move handler subtracts is the pointer's own, so the hand is on the ball from the first move.
    assert.equal(jumped.screenX - jumped.pointer.dx + BALL_SIZE / 2, jumped.screenX, 'the grab is taken where the hand is')
  })
})
