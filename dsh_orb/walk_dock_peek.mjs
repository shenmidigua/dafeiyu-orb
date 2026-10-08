/**
 * Walk the docked strip's hover across its timers, and show what a *late collapse* does to a peek.
 *
 * The strip's hover is a chain of four deferred steps, and the bug this file exists for is one of them
 * surviving a state it was never armed for:
 *
 *   1  the hand arrives -> `enterUi` -> `beginDockArrive` -> `openDockPeek()` (the ball comes half out)
 *      plus a `DOCK_ARRIVE_DWELL_MS` (120ms) timer, which plays the entrance once the hand is still there
 *   2  the hand leaves  -> `leaveUi` -> `closeDockPeek()` (the ball goes back) **and `scheduleCollapse()`**,
 *      which is 180ms away and was written for the *panel*, not for a docked ball
 *   3  the hand comes back inside those 180ms -> peek and dwell again, which is correct
 *   4  the collapse fires anyway -> `setExpanded(false)` -> `api.setExpanded(false)` -> the helper's
 *      `applyTab()`, which ends the peek (`peeking = false`) **silently**: the page keeps `dockPeeked`
 *      and the `docked-peek` class
 *
 * From step 4 the page is out of step with the helper, and both reported symptoms follow:
 *
 *   * the peeked-strip CSS draws `#dock-tab` at `--ball-column + --ball/2 (- 34px)` inside the window —
 *     586px on this pack — while the helper has shrunk the window back to its 34px tab rect, so the
 *     strip is drawn outside its own window: **the strip disappears**, and with it the way back out;
 *   * `pointerOnUi` measures the *ball's* rect for the exit test, and that rect is now 442..730 inside a
 *     35px viewport — nothing a hand at the edge can be inside — so a resting hand reads as gone, and
 *     every twitch re-enters, arms the dwell and **plays the entrance again**.
 *
 * The clock is the harness's own, so this needs neither a pointer nor a ball, and it runs in
 * milliseconds. Both sides of the fix are walked: a docked strip must never arm that collapse, and a
 * free ball must still get one.
 *
 * Usage: `walk_dock_peek.mjs [--installed]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = process.argv.includes('--installed')
  ? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
         'dist', 'helper', 'assets', 'shell.js')
  : join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')
const css = readFileSync(join(SHELL, '..', 'floating.css'), 'utf8')
console.log(`page: ${SHELL.replace(homedir(), '~')}`)

/** The text of one top-level `function name(...) { ... }`, braces balanced, `async` and all. */
function pageFunction(name) {
  const async = source.indexOf(`async function ${name}(`)
  const start = async === -1 ? source.indexOf(`function ${name}(`) : async
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
  const found = new RegExp(`const ${name} = ([0-9]+)`).exec(source)
  if (found === null) throw new Error(`${name} is not in the page`)
  return Number(found[1])
}

const DWELL = constant('DOCK_ARRIVE_DWELL_MS')
const HOLD = constant('DOCK_ARRIVE_HOLD_MS')
const COLLAPSE = constant('COLLAPSE_MS')
const ANIMATION = constant('ANIMATION_MS')

// The peeked-strip offsets, read out of the stylesheet for the same reason the page reads elements:
// restating them in the harness would let the two drift without anything noticing.
const px = (name) => Number(new RegExp(`--${name}:\\s*([0-9.]+)px`).exec(css)?.[1])
const BALL = px('ball')
const BALL_COLUMN = px('ball-column')
const PEEKED_TAB_LEFT = BALL_COLUMN + BALL / 2
const STRIP_WINDOW = 34

let bad = 0
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) bad += 1
}

/**
 * One page, with a clock the test drives and a `side` for the dock state it starts in.
 *
 * `side === undefined` is a free ball, which is the case the collapse timer was written for: it is the
 * regression this fix must not break.
 */
