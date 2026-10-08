import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_COLUMN, BALL_ROW, BALL_SIZE, DOCK_GLOW, DOCK_HIT_WIDTH, DOCK_HOVER_MARGIN, DOCK_IN_PAD, DOCK_OVERLAP, DOCK_TAB_WIDTH, FloatingPlacement, PANEL_WINDOW_SIZE, type Rect } from '../src/geometry.ts'

const here = dirname(fileURLToPath(import.meta.url))
/**
 * The page's own copy of the one number a hand-off out of the dock needs. See `shell.js`.
 *
 * `DOCK_IN_PAD` is imported from the module rather than read out of the page, because holding the
 * page's copy to the module's is `dock-tab-drag.test.ts`'s job; what this file is about is whether
 * the two agree on where the ball ends up.
 */
const DOCK_TAB_INSET = Number(/const DOCK_TAB_INSET = (\d+)/.exec(readFileSync(join(here, '../assets/shell.js'), 'utf8'))?.[1])

describe('docking on more than one display', () => {
  it('does not dock on the seam between two displays', async () => {
    const displays = [
      pair(0, 0, 1440, 900),
      pair(1440, 0, 1920, 1080),
    ]
    const placed = placement(displays, 1388, 400)
    placed.move(1388, 400)
    const seam = await placed.clamp()
    assert.equal(seam.docked, undefined)

    const outer = placement(displays, 3302, 400)
    outer.move(3302, 400)
    const docked = await outer.clamp()
    assert.equal(docked.docked, 'right')
  })
})

describe('a release keeps the ball where it was let go', () => {
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]
  const withTaskbar = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]

  it('docks as soon as a third of the ball hangs over the edge', async () => {
    // 96px past the right edge is exactly BALL_SIZE / 3 - the docking threshold.
    const one = placed(screen, 1728, 400)
    one.placement.move(1728, 400)
    assert.equal((await one.placement.clamp()).docked, 'right')
  })

  it('leaves the ball where it was let go when less than a third hangs over the edge', async () => {
    // One pixel short of the threshold: still a plain release, no docking.
    const one = placed(screen, 1727, 400)
    one.placement.move(1727, 400)
    assert.equal((await one.placement.clamp()).docked, undefined)
    assert.deepEqual(ballIn(one), { x: 1727, y: 400 })
  })

  it('still docks when the ball is mostly past the edge', async () => {
    const one = placed(screen, 1830, 400)
    one.placement.move(1830, 400)
    assert.equal((await one.placement.clamp()).docked, 'right')
  })

  it('honours a release over the taskbar instead of dragging the ball fully on screen', async () => {
    // The old clamp forced y down to 1040 - 288 = 752; now the release stands.
    const one = placed(withTaskbar, 800, 850)
    one.placement.move(800, 850)
    await one.placement.clamp()
    assert.deepEqual(ballIn(one), { x: 800, y: 850 })
  })

  it('pulls a mostly off-screen ball back until half of it is reachable', async () => {
    const one = placed(withTaskbar, 1000, 1400)
    one.placement.move(1000, 1400)
    await one.placement.clamp()
    assert.deepEqual(ballIn(one), { x: 1000, y: 1040 - Math.round(288 / 2) })
  })
})

