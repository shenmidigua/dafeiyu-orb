/**
 * Check the strip's pull-out hand-off, with the numbers the live desktop actually produces.
 *
 * `handDockDragToBall()` is the one place in the dock path where the left/right arithmetic is written
 * out by hand rather than taken from a helper that knows the side: it converts the bar's *viewport*
 * rectangle into the *screen* coordinates `orb:move` speaks, puts the ball on the edge the strip is
 * flush with, and leaves the grab offset every later move subtracts. The conversion is
 * `screen = viewport + window origin`, and the window origin is measured as `lastScreenX - lastClientX`.
 *
 * It used to be wrong for one side — it *subtracted* that origin for a right dock and never took the
 * ball's own width off, so a right-docked ball was handed over about a screen to the left, the grab
 * offset inherited the error, and the release re-docked it on the left. This file is what caught that,
 * with the numbers below; the page has since replaced it with its own version of the same fix
 * (`edge + toScreenX` on both sides, the ball's width off on the right, `DOCK_IN_PAD` in), and its test
 * lives in `packages/helper/tests/dock-tab-drag.test.ts`. What is left here is the numeric check on the
 * geometry this desktop really has, which the test's synthetic window is not.
 *
 * The numbers here are not invented: `probe_dock_side.py` measures the docked window for each side on
 * this machine, and they are pasted in below. The geometry is the real `FloatingPlacement` out of
 * `geometry.ts`, so the case ends by asking it which side it would dock.
 *
 * Usage: `walk_dock_handoff.mjs [--installed]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const SHELL = args.includes('--installed')
  ? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'assets', 'shell.js')
  : join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets', 'shell.js')
const GEOMETRY = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'src', 'geometry.ts')
const source = readFileSync(SHELL, 'utf8')
console.log(`page: ${SHELL.replace(homedir(), '~')}`)

/** The text of one top-level `function name(...) { ... }`, braces balanced. */
function pageFunction(name) {
  const start = source.indexOf(`function ${name}(`)
  if (start === -1) throw new Error(`${name} is not in the page`)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

const constant = (name) => {
  const match = new RegExp(`const ${name} = (\\d+)`).exec(source)
  if (match === null) throw new Error(`${name} is not in the page`)
  return Number(match[1])
}

const PAD = constant('DOCK_IN_PAD')

const geometry = await import(pathToFileURL(GEOMETRY).href)
const { FloatingPlacement, BALL_SIZE } = geometry

// Measured on this machine by `probe_dock_side.py`: the docked window for each side, in DIP, on a
// 2048x864 work area, with the page's viewport coming out a pixel wider than the rect asked for.
const DISPLAY = { x: 0, y: 0, width: 2048, height: 864 }
const DOCKED = {
  left: { window: { x: 0, y: 472, width: 34, height: 304 }, bar: { left: 0, right: 34, top: 8 } },
  right: { window: { x: 2014, y: 472, width: 34, height: 304 }, bar: { left: 1, right: 35, top: 8 } },
}

/** Run the page's hand-off for one dock side and report what it left behind. */
function handOff(side) {
  const { window: rect, bar } = DOCKED[side]
  // The press lands on the 6px bar, which is the edge-most 6px of the strip's box.
  const clientX = side === 'left' ? 3 : bar.right - 3
  const clientY = bar.top + 20
  const screenX = rect.x + clientX
  const screenY = rect.y + clientY
  const hand = new Function('deps', `
    const { docked, dockTab, ball, lastScreenX, lastScreenY, lastClientX, lastClientY,
            unsnapDockedSmooth, unsnapDocked, startDragIntro, syncGif, playDropFrame, DOCK_IN_PAD } = deps
    let dragging = false
    // The press left this behind; the hand-off reads pointer.startX to keep the threshold that
    // recognised the pull, so the harness has to stand where the pointerdown handler would.
    let pointer = { dx: 0, dy: 0, startX: lastScreenX, startY: lastScreenY }
    let lastOrigin
    let dockPointerInside = true
    ${pageFunction('handDockDragToBall')}
    handDockDragToBall()
    return { dragging, pointer, lastOrigin, dockPointerInside }
  `)({
    docked: side,
    dockTab: { getBoundingClientRect: () => ({ ...bar, bottom: bar.top + 288, width: bar.right - bar.left, height: 288 }) },
    // The ball's own box, which the page reads for its width (288 here, as the CSS sets it).
    ball: { getBoundingClientRect: () => ({ width: BALL_SIZE }) },
    lastScreenX: screenX, lastScreenY: screenY, lastClientX: clientX, lastClientY: clientY,
    unsnapDockedSmooth: () => {}, unsnapDocked: () => {}, startDragIntro: () => {}, syncGif: () => {},
    playDropFrame: () => {},
    DOCK_IN_PAD: PAD,
  })
  return { ...hand, press: { screenX, screenY, clientX, clientY } }
}

let bad = 0
for (const side of ['left', 'right']) {
  const { window: rect, bar } = DOCKED[side]
  const hand = handOff(side)
  const parked = hand.lastOrigin
  // Where the ball is parked should be the slot the geometry parks a docked ball in: its *inner* edge
  // `DOCK_IN_PAD` in from the display edge the strip is flush with, and the whole ball on screen.
  const innerEdge = side === 'left' ? parked.x : parked.x + BALL_SIZE
  const fromEdge = side === 'left' ? innerEdge - DISPLAY.x : DISPLAY.x + DISPLAY.width - innerEdge
  const onScreen = parked.x >= DISPLAY.x - BALL_SIZE && parked.x + BALL_SIZE <= DISPLAY.x + DISPLAY.width
  console.log(`\n--- ${side}-docked strip pulled (window at x=${rect.x}, bar viewport ${bar.left}..${bar.right}) ---`)
  console.log(`    press at client ${hand.press.clientX},${hand.press.clientY} = screen ${hand.press.screenX},${hand.press.screenY}`)
  console.log(`    hand-off parked the ball at x=${parked.x.toFixed(0)} y=${parked.y.toFixed(0)}`
    + ` | grab dx=${hand.pointer.dx.toFixed(0)} | its inner edge is ${fromEdge.toFixed(0)}px from the ${side} edge`)
  const ok = Math.abs(fromEdge - PAD) <= 2 && onScreen
  console.log(`${ok ? 'ok  ' : 'FAIL'}  the ball is parked on the side it was pulled from, ${PAD}px in`)
  if (!ok) bad += 1

  // Now the pull itself: 60px inward from the press, then the release, exactly as the page does it —
  // `moveBall(screenX - dx)` per move, then `clamp()` on release.
  const inwardSign = side === 'left' ? 1 : -1
  const release = hand.press.screenX + inwardSign * 60
  let state = { bounds: rect }
  const placement = new FloatingPlacement(
    { getBounds: () => state.bounds, setBounds: (bounds) => { state.bounds = bounds } },
    () => ({ bounds: DISPLAY, workArea: DISPLAY }),
    () => [DISPLAY],
    // A docked ball's placement keeps the origin the drag last asked for; the hand-off replaces it.
    { x: parked.x, y: parked.y },
  )
  placement.move(release - hand.pointer.dx, hand.press.screenY - hand.pointer.dy, true)
  const docked = await placement.clamp(true)
  const expected = side // pulled 60px in: no dock, and certainly not the other side
  const landed = docked.docked ?? 'none'
  const okDock = landed !== (side === 'left' ? 'right' : 'left')
  console.log(`${okDock ? 'ok  ' : 'FAIL'}  released 60px inward, the ball does not end up on the other side`
    + ` — docked: ${landed} (origin ${(release - hand.pointer.dx).toFixed(0)})`)
  if (!okDock) bad += 1
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