function makePage(side) {
  const clock = []
  let now = 0
  const timers = {
    setTimeout: (callback, delay) => { clock.push({ callback, at: now + delay, cancelled: false }); return clock.length },
    clearTimeout: (handle) => { if (clock[handle - 1]) clock[handle - 1].cancelled = true },
  }
  /** Run every timer that comes due before `until`, in order, the way a real clock would. */
  const advance = (until) => {
    for (;;) {
      const due = clock.filter((timer) => !timer.cancelled && timer.at <= until).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      due.cancelled = true
      now = due.at
      due.callback()
    }
    now = Math.max(now, until)
  }
  const calls = { peek: 0, unpeek: 0, setExpanded: [] }
  const classes = new Set()
  const page = new Function('deps', `
    const { document, api, setTimeout, clearTimeout, classes, calls, console,
            DOCK_ARRIVE_DWELL_MS, DOCK_ARRIVE_HOLD_MS, COLLAPSE_MS, ANIMATION_MS, startSide } = deps
    let docked = startSide
    let dockPeeked = false
    let dockPointerInside = false
    let dockArriveFrame = { file: { src: 'CLIP' }, loop: 'LOOP' }
    let dockArriveShown, dockArriveStep = 0, dockArriveTimer, dockArrivePending = false
    let dockHoverTimer, collapseTimer, collapseFrame
    let expanded = false, pinned = false, dragging = false, collapsing = false
    let suppressExpand = false
    const running = false, panel = { hidden: true }, stop = { hidden: true }
    const ball = { getBoundingClientRect: () => ({ width: 288, left: 442, right: 730, top: 244, bottom: 532 }) }
    const dockTab = { hidden: true, getBoundingClientRect: () => ({ width: 34, left: 0, right: 34, top: 8, bottom: 296 }) }
    const asking = () => false
    const pageClosed = () => false
    const syncGif = () => {}, syncWake = () => {}, syncHitTest = () => {}, clearTyping = () => {}
    const applyHover = () => {}
    ${pageFunction('stopDockArriveTimer')}
    ${pageFunction('clearDockArrive')}
    ${pageFunction('playDockArrive')}
    ${pageFunction('clearDockHoverTimer')}
    ${pageFunction('openDockPeek')}
    ${pageFunction('closeDockPeek')}
    ${pageFunction('beginDockArrive')}
    ${pageFunction('enterUi')}
    ${pageFunction('leaveUi')}
    ${pageFunction('scheduleCollapse')}
    ${pageFunction('setExpanded')}
    return {
      enter: enterUi,
      leave: leaveUi,
      peeked: () => dockPeeked,
      shown: () => dockArriveShown,
      step: () => dockArriveStep,
      // What a reading of "gone" does on its own, without the hand having gone anywhere: the reported
      // geometry flickers, so this is called on its own to stand for one of those readings.
      forgetPeek: () => { dockPeeked = false },
      timers: () => ({ hover: dockHoverTimer !== undefined, collapse: collapseTimer !== undefined,
                       frame: collapseFrame !== undefined }),
    }
  `)({
    document: {
      body: { classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name), toggle: () => {}, contains: (name) => classes.has(name) } },
      querySelector: () => ({ removeAttribute: () => {}, dataset: {} }),
    },
    api: {
      peekDock: async () => { calls.peek += 1; return { docked: startSide } },
      unpeekDock: async () => { calls.unpeek += 1; return { docked: startSide } },
      setExpanded: async (next) => { calls.setExpanded.push(next); return { expanded: next, horizontal: 'left', vertical: 'up', docked: next ? undefined : startSide } },
    },
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    classes, calls, startSide: side,
    console: { warn: () => {}, log: () => {} },
    DOCK_ARRIVE_DWELL_MS: DWELL, DOCK_ARRIVE_HOLD_MS: HOLD,
    COLLAPSE_MS: COLLAPSE, ANIMATION_MS: ANIMATION,
  })
  return { page, calls, classes, advance, now: () => now }
}

