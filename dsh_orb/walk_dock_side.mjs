/**
 * Walk the *installed* dock decision: drag the ball past an edge and ask which side it lands on.
 *
 * The complaint this exists for is "I hide it to the right and it hides to the left", and the decision
 * is one pure function plus the class that calls it (`dockSideForBallOrigin`, `FloatingPlacement.clamp`
 * in `geometry.ts`). Nothing here touches the window: the placement is handed a fake one, so the whole
 * question is answered from the same code the helper runs, with the real display layout read from the
 * machine rather than guessed.
 *
 * Usage: `walk_dock_side.mjs [ball-window-x] [ball-window-y]`
 */

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SOURCES = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'src', 'geometry.ts')
const geometry = await import(pathToFileURL(SOURCES).href)
const { FloatingPlacement, initialBallOrigin, initialWindowBounds, overlayBoundsFromBall, BALL_SIZE,
  DOCK_OVERLAP } = geometry

/** The machine's display layout, as Electron would report it: bounds and work area, in screen pixels. */
function displays() {
  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
      "$($_.Bounds.X),$($_.Bounds.Y),$($_.Bounds.Width),$($_.Bounds.Height)|$($_.WorkingArea.X),$($_.WorkingArea.Y),$($_.WorkingArea.Width),$($_.WorkingArea.Height)"
    }
  `
  const raw = execFileSync(process.env.DSH_PWSH ?? 'powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
  return raw.split('\n').map((line) => line.trim()).filter((line) => line.includes('|')).map((line) => {
    const [bounds, work] = line.split('|')
    const rect = (text) => {
      const [x, y, width, height] = text.split(',').map(Number)
      return { x, y, width, height }
    }
    return { bounds: rect(bounds), workArea: rect(work) }
  })
}

const screens = displays()
console.log(`displays: ${screens.map((s) => `${s.bounds.width}x${s.bounds.height}@${s.bounds.x}`).join(' ')} | DOCK_OVERLAP=${DOCK_OVERLAP} BALL_SIZE=${BALL_SIZE}`)
const primary = screens.find((s) => s.bounds.x === 0 && s.bounds.y === 0) ?? screens[0]

/** A fake window: just the bounds the placement reads and writes. */
function makePlacement() {
  const state = { bounds: initialWindowBounds(primary.workArea) }
  const win = {
    getBounds: () => state.bounds,
    setBounds: (bounds) => { state.bounds = bounds },
  }
  const placement = new FloatingPlacement(
    win,
    (point) => {
      // `getDisplayNearestPoint`, as main.ts does it: the display whose bounds contain the point.
      const hit = screens.find((s) => point.x >= s.bounds.x && point.x < s.bounds.x + s.bounds.width
        && point.y >= s.bounds.y && point.y < s.bounds.y + s.bounds.height)
      return hit ?? primary
    },
    () => screens.map((s) => s.bounds),
    initialBallOrigin(primary.workArea),
  )
  return { placement, state }
}

const start = initialBallOrigin(primary.workArea)
console.log(`start: ball ${JSON.stringify(start)} window ${JSON.stringify(initialWindowBounds(primary.workArea))}`)

let bad = 0
/** Drag the ball to `x` and drop it, exactly as the page does: `move` while dragging, then `clamp`. */
async function drop(label, x, expected) {
  const { placement } = makePlacement()
  placement.move(x, 700, true)
  const result = await placement.clamp(true)
  const ok = (result.docked ?? 'none') === expected
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} x=${String(x).padStart(5)} -> docked ${result.docked ?? 'none'}`)
  if (!ok) {
    console.log(`      *** expected ${expected}`)
    bad += 1
  }
}

const L = primary.bounds.x
const R = primary.bounds.x + primary.bounds.width

console.log('\nthe side the ball lands on when it is dropped past each edge:')
await drop('well past the right edge', R - BALL_SIZE + DOCK_OVERLAP + 40, 'right')
await drop('a third past the right edge', R - BALL_SIZE + BALL_SIZE / 3 + 2, 'right')
await drop('one pixel short of the right line', R - BALL_SIZE + DOCK_OVERLAP - 2, 'none')
await drop('well past the left edge', L - DOCK_OVERLAP - 40, 'left')
await drop('a third past the left edge', L - BALL_SIZE / 3 - 2, 'left')
await drop('one pixel short of the left line', L - DOCK_OVERLAP + 2, 'none')
await drop('in the middle', Math.round(L + (R - L) / 2), 'none')
await drop('at the resting spot', R - BALL_SIZE, 'none')

console.log('\nand the side it comes back to after the helper restarts:')
// A fresh helper builds the placement at `initialBallOrigin` — the right edge, slightly below centre —
// so a restart cannot inherit a dock: the position is not persisted anywhere, only the panels are.
{
  const { placement } = makePlacement()
  const state = placement.currentDirection()
  const ok = state.docked === undefined
  console.log(`${ok ? 'ok  ' : 'FAIL'}  a fresh placement is not docked (direction ${state.horizontal}/${state.vertical})`)
  if (!ok) bad += 1
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
