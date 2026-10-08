/**
 * Walk the docked-strip arrival out of the *installed* page: the dwell, the one clip, and the face.
 *
 * The behaviour is three small pieces of the page: `beginDockArrive` arms a timer when the pointer comes
 * to rest on the strip, `playDockArrive` puts one frame up with a step of its own, and `syncGif` draws
 * it above every other face while it lasts. What this walks is those three, compiled out of the bundle
 * the ball is actually running rather than out of the sources — a build that had lost the branch would
 * pass every source-level check and leave the strip silent.
 *
 * The live version of this (dock the ball, rest a real pointer on the strip, watch the `<img>`) is
 * `probe_dock_arrive.py`. It cannot finish on this desktop: the dock needs a drag, and a synthetic
 * release through the DevTools protocol is not delivered to the element that took pointer capture, so
 * the drag stays open and the clamp never runs. That is a harness limit rather than a feature one, and
 * it is why this file exists next to it.
 *
 * The last case is the one that is easy to get wrong in a way nobody notices: a pointer that *crosses*
 * the strip must play nothing, which is the whole reason the dwell exists.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = process.argv.includes('--source')
  // The working tree, for checking a change *before* it is installed: the installed copy is what the ball
  // runs, so a fix that only exists in the sources would otherwise look untested.
  ? join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets', 'shell.js')
  : join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
         'dist', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')
console.log(`page: ${SHELL.replace(homedir(), '~')}`)

/** The text of one top-level `function name(...) { ... }`, braces balanced, `async` and all. */
function pageFunction(name) {
  // `async function fetchDockArrive` has to come out with its `async`: slicing from the `function`
  // keyword alone yields a body with an `await` in it and no way to compile.
  const async = source.indexOf(`async function ${name}(`)
  const start = async === -1 ? source.indexOf(`function ${name}(`) : async
  if (start === -1) throw new Error(`${name} is not in the installed page`)
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
  if (match === null) throw new Error(`${name} is not in the installed page`)
  return Number(match[1])
}

const DWELL = constant('DOCK_ARRIVE_DWELL_MS')
const HOLD = constant('DOCK_ARRIVE_HOLD_MS')

let bad = 0
const report = (ok, label, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) bad += 1
}

// 1. The clip's own machinery: the dwell, the one-shot, and the step that makes a second hover restart.
const clip = new Function('deps', `
  const { api, syncGif, console } = deps
  let dockArriveFrame, dockArriveShown, dockArriveStep = 0, dockArriveTimer, dockArrivePending = false
  const DOCK_ARRIVE_HOLD_MS = ${HOLD}
  function timedFrameOf(value) { return value === null || typeof value !== 'object' ? null : value }
  ${pageFunction('fetchDockArrive')}
  ${pageFunction('stopDockArriveTimer')}
  ${pageFunction('playDockArrive')}
  ${pageFunction('clearDockArrive')}
  return {
    // The slot answers a file plus an optional loop clip now: an entrance that plays once, and a clip
    // the ball rests on for the rest of the hover (null when the pack names none).
    arm: () => { if (dockArriveFrame === undefined) dockArriveFrame = { file: { src: 'CLIP', ms: ${HOLD} }, loop: 'LOOP' } },
    play: playDockArrive,
    clear: clearDockArrive,
    read: () => ({ shown: dockArriveShown, step: dockArriveStep, timer: dockArriveTimer !== undefined }),
  }
`)({
  api: { memeDockArrive: async () => ({ file: { src: 'CLIP', ms: HOLD }, loop: 'LOOP' }) },
  syncGif: () => {},
  console: { warn: () => {} },
})

clip.arm()
report(clip.read().shown === undefined, 'nothing is up before the pointer rests on the strip')
clip.play()
const first = clip.read()
report(first.shown?.src === 'CLIP' && first.step === 1 && first.timer,
  'one rest puts the entrance up, once, with a hold of its own', `step ${first.step}, held ${HOLD} ms`)
