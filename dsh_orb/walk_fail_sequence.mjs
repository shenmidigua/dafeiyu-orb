/**
 * Walk the *installed* page through the failure face's whole rule.
 *
 * The feature is one decision made in two places: the host says *which* ending a turn had, and the page
 * picks the face for it. The host half is walked by `packages/host/tests/failure.test.ts`; what this
 * walks is the page's half, against the real `syncGif` cut out of the installed bundle — because a
 * build that dropped the branch would pass every unit test and put the wrong face on the ball.
 *
 * The cases are the ones that would each look plausible while being wrong:
 *
 *   * the failure face is worn while it is up, and hands the ball back when its one pass is over;
 *   * it outranks the resting loop, *including* the poor face — a failure is an event, a balance is a
 *     state, and the project's rule is that events win;
 *   * the user's own hand still wins over it (a carry, a click), and a greeting does not;
 *   * it is not a resting loop itself: a pack that names no failure file shows the ordinary loop.
 *
 * Every case rebuilds the closure, since `syncGif` captures its state as `const`s at construction.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
  'dist', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')

/** The text of one top-level `function name(...) { ... }`, braces balanced. */
function pageFunction(name) {
  const start = source.indexOf(`function ${name}(`)
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

const build = new Function('deps', `
  const { document, pageClosed, syncSleep, dragging, dragSrc, dragIntroSrc, dragIntroUntil,
          clickShown, arriveShown, wakeShown, doneShown, failShown, askShown, typingSrc, replySrc, toolSrc,
          thinkingSrc, speakSrc, speakActive, voiceSrc, dictationPhase, dropShown, webfetchSrc,
          agentState, agentTool, idleSrc, poorSrc, balanceCny, poorBelow, hoverSrc, hoverIntroSrc,
          introUntil, hovering, napShown, sleepFrameAt, skitInfo, skitFrame, running, asking,
          tccGateVisible, attachedSelection, expanded, avatarSrc, freezeGif, Date, WEB_FETCH_TOOL,
          TYPING_HOLD_MS, typingAt } = deps
  ${pageFunction('brokeNow')}
  ${pageFunction('syncGif')}
  return syncGif
`)

/** What the ball would show for one page state, with every pose this walk is not about disarmed. */
function show(options = {}) {
  const gif = { dataset: options.dataset ?? {}, src: undefined }
  build({
    document: { querySelector: () => gif, body: { classList: { contains: () => false } } },
    pageClosed: () => false, syncSleep: () => {},
    dragging: options.dragging === true, dragSrc: 'DRAG', dragIntroSrc: undefined, dragIntroUntil: 0,
    clickShown: options.clickShown, arriveShown: options.arriveShown,
    wakeShown: options.wakeShown, doneShown: options.doneShown,
    // `'x' in options` rather than a default: the case that matters most here is "this pack names no
    // failure face", which is an explicit `undefined`.
    failShown: 'failShown' in options ? options.failShown : { src: 'CRY', step: 1 },
    askShown: options.askShown,
    typingSrc: undefined, replySrc: undefined, toolSrc: 'TOOL', thinkingSrc: undefined,
    speakSrc: undefined, speakActive: false, voiceSrc: undefined, dictationPhase: 'idle',
    dropShown: options.dropShown, webfetchSrc: undefined, agentState: '', agentTool: '',
    idleSrc: 'IDLE',
    // A pack whose account is nearly out: the state the failure face has to outrank.
    poorSrc: options.poorSrc, balanceCny: options.balanceCny ?? null, poorBelow: options.poorBelow ?? 5,
    hoverSrc: undefined, hoverIntroSrc: undefined, introUntil: 0, hovering: false,
    napShown: undefined, sleepFrameAt: () => undefined, skitInfo: undefined, skitFrame: undefined,
    running: false, asking: () => false, tccGateVisible: false,
    attachedSelection: '', expanded: false, avatarSrc: 'AVATAR', freezeGif: () => {}, Date,
    WEB_FETCH_TOOL: 'web_fetch', TYPING_HOLD_MS: 3000, typingAt: 0,
  })()
  return { mode: gif.dataset.mode, src: gif.src }
}

let bad = 0
const check = (label, actual, expected) => {
  const ok = actual.mode === expected.mode && actual.src === expected.src
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} -> ${String(actual.mode).padEnd(9)} ${actual.src}`)
  if (!ok) {
    console.log(`      *** expected ${expected.mode} ${expected.src}`)
    bad += 1
  }
}

console.log('the failure face while it is up:')
check('one pass of the clip is worn', show(), { mode: 'fail-1', src: 'CRY' })
check('a second failure restarts the clip', show({ failShown: { src: 'CRY', step: 2 } }),
  { mode: 'fail-2', src: 'CRY' })
check('the repaint after it lands changes nothing', show({ dataset: { mode: 'fail-1' } }),
  { mode: 'fail-1', src: undefined })

console.log('\nand once its pass is over, the resting logic has the ball again:')
check('no cue left: the ordinary resting loop', show({ failShown: undefined }), { mode: 'idle', src: 'IDLE' })
// The priority question, answered by the same case twice: a failure is an *event* and a balance is a
// *state*, so the failure face is worn over the poor one and the poor one comes back when it is done.
check('a broke account still has to wait for the pass',
  show({ poorSrc: 'POOR', balanceCny: 0, poorBelow: 5 }), { mode: 'fail-1', src: 'CRY' })
check('a broke account returns after the pass',
  show({ failShown: undefined, poorSrc: 'POOR', balanceCny: 0, poorBelow: 5 }), { mode: 'poor', src: 'POOR' })

console.log('\nthe user\'s own hand still outranks it, and a greeting does not:')
check('a click wins over a failed run', show({ clickShown: { src: 'CLICK', step: 1 } }),
  { mode: 'click-1', src: 'CLICK' })
check('a carry wins over a failed run', show({ dragging: true }), { mode: 'drag', src: 'DRAG' })
check('a release wins over a failed run', show({ dropShown: { src: 'DROP', step: 1 } }),
  { mode: 'drop-1', src: 'DROP' })
check('a failed run outranks a greeting', show({ arriveShown: { src: 'ARRIVE', step: 1 } }),
  { mode: 'fail-1', src: 'CRY' })
// A failure and a finished task cannot both be true of one turn, but the page must still have an
// order if a stale bell frame is somehow up: the failure is the more specific fact and goes first.
check('a failed run is not celebrated with the bell',
  show({ doneShown: { src: 'BELL', step: 1 } }), { mode: 'fail-1', src: 'CRY' })

console.log('\na pack that names no failure face is unaffected:')
check('no file named: the ordinary resting loop', show({ failShown: undefined }), { mode: 'idle', src: 'IDLE' })
check('no file named, broke account: the poor face',
  show({ failShown: undefined, poorSrc: 'POOR', balanceCny: 0 }), { mode: 'poor', src: 'POOR' })

console.log('\nthe failure face is not a resting loop of its own:')
// It must not survive as a mode the resting branch could fall back to; the only thing that shows it is
// `failShown`, which the page clears when the clip's own length is up.
const page = source.replace(/\r\n/g, '\n')
const branch = page.slice(page.indexOf('if (failShown !== undefined)'), page.indexOf('if (doneShown !== undefined)'))
const restores = /failShown = undefined/.test(page) && branch.includes('return')
console.log(`${restores ? 'ok  ' : 'FAIL'}  it is a cue with an end, not a mode the ball can rest in`)
if (!restores) bad += 1

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