console.log(`constants: dwell ${DWELL}ms, hold ${HOLD}ms, collapse ${COLLAPSE}ms (+${ANIMATION}ms frame),`
  + ` peeked strip at ${PEEKED_TAB_LEFT}px of a ${STRIP_WINDOW}px window`)

// --- a docked strip, which is what the symptoms are about ------------------------------------------
{
  const docked = makePage('right')
  const { page, calls, advance } = docked
  console.log('\nthe hand hovering a docked strip:')
  page.enter()
  report(page.peeked() && page.timers().hover && !page.timers().collapse,
    'the ball comes half out and the dwell is armed — and no collapse is armed for a docked ball')
  advance(docked.now() + DWELL + 1)
  report(page.shown()?.src === 'CLIP', 'the dwell plays the entrance once the hand is still there')
  advance(docked.now() + HOLD + 1)
  report(page.shown()?.src === 'LOOP',
    'one pass of the entrance hands over to the clip the slot names for the rest of the hover')

  console.log('\nthe hand leaving:')
  page.leave()
  report(!page.peeked() && page.shown() === undefined,
    'the peek goes back and the clip is taken down, at once — a leave is a leave')
  advance(docked.now() + 60)
  page.enter()
  report(page.peeked(), 'the hand comes back: the ball is out again')
  advance(docked.now() + DWELL + 1)
  report(page.step() === 2, 'and the entrance plays again — one per hover, which is the contract',
    `step ${page.step()}`)

  console.log('\na second entry while the hover is already being served:')
  // The helper's own pointer feed calls `enterUi` again when the grown window starts reporting the
  // ball's rect, and the page's `pointermove` handler cannot filter it: the docked branch deliberately
  // never sets `hovering`, so every move over the strip counts as an entry. What must not happen is a
  // second *entrance* — the dwell it re-arms would fire while the first clip is still up, and the strip
  // would greet a hand that has not moved over and over.
  const before = page.step()
  for (let round = 0; round < 5; round += 1) {
    page.enter()
    advance(docked.now() + 30)
  }
  report(page.step() === before && page.peeked(),
    'a repeated entry never replays the entrance while one is being served',
    `step ${page.step()} (was ${before})`)

  console.log('\nand the entrance is still one per hover after all that:')
  page.leave()
  page.enter()
  advance(docked.now() + DWELL + 1)
  report(page.step() === before + 1, 'a fresh hover plays it again from the first frame',
    `step ${page.step()}`)

  console.log('\nnothing arms a collapse behind the peek:')
  page.leave()
  page.enter()
  advance(docked.now() + COLLAPSE + ANIMATION + 200)
  report(!calls.setExpanded.includes(false),
    'no collapse follows the hand in to end the peek behind the page',
    `api.setExpanded calls: ${JSON.stringify(calls.setExpanded)}`)
  if (calls.setExpanded.includes(false)) {
    console.log(`      the helper's setExpanded(false) runs applyTab(), which ends the peek silently while`)
    console.log(`      the page keeps 'docked-peek': #dock-tab is then drawn at ${PEEKED_TAB_LEFT}px inside a`)
    console.log(`      ${STRIP_WINDOW}px window — off its own window, so the strip disappears.`)
  }
  report(page.peeked(), 'the peek is still standing while the hand is there')
}

// --- a free ball, whose panel must still collapse ---------------------------------------------------
{
  const free = makePage(undefined)
  const { page, calls, advance } = free
  console.log('\nthe same timer for a free ball (the regression this must not break):')
  page.leave()
  report(page.timers().collapse, 'leaving a free ball still arms the collapse')
  advance(free.now() + COLLAPSE + ANIMATION + 200)
  report(calls.setExpanded.includes(false), 'and the panel is collapsed through the helper, as before',
    `api.setExpanded calls: ${JSON.stringify(calls.setExpanded)}`)
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
