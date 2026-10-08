/**
 * Two questions about the docked strip's hover, answered by walking the page's own functions:
 *
 *  1. **The race.** `beginDockArrive` arms `DOCK_ARRIVE_DWELL_MS` without awaiting `openDockPeek`, so
 *     the dwell and the helper's peek round trip run against each other. With the strip *after* the
 *     await, a round trip slower than the dwell lets the arrival clip land first and then takes that
 *     arrival off the ball again -- and nothing puts it back, because `syncGif`'s `dock-arrive-N` branch
 *     finds the mode and the source already equal to what it was about to assign and skips the swap. With
 *     the strip *before* the await (what ships now) the element is empty from the first frame of the
 *     peek, so there is no order left for the two halves to decide.
 *
 *  2. **The hand.** How long the entrance takes to appear after the pointer reaches the strip, at the
 *     dwell the page carries and at any other one. That number is what "the 120 ms costs feel" can be
 *     argued with instead of guessed at.
 *
 * Real timers, not a fake clock: a fake clock was written first and got the ordering wrong in exactly
 * the way that hid the race (expired timers were deferred to the next batch, which pushed the dwell
 * behind the answer every time). `--fast` shortens the clip's own hold, which nothing here measures.
 *
 * Usage: `walk_dock_hand.mjs [--installed] [--fast] [--only race|hand]`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const value = (flag, fallback) => (has(flag) ? args[args.indexOf(flag) + 1] : fallback)

const SHELL = has('--installed')
  ? join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
         'dist', 'helper', 'assets', 'shell.js')
  : join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')
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

const PAGE_DWELL = Number(new RegExp('const DOCK_ARRIVE_DWELL_MS = ([0-9]+)').exec(source)?.[1])
const PAGE_HOLD = Number(new RegExp('const DOCK_ARRIVE_HOLD_MS = ([0-9]+)').exec(source)?.[1])
if (!Number.isFinite(PAGE_DWELL)) throw new Error('the page names no DOCK_ARRIVE_DWELL_MS')

const HOLD = has('--fast') ? 120 : PAGE_HOLD
const CLIP = 'data:image/gif;base64,CLIP'
const LOOP = 'data:image/gif;base64,LOOP'
const name = (src) => (src === CLIP ? 'CLIP' : src === LOOP ? 'LOOP' : src)

/** The same function with the strip put back *after* the await, for the comparison run. */
function strippedAfterTheAwait(text) {
  const stripLine = /^\s*const gif = document\.querySelector\('#ball-gif'\)\n\s*if \(gif !== null\) gif\.removeAttribute\('src'\)\n/m
  const withoutStrip = text.replace(stripLine, '')
  if (withoutStrip === text) throw new Error('openDockPeek does not strip the picture where this expects')
  const afterTheCheck = /(\n\s*if \(!dockPeeked \|\| docked !== side\) return\n)/
  if (!afterTheCheck.test(withoutStrip)) throw new Error('openDockPeek has no post-await check')
  return withoutStrip.replace(afterTheCheck,
    "$1    const gif = document.querySelector('#ball-gif')\n    if (gif !== null) gif.removeAttribute('src')\n")
}

/** The arrival branch of the page's own `syncGif`, lifted so the walk draws what the page would draw. */
const SYNC_ARRIVAL = `
  function syncGif() {
    if (dockArriveShown === undefined) return
    const shown = dockArriveShown
    const mode = 'dock-arrive-' + shown.step
    if (gif.dataset.mode !== mode || gif.src !== shown.src) {
      gif.dataset.mode = mode
      gif.src = shown.src
      report({ at: Math.round(clock()), what: 'entrance painted (' + (shown.src === CLIP ? 'CLIP' : 'LOOP') + ')' })
    }
  }
`

