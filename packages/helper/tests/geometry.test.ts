import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_COLUMN, BALL_ROW, BALL_SIZE, FloatingPlacement, PANEL_WINDOW_SIZE, type Rect } from '../src/geometry.ts'

const here = dirname(fileURLToPath(import.meta.url))

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

  it('does not dock when a fifth of the ball hangs over the edge any more', async () => {
    // 140px past the right edge docked under the old rule (DOCK_OVERLAP was BALL_SIZE / 5).
    const one = placed(screen, 1772, 400)
    one.placement.move(1772, 400)
    assert.equal((await one.placement.clamp()).docked, undefined)
    assert.deepEqual(ballIn(one), { x: 1772, y: 400 })
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
