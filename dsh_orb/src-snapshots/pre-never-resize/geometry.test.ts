import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { BALL_SIZE, BALL_WINDOW_SIZE, CHROME_INSET, FloatingPlacement, PANEL_WINDOW_SIZE, type Rect } from '../src/geometry.ts'

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
    assert.equal(one.bounds().x + CHROME_INSET, 1772)
    assert.equal(one.bounds().y + CHROME_INSET, 400)
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
    assert.equal(one.bounds().y + CHROME_INSET, 850)
  })

  it('pulls a mostly off-screen ball back until half of it is reachable', async () => {
    const one = placed(withTaskbar, 1000, 1400)
    one.placement.move(1000, 1400)
    await one.placement.clamp()
    assert.equal(one.bounds().y + CHROME_INSET, 1040 - Math.round(288 / 2))
  })
})

describe('a window rect rounded to whole pixels cannot change the layout', () => {
  // At a 125% scale factor Windows answers 313x313 for a 312x312 request. The old layout
  // test compared the reported size with BALL_WINDOW_SIZE, so a collapsed ball counted as
  // expanded: every drag moved the whole overlay, and the release ended wherever that
  // layout's clamped geometry put it instead of where the pointer let go.
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

  it('keeps the collapsed window collapsed for a whole drag', () => {
    const one = placed(screen, 1700, 300, 1)
    one.placement.setExpanded(true)
    one.placement.setExpanded(false)
    for (const x of [1700, 1600, 1500, 1400, 1300]) {
      one.placement.move(x, 300)
      assert.equal(one.bounds().width, BALL_WINDOW_SIZE)
      assert.equal(one.bounds().height, BALL_WINDOW_SIZE)
      assert.equal(one.bounds().x, x - CHROME_INSET)
    }
  })

  it('ends a release where the pointer let go, even where the panel would have been clamped', async () => {
    // 1700 is past the point where a 742px overlay still fits on this display, and still
    // short of the docking overlap, so only a collapsed window can honour the release.
    const one = placed(screen, 1700, 300, 1)
    one.placement.setExpanded(true)
    one.placement.setExpanded(false)
    one.placement.move(1700, 300)
    const state = await one.placement.clamp()
    assert.equal(state.docked, undefined)
    assert.equal(one.bounds().x + CHROME_INSET, 1700)
    assert.equal(one.bounds().y + CHROME_INSET, 300)
  })

  it('still docks a rounded ball released mostly past the edge', async () => {
    const one = placed(screen, 1830, 400, 1)
    one.placement.setExpanded(true)
    one.placement.setExpanded(false)
    one.placement.move(1830, 400)
    assert.equal((await one.placement.clamp()).docked, 'right')
  })
})

describe('the corner is knowable before the window grows into it', () => {
  const screen = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]

  it('answers with the corner the resize is about to use, and moves nothing', () => {
    const one = placed(screen, 1700, 300)
    const before = one.bounds()
    const corner = one.placement.expandCorner()
    // A read, not a gesture. The page wears this answer while the window is still ball-sized,
    // which is the only thing that lets it be applied before the resize it is meant for.
    assert.deepEqual(one.bounds(), before, 'the window was not touched')
    assert.deepEqual(corner, { expanded: true, horizontal: 'left', vertical: 'up', docked: undefined })
    // And the two have to agree exactly: the corner is worn early, but the resize is still the
    // thing that decides where the ball ends up.
    assert.deepEqual(one.placement.setExpanded(true), corner)
  })

  it('agrees on the other corner too', () => {
    const one = placed(screen, 100, 100)
    const corner = { expanded: true, horizontal: 'right', vertical: 'down', docked: undefined }
    assert.deepEqual(one.placement.expandCorner(), corner)
    assert.deepEqual(one.placement.setExpanded(true), corner)
  })

  it('still agrees where the overlay itself gets clamped into the work area', () => {
    // A ball let go hanging half off the right edge expands into a window that no longer fits on
    // the display, and the clamp pulls the overlay back inside. The prediction has to survive
    // that: it names the corner, and the corner is decided before the clamp can move anything.
    const one = placed(screen, 1800, 300)
    const corner = one.placement.expandCorner()
    assert.deepEqual(one.placement.setExpanded(true), corner, 'the clamped resize gave the same corner')
    assert.equal(one.bounds().x, 1920 - PANEL_WINDOW_SIZE.width + CHROME_INSET, 'and the window really was clamped')
  })

  it('keeps the corner a no-op at the collapsed window size', () => {
    // Why wearing the corner early shows nothing: the collapsed window is exactly the ball plus
    // its two chrome insets, so at that width `right: var(--chrome)` resolves to the same pixel as
    // `left: var(--chrome)`, and `bottom` to `top`. Change either number in the stylesheet without
    // this one and the ball jumps on the way in again — which is the flash all of this is about.
    const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
    const px = (name: string): number => {
      const found = new RegExp(`${name}:\\s*(\\d+)px`).exec(css)
      assert.notEqual(found, null, `${name} is still declared in pixels`)
      return Number(found?.[1])
    }
    assert.equal(px('--ball'), BALL_SIZE)
    assert.equal(px('--ball') + 2 * px('--chrome'), BALL_WINDOW_SIZE)
  })
})

function pair(x: number, y: number, width: number, height: number): { bounds: Rect; workArea: Rect } {
  const bounds = { x, y, width, height }
  return { bounds, workArea: bounds }
}

function placement(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number): FloatingPlacement {
  return placed(displays, x, y).placement
}

/**
 * A placement plus a reader for the window bounds it has written.
 * `rounding` models a display whose scale factor makes the OS answer a rect that is that
 * many pixels larger than the one that was set.
 */
function placed(displays: { bounds: Rect; workArea: Rect }[], x: number, y: number, rounding = 0): {
  placement: FloatingPlacement
  bounds: () => Rect
} {
  let bounds: Rect = {
    x: x - CHROME_INSET,
    y: y - CHROME_INSET,
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  }
  const placement = new FloatingPlacement({
    getBounds: () => ({ ...bounds, width: bounds.width + rounding, height: bounds.height + rounding }),
    setBounds(next) { bounds = { ...next } },
  }, (point) => nearest(displays, point), () => displays.map((display) => display.bounds))
  return { placement, bounds: () => ({ ...bounds }) }
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