/**
 * One run: the page's own `beginDockArrive` / `openDockPeek` / `playDockArrive` over real timers, with
 * `api.peekDock()` answered `peekDelayMs` after the hand arrives. `dwell` is what the walk hands the page
 * as `DOCK_ARRIVE_DWELL_MS`.
 */
async function run(functions, peekDelayMs, dwell) {
  const events = []
  const started = Date.now()
  const stamp = () => Date.now() - started

  const state = { src: 'IDLE', hasSrcAttribute: true, visible: false }
  const gif = {
    dataset: {},
    get src() { return state.hasSrcAttribute ? state.src : '' },
    set src(next) { state.src = next; state.hasSrcAttribute = true },
    removeAttribute(attribute) {
      if (attribute !== 'src') return
      state.hasSrcAttribute = false
      events.push({ at: stamp(), what: 'peek strips the picture' })
    },
  }
  const document = {
    body: {
      classList: {
        add: (class_) => {
          if (class_ === 'docked-peek') {
            state.visible = true
            events.push({ at: stamp(), what: 'ball becomes visible (docked-peek)' })
          }
        },
        remove: (class_) => { if (class_ === 'docked-peek') state.visible = false },
        contains: () => false,
        toggle: () => {},
      },
    },
    querySelector: () => gif,
  }
  const api = {
    peekDock: () => {
      events.push({ at: stamp(), what: 'peekDock() asked' })
      return new Promise((resolve) => {
        const answer = () => {
          events.push({ at: stamp(), what: 'peekDock() answered' })
          resolve({ docked: 'right' })
        }
        if (peekDelayMs <= 0) answer()
        else setTimeout(answer, peekDelayMs)
      })
    },
  }

  const factory = new Function('deps', `
    const { api, document, gif, setTimeout, clearTimeout, syncHitTest, warmDockArriveFrame,
            DOCK_ARRIVE_DWELL_MS, DOCK_ARRIVE_HOLD_MS, clock, report, CLIP, LOOP } = deps
    let docked = 'right'
    let dockPeeked = false, dockPointerInside = true, dockHoverTimer, dockArriveShown, dockArriveStep = 0
    let dockArriveTimer, dockArriveFrame = { file: { src: CLIP }, loop: LOOP }, dockArrivePending = false
    const fetchDockArrive = async () => null
    ${SYNC_ARRIVAL}
    ${functions.stopDockArriveTimer}
    ${functions.clearDockArrive}
    ${functions.playDockArrive}
    ${functions.clearDockHoverTimer}
    ${functions.openDockPeek}
    ${functions.beginDockArrive}
    return { begin: beginDockArrive }
  `)

  factory({
    api, document, gif, CLIP, LOOP,
    setTimeout, clearTimeout,
    syncHitTest: () => {}, warmDockArriveFrame: () => {},
    DOCK_ARRIVE_DWELL_MS: dwell, DOCK_ARRIVE_HOLD_MS: HOLD,
    clock: () => stamp(), report: (event) => events.push(event),
  }).begin()

  // Long enough for the dwell, the round trip, and two holds.
  await new Promise((resolve) => setTimeout(resolve, dwell + HOLD * 2 + 120))

  const strippedAt = events.findIndex((event) => event.what.startsWith('peek strips'))
  const paintedAt = events.findIndex((event) => event.what.startsWith('entrance painted'))
  const visibleAt = events.findIndex((event) => event.what.startsWith('ball becomes visible'))
  const at = (marker) => events.find((event) => event.what.startsWith(marker))?.at ?? null
  return {
    events,
    finalSrc: state.hasSrcAttribute ? state.src : '(no src attribute at all)',
    strippedAfterTheEntrance: strippedAt !== -1 && paintedAt !== -1 && strippedAt > paintedAt,
    visibleBeforeTheStrip: visibleAt !== -1 && strippedAt !== -1 && visibleAt < strippedAt,
    /** The hand is on the strip from 0 ms, so this is the whole interval it waits. */
    handToBallVisible: at('ball becomes visible'),
    handToEntrance: at('entrance painted'),
  }
}