clip.play()
const second = clip.read()
report(second.step === 2, 'a second rest starts it again from its first frame', `step ${second.step}`)
clip.clear()
report(clip.read().shown === undefined && clip.read().timer === false,
  'leaving the strip takes it down, timer and all')

// The frame arrives late on the first hover after a page load; a read in flight has to be joined rather
// than started twice, and the clip has to survive the wait.
let reads = 0
let release
const late = new Function('deps', `
  const { api, syncGif, console } = deps
  let dockArriveFrame, dockArriveShown, dockArriveStep = 0, dockArriveTimer, dockArrivePending = false
  const DOCK_ARRIVE_HOLD_MS = ${HOLD}
  function timedFrameOf(value) { return value === null || typeof value !== 'object' ? null : value }
  ${pageFunction('fetchDockArrive')}
  ${pageFunction('stopDockArriveTimer')}
  ${pageFunction('playDockArrive')}
  return {
    play: playDockArrive,
    read: () => ({ shown: dockArriveShown, step: dockArriveStep }),
  }
`)({
  api: { memeDockArrive: () => { reads += 1; return new Promise((resolve) => { release = () => resolve({ file: { src: 'LATE', ms: HOLD }, loop: null }) }) } },
  syncGif: () => {},
  console: { warn: () => {} },
})
late.play()
late.play()
report(reads === 1, 'two hovers inside one read join it instead of starting a second', `reads ${reads}`)
release?.()
await new Promise((resolve) => setTimeout(resolve, 20))
report(late.read().shown?.src === 'LATE', 'and the clip plays when that read lands')

// 1b. The dwell: a rest plays it, a crossing does not. This is the half that makes "put the mouse on it"
// different from "pass the mouse over it", and it is the case a strip that plays on every pass fails.
let played = 0
const timers = []
const dwell = new Function('deps', `
  const { setTimeout, clearTimeout, playDockArrive, openDockPeek } = deps
  const DOCK_ARRIVE_DWELL_MS = ${DWELL}
  let dockHoverTimer, dockArriveShown, dockPointerInside = true, docked = 'right'
  // The dwell is armed behind the peek now: a hover brings the ball half out and only then starts the
  // clock. Two things stop a second entry from re-arming one already running — the page's dockPeeked
  // flag, and an entrance that is already up (dockArriveShown). Both are declared here because
  // beginDockArrive reads them; the only thing this walk is about is the timer underneath them.
  let dockPeeked = false
  ${pageFunction('clearDockHoverTimer')}
  ${pageFunction('beginDockArrive')}
  return {
    arm: beginDockArrive,
    leave: () => { dockPointerInside = false; clearDockHoverTimer() },
    undock: () => { docked = undefined },
    pending: () => dockHoverTimer !== undefined,
  }
`)({
  setTimeout: (callback, delay) => { timers.push({ callback, delay }); return timers.length },
  clearTimeout: (handle) => { if (timers[handle - 1]) timers[handle - 1].cancelled = true },
  playDockArrive: () => { played += 1 },
  openDockPeek: () => {},
})

dwell.arm()
report(timers.length === 1 && timers[0].delay === DWELL,
  'a pointer resting on the strip waits the dwell before the clip', `${timers[0]?.delay} ms`)
timers[0].callback()
report(played === 1, 'and then plays it')

timers.length = 0
played = 0
dwell.arm()
dwell.leave()
report(timers[0]?.cancelled === true && played === 0,
  'a pointer that crosses it instead plays nothing — the timer is dropped on the way out')

timers.length = 0
played = 0
dwell.arm()
dwell.undock()
timers[0].callback()
report(played === 0, 'and a hover that arrives as the ball comes out of the dock plays nothing either')