describe('the window is one rect in both states', () => {
  // The arrangement exists so this is true. Opening the panel used to resize the window, and a
  // window that has just grown still presents the surface it had while small, laid at its new
  // origin — which put the ball in the panel's top-left corner for one frame on every hover.
  // Nothing page-side can prevent that, so the resize is gone rather than worked around.
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

  it('leaves the window untouched when the panel opens and closes', () => {
    const one = placed(screen, 1700, 300)
    const before = one.bounds()
    one.placement.setExpanded(true)
    assert.deepEqual(one.bounds(), before, 'opening resized nothing')
    assert.equal(one.bounds().width, PANEL_WINDOW_SIZE.width)
    assert.equal(one.bounds().height, PANEL_WINDOW_SIZE.height)
    one.placement.setExpanded(false)
    assert.deepEqual(one.bounds(), before, 'and closing it changed nothing either')
  })

  it('keeps the ball still across the whole open/close cycle', () => {
    const one = placed(screen, 1700, 300)
    const resting = ballIn(one)
    one.placement.setExpanded(true)
    assert.deepEqual(ballIn(one), resting, 'the ball moved on the way in')
    one.placement.setExpanded(false)
    assert.deepEqual(ballIn(one), resting, 'the ball moved on the way out')
  })

  it('holds the same rect for a whole drag, open or closed', () => {
    const one = placed(screen, 1700, 300)
    for (const x of [1700, 1600, 1500, 1400, 1300]) {
      one.placement.move(x, 300)
      assert.equal(one.bounds().width, PANEL_WINDOW_SIZE.width, `the window grew at x=${x}`)
      assert.equal(one.bounds().height, PANEL_WINDOW_SIZE.height, `the window grew at x=${x}`)
    }
  })

  it('ends a release where the pointer let go, even past where the panel fits', async () => {
    // 1700 is past the point where a 742px overlay still fits on this display, and still short
    // of the docking overlap. The window is not pulled back to compensate, because moving the
    // window is what would put the ball somewhere it was not left.
    const one = placed(screen, 1700, 300)
    one.placement.move(1700, 300)
    const state = await one.placement.clamp()
    assert.equal(state.docked, undefined)
    assert.deepEqual(ballIn(one), { x: 1700, y: 300 })
  })
})