const shipped = {
  stopDockArriveTimer: pageFunction('stopDockArriveTimer'),
  clearDockArrive: pageFunction('clearDockArrive'),
  playDockArrive: pageFunction('playDockArrive'),
  clearDockHoverTimer: pageFunction('clearDockHoverTimer'),
  beginDockArrive: pageFunction('beginDockArrive'),
  openDockPeek: pageFunction('openDockPeek'),
}
const before = { ...shipped, openDockPeek: strippedAfterTheAwait(shipped.openDockPeek) }
if (!/removeAttribute\('src'\)[\s\S]*await api\.peekDock\(\)/.test(shipped.openDockPeek)) {
  throw new Error('the page does not strip the picture before the round trip')
}

let bad = 0
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` -- ${detail}`}`)
  if (!ok) bad += 1
}

const only = value('--only', 'both')
console.log(`the page carries dwell ${PAGE_DWELL}ms and hold ${PAGE_HOLD}ms; the walk uses hold ${HOLD}ms`
  + `${has('--fast') ? ' (--fast)' : ''}\n`)

if (only === 'both' || only === 'race') {
  console.log('1. the peek round trip against the dwell\n')
  for (const [label, functions] of [['stripped AFTER the round trip (before the fix)', before],
                                    ['stripped BEFORE the round trip (shipped)', shipped]]) {
    console.log(`${label}:`)
    for (const delay of [0, 119, 200, 400]) {
      const result = await run(functions, delay, PAGE_DWELL)
      console.log(`  the helper answers at ${String(delay).padStart(3)}ms`)
      for (const event of result.events) console.log(`      ${String(event.at).padStart(4)}ms  ${event.what}`)
      console.log(`      left holding: ${result.finalSrc}${result.strippedAfterTheEntrance
        ? '   <-- stripped after the entrance landed, and nothing repaints it' : ''}`)
    }
    console.log()
  }
  const slowBefore = await run(before, 200, PAGE_DWELL)
  const slowShipped = await run(shipped, 200, PAGE_DWELL)
  report(slowBefore.strippedAfterTheEntrance,
    'the old ordering: a round trip slower than the dwell strips the entrance after it landed')
  report(!slowShipped.strippedAfterTheEntrance,
    'the shipped ordering: the same slow round trip cannot strip anything that landed')
  report(!slowShipped.visibleBeforeTheStrip,
    'and the ball is never visible before its picture is taken off')
  console.log()
}

if (only === 'both' || only === 'hand') {
  // The helper's peek round trip is 30 ms here, which is the order the render probe measured on this
  // machine (36 ms through `peekDock`). It is the same floor in every row, so what the rows differ by is
  // the dwell and nothing else.
  console.log('2. what the hand waits, pointer on the strip at 0 ms (peek round trip 30 ms)\n')
  console.log('  dwell   ball visible   entrance painted')
  const rows = []
  for (const dwell of [0, 40, 80, 120]) {
    const result = await run(shipped, 30, dwell)
    rows.push({ dwell, entrance: result.handToEntrance })
    const mark = dwell === PAGE_DWELL ? '   <- the page' : ''
    console.log(`  ${String(dwell).padStart(3)}ms   ${String(result.handToBallVisible).padStart(9)}ms   ${String(result.handToEntrance).padStart(9)}ms${mark}`)
  }
  const zero = rows.find((row) => row.dwell === 0)
  const rest = rows.find((row) => row.dwell === 120)
  if (zero && rest) {
    console.log(`\n  a 120 ms rest period is ${rest.entrance - zero.entrance}ms of the `
      + `${rest.entrance}ms between the hand reaching the strip and the entrance appearing; `
      + `at ${PAGE_DWELL}ms the entrance lands ${zero.entrance}ms after the hand`)
  }
  console.log()
}

console.log(bad === 0 ? 'OK' : `${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