// 2. The face: `syncGif` has to draw it, and above the reactions it says it outranks.
const build = new Function('deps', `
  const { document, pageClosed, syncSleep, dragging, dragSrc, dragIntroSrc, dragIntroUntil, clickShown,
          arriveShown, wakeShown, doneShown, failShown, askShown, typingSrc, replySrc, toolSrc,
          thinkingSrc, speakSrc, speakActive, voiceSrc, dictationPhase, dropShown, webfetchSrc,
          agentState, agentTool, idleSrc, poorSrc, balanceCny, poorBelow, hoverSrc, hoverIntroSrc,
          introUntil, hovering, napShown, sleepFrameAt, skitInfo, skitFrame, running, asking,
          tccGateVisible, attachedSelection, expanded, avatarSrc, freezeGif, Date, WEB_FETCH_TOOL,
          TYPING_HOLD_MS, typingAt, dockArriveShown, docked } = deps
  ${pageFunction('brokeNow')}
  ${pageFunction('loopsForever')}
  ${pageFunction('oneShotHoldMs')}
  ${pageFunction('syncGif')}
  return syncGif
`)

function show(options = {}) {
  const gif = { dataset: options.dataset ?? {}, src: undefined }
  build({
    document: { querySelector: () => gif, body: { classList: { contains: (name) => name === 'docked' && options.docked === true } } },
    pageClosed: () => false, syncSleep: () => {},
    dragging: false, dragSrc: undefined, dragIntroSrc: undefined, dragIntroUntil: 0,
    clickShown: options.clickShown, arriveShown: undefined, wakeShown: undefined,
    doneShown: undefined, failShown: undefined, askShown: undefined,
    typingSrc: undefined, replySrc: undefined, toolSrc: undefined, thinkingSrc: undefined,
    speakSrc: undefined, speakActive: false, voiceSrc: undefined, dictationPhase: 'idle',
    dropShown: undefined, webfetchSrc: undefined, agentState: '', agentTool: '',
    idleSrc: 'IDLE', poorSrc: undefined, balanceCny: null, poorBelow: 5,
    hoverSrc: undefined, hoverIntroSrc: undefined, introUntil: 0, hovering: false,
    napShown: undefined, sleepFrameAt: () => undefined, skitInfo: undefined, skitFrame: undefined,
    running: false, asking: () => false, tccGateVisible: false,
    attachedSelection: '', expanded: false, avatarSrc: 'AVATAR', freezeGif: () => {}, Date,
    WEB_FETCH_TOOL: 'web_fetch', TYPING_HOLD_MS: 3000, typingAt: 0,
    dockArriveShown: options.dockArriveShown, docked: options.docked,
  })()
  return { mode: gif.dataset.mode, src: gif.src }
}

const face = show({ dockArriveShown: { src: 'CLIP', step: 1 }, docked: true })
report(face.mode === 'dock-arrive-1' && face.src === 'CLIP',
  'the ball wears the clip while it is up', `mode ${face.mode}`)
report(show({ dockArriveShown: { src: 'CLIP', step: 2 }, docked: true }).mode === 'dock-arrive-2',
  'and a new step is a new mode, so the image element reloads from the first frame')
report(show({ dockArriveShown: { src: 'CLIP', step: 1 }, clickShown: { src: 'CLICK', step: 1 }, docked: true }).src === 'CLIP',
  'the arrival outranks the click reaction, as the page says it does')
report(show({ dockArriveShown: { src: 'LOOP', step: 3 }, docked: true }).src === 'LOOP',
  'the clip the slot names for the rest of the hover is worn in the same face')
// With no clip up, a *docked* ball is deliberately left alone: it is hidden behind the strip, and the
// page does not repaint an element nobody can see (the note above `openDockPeek` says so). So the mode
// it happens to carry is the answer, not a repaint — the strip is what is on screen.
report(show({ docked: true, dataset: { mode: 'dock-arrive-1' } }).mode === 'dock-arrive-1'
  && show({ docked: true, dataset: { mode: 'dock-arrive-1' } }).src === undefined,
  'and with nothing up, a docked ball keeps whatever it was wearing — the strip is what is visible')

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