describe('the corner is knowable before anything is drawn', () => {
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

  it('answers with the corner the ball is in, and moves nothing', () => {
    const one = placed(screen, 1700, 300)
    const before = one.bounds()
    // A read, not a gesture. The page wears this before its first paint, because the ball is
    // only ever positioned by the direction rules — there is no correct-looking default to fall
    // back on and correct a frame later.
    assert.deepEqual(one.placement.currentDirection(), { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined })
    assert.deepEqual(one.bounds(), before, 'the window was not touched')
    // And the two have to agree exactly: the page wears the read, and the panel then opens into
    // the same corner.
    assert.deepEqual(one.placement.setExpanded(true), one.placement.currentDirection())
  })

  it('agrees on the other corner too', () => {
    const one = placed(screen, 100, 100)
    const corner = { expanded: false, horizontal: 'right', vertical: 'down', docked: undefined }
    assert.deepEqual(one.placement.currentDirection(), corner)
    one.placement.setExpanded(true)
    assert.deepEqual(one.placement.currentDirection(), { ...corner, expanded: true })
  })

  it('re-decides the corner at rest without moving the ball or the window', () => {
    // At rest the direction is re-decided on every drag that carries the ball across the middle of
    // the display, and it must not move anything: the ball's offset inside the window is a
    // constant, so a rect that moved with the direction would be a ball drawn a panel's width from
    // the pointer — for as long as the page took to hear about the change, which is a frame, which
    // is a visible jump. Both halves have to hold, so both are asserted.
    const one = placed(screen, 300, 300)
    one.placement.move(300, 300)
    const leftHalf = one.bounds()
    assert.equal(one.placement.currentDirection().horizontal, 'right')
    assert.deepEqual(ballIn(one), { x: 300, y: 300 })

    one.placement.move(1700, 300)
    assert.equal(one.placement.currentDirection().horizontal, 'left')
    assert.deepEqual(ballIn(one), { x: 1700, y: 300 })

    // Same ball as the first call, and the same corner: the rect has to come out identical. The
    // only thing that may move this window is the ball.
    one.placement.move(300, 300)
    assert.equal(one.placement.currentDirection().horizontal, 'right')
    assert.deepEqual(one.bounds(), leftHalf, 'the rect followed the direction, not the ball')
  })

  it('keeps the direction classes and the window rect describing the same layout', () => {
    // The resting window is the overlay rect, and the ball sits at a fixed offset inside it —
    // `--ball-column` / `--ball-row` — rather than in a corner the direction chooses. If the
    // stylesheet's numbers and the geometry's ever disagree, the ball lands somewhere other than
    // where the window was built around it: the same class of bug as the flash, just permanent. So
    // every number the geometry is built from is checked against the one the CSS declares.
    const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    const px = (name: string): number => {
      const found = new RegExp(`${name}:\\s*(\\d+)px`).exec(css)
      assert.notEqual(found, null, `${name} is still declared in pixels`)
      return Number(found?.[1])
    }
    assert.equal(px('--ball'), BALL_SIZE)
    assert.equal(px('--ball-column'), BALL_COLUMN)
    assert.equal(px('--ball-row'), BALL_ROW)
    // The two relationships the stylesheet's own arithmetic rests on, asserted rather than assumed:
    // the card's column is one panel, one gap and one inset from the ball's, and its row is one
    // ball less than a card from the ball's. Those are what let the card be placed from the ball.
    assert.equal(px('--chrome') + px('--panel-width') + px('--panel-gap'), BALL_COLUMN)
    assert.equal(px('--chrome') + px('--panel-height') - px('--ball'), BALL_ROW)
    assert.equal(
      BALL_COLUMN + px('--ball') + px('--panel-gap') + px('--panel-width') + px('--chrome'),
      PANEL_WINDOW_SIZE.width,
    )
    assert.equal(BALL_ROW + px('--panel-height') + px('--chrome'), PANEL_WINDOW_SIZE.height)
  })

  it('lets no direction class place the ball', () => {
    // The offset is a constant for one reason: the window's origin is moved by the main process and
    // the ball's offset is applied by the page, in two frames that can never be committed together.
    // A direction that changes the offset therefore puts the ball a panel's width away from the
    // pointer until the page catches up — which is what "the ball runs around while I drag it" was,
    // measured on the real machine. Four `body.expand-* #ball` rules were how it happened, and one
    // of them coming back is how it would happen again.
    const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    const placed = [...css.matchAll(/body\.expand-[a-z]+[^{}]*\{[^{}]*\}/g)]
      .map((match) => match[0])
      .filter((rule) => /#ball(?![\w-])/.test(rule))
    assert.deepEqual(placed, [], 'a direction rule places the ball again')
  })

  it('has no ball-sized window rect left to collapse into', () => {
    // The collapsed size only exists as a number now. If it is still exported, something is still
    // building a window out of it, and that something would resize.
    assert.notEqual(collapsedWindowSizeStillUsed(), true)
  })
})

/**
 * Whether anything still refers to the ball-sized window.
 *
 * Read out of the sources rather than asserted by hand, because the point is that no *other* file
 * quietly depends on it either — a leftover call in the main process would fail just as loudly as
 * a failing test, but only once someone ran the app.
 */
function collapsedWindowSizeStillUsed(): boolean {
  const sources = ['geometry.ts', 'main.ts']
    .map((name) => readFileSync(join(here, '../src', name), 'utf8'))
  return sources.some((text) => /BALL_WINDOW_SIZE/.test(text.replace(/^.*BALL_WINDOW_SIZE = .*$/m, '')))
}

describe('pulling a docked ball back out hands it over where the helper parked it', () => {
  /**
   * The whole gesture, on the real geometry module and the page's real hand-off.
   *
   * The two halves of a docked release live in different processes and neither one can see the
   * other's numbers: the helper parks the ball at `insideBallOrigin`, and the page has to recover
   * that same point from nothing but the docked strip's own box before it can start following the
   * pointer. When it recovers the wrong point, the ball does not merely start in the wrong place —
   * `pointer.dx` is measured against wherever it was put, so the error is carried by every move of
   * the drag and the release then re-docks the ball on the side that lands on.
   *
   * So this drives the pair rather than either alone: dock a ball, pull it out through the page's
   * hand-off, carry it the way the page's move handler does, release it through the helper's
   * `clamp`, and ask where it ended up.
   */
  const screens = [
    { name: 'the primary display', displays: [pair(0, 0, 2560, 1440)] },
    { name: 'a second display to its right', displays: [pair(0, 0, 1920, 1080), pair(1920, 0, 1920, 1080)] },
    { name: 'a second display to its left', displays: [pair(-1920, 0, 1920, 1080), pair(0, 0, 1920, 1080)] },
  ]

  /** The strip `dock` leaves behind, as the page measures it: the viewport box of a window at the tab rect. */
  function bar(side: 'left' | 'right', tab: Rect): Record<string, number> {
    return { left: 0, top: DOCK_TAB_INSET, right: DOCK_HIT_WIDTH, bottom: DOCK_TAB_INSET + BALL_SIZE }
  }

  for (const screen of screens) {
    for (const side of ['left', 'right'] as const) {
      it(`starts the carry at the docked slot on ${screen.name}, docked ${side}`, async () => {
        const display = side === 'left' ? screen.displays[0] : screen.displays[screen.displays.length - 1]
        // A ball overhanging the edge it is about to dock against, so `clamp` commits the dock.
        const y = 400
        const overhang = side === 'left'
          ? display.bounds.x - Math.round(BALL_SIZE / 3)
          : display.bounds.x + display.bounds.width - BALL_SIZE + Math.round(BALL_SIZE / 3)
        const one = placed(screen.displays, overhang, y)
        one.placement.move(overhang, y)
        const docked = await one.placement.clamp()
        assert.equal(docked.docked, side, 'the ball did not dock, so the rest of this is about nothing')

        // Where the helper has it parked. The window is now the tab rect, so this is the same
        // recovery the page cannot do: it has no window, only the strip's box inside one.
        const tab = one.bounds()
        assert.equal(tab.width, DOCK_HIT_WIDTH, 'the docked window is the strip, not the overlay')
        const parked = {
          x: side === 'left' ? display.bounds.x + DOCK_IN_PAD : display.bounds.x + display.bounds.width - BALL_SIZE - DOCK_IN_PAD,
          y,
        }

        // The page's hand-off, handed the strip's box and a pointer resting on it. The window's own
        // origin is `tab.x`/`tab.y`, which is what the two coordinate spaces differ by.
        const strip = bar(side, tab)
        const pointerClient = { x: side === 'left' ? 12 : DOCK_HIT_WIDTH - 12, y: DOCK_TAB_INSET + 46 }
        const handed = handOff({
          side,
          bar: strip,
          window: { x: tab.x, y: tab.y },
          pointer: pointerClient,
        })

        // The one thing being asked: did the page put the ball where the helper parked it? A ball a
        // few pixels out is a visible hop, and past `DOCK_OVERLAP` it is a release that re-docks.
        assert.equal(handed.origin.x, parked.x,
          `the page handed the ball over ${handed.origin.x - parked.x}px from its docked slot`)
        assert.equal(handed.origin.y, parked.y, 'and on the row the strip reported')
        assert.equal(handed.dragging, true, 'the ball is carried by the page from here')

        // And the grab is the ball's centre, which is where the ball is held rather than where it is
        // put. `dx` is what the move handler subtracts from the pointer to get the ball's top-left,
        // so a `half` offset puts the centre on the pointer on every move of the drag. Reading it as
        // the pointer-to-corner offset instead is the ball's *top-left* following the hand — a whole
        // half-width of lead, which is the ball sliding out from under the edge and then trailing.
        //
        // This is the very move the drag will perform, applied to the pointer as it stands, so the
        // recovered corner is the ball's own: a `dx` that is not the pointer-to-centre offset lands
        // here as a ball whose centre has jumped off the hand by that difference.
        assert.deepEqual(
          { x: handed.pointer.screenX - handed.pointer.dx + BALL_SIZE / 2, y: handed.pointer.screenY - handed.pointer.dy + BALL_SIZE / 2 },
          { x: handed.pointer.screenX, y: handed.pointer.screenY },
          'the hand is not on the ball\u2019s centre',
        )

        // Now the rest of the drag, in the helper: the carry, then the release. The ball is moved to
        // where the page's move handler would put it for a pointer travelled this far, and released
        // away from the edge so the answer is a free ball rather than another dock.
        const travel = { x: side === 'left' ? 600 : -600, y: 120 }
        const moved = { x: handed.pointer.screenX + travel.x, y: handed.pointer.screenY + travel.y }
        one.placement.move(moved.x - handed.pointer.dx, moved.y - handed.pointer.dy)
        const released = await one.placement.clamp()
        assert.equal(released.docked, undefined, 'the ball re-docked itself on the way out')
        // Where it ended is the move handler's own `screen - dx`, and the centre of that is the
        // pointer — the ball arrived under the hand rather than dragging it along by the corner.
        const ended = ballIn(one)
        assert.deepEqual(
          ended,
          { x: moved.x - handed.pointer.dx, y: moved.y - handed.pointer.dy },
          'the ball did not end the drag where the pointer left it',
        )
        assert.deepEqual(
          { x: ended.x + BALL_SIZE / 2, y: ended.y + BALL_SIZE / 2 },
          { x: moved.x, y: moved.y },
          'the ball\u2019s centre did not end the drag on the pointer',
        )
      })
    }
  }
})

describe('pulling the ball out is a slide, not a teleport', () => {
  /** A docked placement on a 2560x1440 display, ready to be slid back out. */
  async function docked() {
    const display = pair(0, 0, 2560, 1440)
    const one = placed([display], 0, 300)
    // Move the ball until a third of it hangs over the left edge, which is the line `clamp` docks on
    // — a ball merely parked *near* an edge is not docked, and `unsnapSmooth` has nothing to read.
    one.placement.move(-DOCK_OVERLAP, 300)
    const state = await one.placement.clamp()
    assert.equal(state.docked, 'left', 'the ball did not dock, so there is nothing to slide out of')
    return one
  }

  it('walks the ball out from behind the edge, frame by frame', async () => {
    // The bug, stated as the thing that was missing: docking *slides* the ball off the edge over
    // 250ms — `snap` animates to `offScreenBallOrigin` — and pulling it back out used to put it on
    // its slot in one frame. So the journey the user was shown going in had no counterpart coming
    // out, and the hand holding the strip saw the ball appear at the cursor rather than travel to it.
    const one = await docked()
    const frames: number[] = []
    const watch = () => frames.push(ballIn(one).x)
    const ticking = setInterval(watch, 8)
    try {
      await one.placement.unsnapSmooth()
    } finally {
      clearInterval(ticking)
    }
    watch()
    // Every distinct x the ball passed through. A one-frame jump leaves one entry; a slide leaves
    // many, and this is the whole of what "there is an animation" means for a window that only ever
    // reports its rect.
    const walked = [...new Set(frames)]
    assert.ok(walked.length > 5, `the ball moved through only ${walked.length} positions: it was not animated`)
    // And it went the right way, monotonically, from behind the edge to the slot: the ball enters
    // from off-screen and lands `DOCK_IN_PAD` in, which is `unsnap`'s own destination.
    assert.ok(walked[0] < DOCK_IN_PAD, 'the ball did not start off the display')
    assert.equal(walked[walked.length - 1], DOCK_IN_PAD, 'the slide did not land the ball on its slot')
    for (let i = 1; i < walked.length; i += 1) {
      assert.ok(walked[i] > walked[i - 1], `the slide went backwards at frame ${i}: ${walked[i - 1]} -> ${walked[i]}`)
    }
    assert.equal(ballIn(one).y, 300, 'the slide moved the ball vertically, which it must not')
  })

  it('is abandoned the moment a move arrives, so the hand never waits for it', async () => {
    // The whole reason this can be 300ms without being a delay: the slide writes `this.origin` and
    // bumps the animation generation, so a `move` during it takes the window over from wherever the
    // slide had reached. A test that merely awaited the slide would pass even if the move had been
    // swallowed until it ended — so this interrupts mid-flight and checks the ball is on the pointer
    // *before* the slide would have finished.
    const one = await docked()
    const slide = one.placement.unsnapSmooth()
    await new Promise((done) => setTimeout(done, 60))
    const asked = { x: 900, y: 500 }
    one.placement.move(asked.x, asked.y, false)
    assert.deepEqual(ballIn(one), asked, 'the move that interrupted the slide did not take the ball over')
    // The slide resolves rather than hanging, and it does not drag the ball back to the slot once the
    // hand has taken it — which is what a naive `await this.animate(...)` would do here.
    await slide
    assert.deepEqual(ballIn(one), asked, 'the slide reassigned the ball after it had been taken over')
  })

  it('is a different entry point from the snapping one, which is left alone', () => {
    // `unsnap` is still what the callers that *finish* a gesture use — a click on the strip, and the
    // release path. Only the pull drives the slide, so the two must not have been collapsed into one.
    const source = readFileSync(join(here, '../src/geometry.ts'), 'utf8')
    assert.match(source, /async unsnap\(\): Promise<DockState> \{/, 'the snapping unsnap is gone')
    assert.match(source, /async unsnapSmooth\(\): Promise<DockState> \{/, 'and the sliding one is missing')
    assert.match(source, /DOCK_SLIDE_OUT_MS, easeOutCubic/, 'the slide is not the eased one, so it would travel in a line')
    const page = readFileSync(join(here, '../assets/shell.js'), 'utf8')
    assert.match(page, /unsnapSmooth\(\)/, 'the page never asks for the smooth one')
  })
})

describe('a hover shows the docked ball half out of the edge, without giving up the dock', () => {
  const screen = pair(0, 0, 2048, 864)
  /** Half the ball on screen, the other half past the edge it is docked to. */
  const halfOut = { x: 2048 - Math.round(BALL_SIZE / 2), y: 300 }
  const slot = { x: 2048 - BALL_SIZE - DOCK_IN_PAD, y: 300 }

  /** A placement docked on the right of a 2048x864 display, with the ball 300px down. */
  async function docked() {
    const one = placed([screen], 2048 - DOCK_OVERLAP, 300)
    one.placement.move(2048 - DOCK_OVERLAP, 300)
    const state = await one.placement.clamp()
    assert.equal(state.docked, 'right', 'the ball did not dock, so there is nothing to peek out of')
    return one
  }

  it('stands the ball half out of the edge in one frame, with the window grown around it', async () => {
    // "One frame" is the decision, not an accident: the clip the ball wears is its whole arrival, and
    // a window sliding out underneath it would be a second arrival racing the first. So the assertion
    // is that the ball is already in place *before* the promise is awaited — an `await` anywhere in
    // the body would show up here as the ball still being behind the edge.
    const one = await docked()
    const peeked = one.placement.peek()
    assert.deepEqual(ballIn(one), halfOut,
      'the peek animates, or lands the ball somewhere other than half way out of its own edge')
    // The window has to be the full overlay rect: the ball is drawn `BALL_COLUMN` into it, and a 34px
    // tab rect has no such column to draw it in. Which is also what makes the ball *half* out — half
    // of it is past the display edge, and nothing here clips it back on.
    assert.equal(one.bounds().width, PANEL_WINDOW_SIZE.width, 'the window was left too small to hold the ball')
    assert.equal(one.bounds().height, PANEL_WINDOW_SIZE.height)
    assert.deepEqual(await peeked, { docked: 'right' }, 'the peek gave the dock up to show the ball')
  })

  it('puts the ball back behind the strip, still docked', async () => {
    const one = await docked()
    await one.placement.peek()
    const unpeeked = one.placement.unpeek()
    // The same "no animation" claim in reverse, and the same reason: the ball comes off the screen
    // before the window shrinks under it, not after.
    assert.equal(one.bounds().width, DOCK_HIT_WIDTH, 'the window was left grown after the pointer left')
    assert.deepEqual(await unpeeked, { docked: 'right' })
    // The strip is back on the edge it was docked to, which is what makes the drag out of the dock
    // still work after a peek.
    assert.equal(one.bounds().x, 2048 - DOCK_HIT_WIDTH, 'the tab is no longer against the edge it was docked to')
    assert.equal(one.bounds().height, BALL_SIZE + 2 * DOCK_GLOW)
  })

  it('does not throw the ball back off the edge for a pull that starts from a peek', async () => {
    // The one thing the peek changes about the pull. `unsnapSmooth` parks the window off the screen
    // and then slides it in, which is right for a ball hidden behind the strip — and wrong for one
    // that is already half way out, because the user would watch the ball they were reaching for
    // jump a half further away and come back.
    const one = await docked()
    await one.placement.peek()
    const slide = one.placement.unsnapSmooth()
    assert.deepEqual(ballIn(one), halfOut,
      'the pull re-parked a ball that was already out, so the slide starts from behind the edge')
    assert.deepEqual(await slide, { docked: undefined }, 'the pull did not give the dock up')
    assert.deepEqual(ballIn(one), slot, 'and the hand-off did not land the ball on its slot')
  })

  it('and the slide is exactly what comes back once the ball is behind the strip again', async () => {
    // The other half of the same rule, and the one that would catch a `peeking` flag that was never
    // cleared: after the peek ends, the pull has to be back to its ordinary sliding self. Without
    // this, a stale flag would leave the ball teleporting out of the dock for the rest of the page's
    // life and every test above would still pass.
    const one = await docked()
    await one.placement.peek()
    await one.placement.unpeek()
    const slide = one.placement.unsnapSmooth()
    assert.ok(ballIn(one).x > 2048, 'the pull started with the ball already out: `unpeek` left the peek standing')
    await slide
    assert.deepEqual(ballIn(one), slot)
  })

  it('is a state of its own, asked for and cleared by both ways out of the dock', () => {
    // Both `unsnap` and `unsnapSmooth` read it and both clear it. One of them forgetting is a bug
    // that only shows on one of the two paths a user can take out of the dock, so it is pinned here
    // rather than left to whichever path a test happens to exercise.
    const source = readFileSync(join(here, '../src/geometry.ts'), 'utf8')
    assert.match(source, /private peeking = false/, 'the peek is not a state, so nothing can ask for it')
    for (const name of ['unsnap', 'unsnapSmooth']) {
      const body = new RegExp(`async ${name}\\(\\)[\\s\\S]*?\\n  \\}`).exec(source)?.[0] ?? ''
      assert.notEqual(body, '', `${name} is missing`)
      assert.match(body, /this\.peeking/, `${name} does not ask whether the ball is peeking`)
      assert.match(body, /this\.peeking = false/, `${name} leaves the peek standing`)
    }
    // And the way back to the strip ends it by itself, so no caller has to remember to.
    assert.match(source, /private applyTab\(side: DockSide, ballY: number, bounds: Rect\): void \{[\s\S]*?this\.peeking = false/,
      'the layout the peek is the opposite of does not end it')
  })
})

/**
 * The page's own `handDockDragToBall`, run against a strip box.
 *
 * A copy of the harness in `dock-tab-drag.test.ts`, kept separate because that file is about the
 * page's arithmetic alone and this one is about whether that arithmetic and `insideBallOrigin` agree.
 */function handOff(input: {
  side: 'left' | 'right'
  bar: Record<string, number>
  window: { x: number; y: number }
  pointer: { x: number; y: number }
}): {
  origin: { x: number; y: number }
  pointer: { dx: number; dy: number; screenX: number; screenY: number }
  dragging: boolean
} {
  const page = readFileSync(join(here, '../assets/shell.js'), 'utf8')
  const found = /(?:^|[^\w$])function handDockDragToBall\(/.exec(page)
  assert.notEqual(found, null, 'handDockDragToBall is missing from the page')
  const head = (found as RegExpExecArray).index + (found as RegExpExecArray)[0].length - 'function handDockDragToBall('.length
  const open = page.indexOf('{', head)
  let depth = 0
  let body = ''
  for (let i = open; i < page.length; i += 1) {
    if (page[i] === '{') depth += 1
    else if (page[i] === '}') {
      depth -= 1
      if (depth === 0) {
        body = page.slice(head, i + 1)
        break
      }
    }
  }
  assert.notEqual(body, '', 'handDockDragToBall never closes')
  const factory = new Function('deps', `
    const { dockTab, ball, side, DOCK_IN_PAD, DOCK_TAB_INSET } = deps
    let docked = side
    let lastOrigin
    let lastScreenX = deps.at.screenX
    let lastScreenY = deps.at.screenY
    let lastClientX = deps.at.clientX
    let lastClientY = deps.at.clientY
    let pointer = { dx: 0, dy: 0, startX: deps.at.screenX, startY: deps.at.screenY }
    let dockPointerInside = true
    let dragging = false
    let carriedFromDock = false
    const unsnapDocked = async () => {}
    const unsnapDockedSmooth = async () => {}
    const startDragIntro = () => {}
    const playDropFrame = () => {}
    const syncGif = () => {}
    ${body}
    handDockDragToBall(deps.at)
    return { origin: lastOrigin, pointer: { ...pointer, screenX: lastScreenX, screenY: lastScreenY }, dragging }
  `)
  const at = {
    screenX: input.pointer.x + input.window.x,
    screenY: input.pointer.y + input.window.y,
    clientX: input.pointer.x,
    clientY: input.pointer.y,
  }
  return factory({
    dockTab: { getBoundingClientRect: () => input.bar },
    ball: { getBoundingClientRect: () => ({ width: BALL_SIZE }) },
    side: input.side,
    DOCK_IN_PAD,
    DOCK_TAB_INSET,
    at,
  })
}

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function placement(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number): FloatingPlacement {
  return placed(displays, x, y).placement
}

/**
 * A placement plus a reader for the window bounds it has written.
 *
 * The window starts life as the overlay rect, at the position the ball at `(x, y)` implies — which
 * is what the real helper builds, and what the page is told to lay out against. `rounding` models
 * a display whose scale factor makes the OS answer a rect that is that many pixels larger than the
 * one that was set.
 */
function placed(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number, rounding = 0): {
  placement: FloatingPlacement
  bounds: () => Rect
} {
  const origin = { x, y }
  let bounds: Rect = {
    x: x - BALL_COLUMN,
    y: y - BALL_ROW,
    width: PANEL_WINDOW_SIZE.width,
    height: PANEL_WINDOW_SIZE.height,
  }
  const placement = new FloatingPlacement({
    getBounds: () => ({ ...bounds, width: bounds.width + rounding, height: bounds.height + rounding }),
    setBounds(next) { bounds = { ...next } },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds), origin)
  // Put the window where the ball's resting position actually puts it, so a test that never moves
  // anything still starts from a real layout rather than a convenient one.
  placement.move(x, y, false)
  return { placement, bounds: () => ({ ...bounds }) }
}

/**
 * Where the ball is on screen, given the window rect.
 *
 * Recovered the way the page's own layout puts it together — window origin plus the ball's offset
 * inside it — rather than read back from the placement. That is the whole claim being tested: the
 * ball's screen position is the window's, plus a fixed offset, and nothing else. Not even the
 * direction, which is the point of the offset being fixed.
 */
function ballIn(one: { placement: FloatingPlacement; bounds: () => Rect }): { x: number; y: number } {
  const bounds = one.bounds()
  return { x: bounds.x + BALL_COLUMN, y: bounds.y + BALL_ROW }
}

function nearest(displays: { bounds: Rect; workArea: Rect }[], point: { x: number; y: number }) {
  let best = displays[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of displays) {
    const cx = display.bounds.x + display.bounds.width / 2
    const cy = display.bounds.y + display.bounds.height / 2
    const distance = (cx - point.x) ** 2 + (cy - point.y) ** 2
    if (distance < bestDistance) {
      best = display
      bestDistance = distance
    }
  }
  if (best === undefined) throw new Error('no display')
  return best
}
