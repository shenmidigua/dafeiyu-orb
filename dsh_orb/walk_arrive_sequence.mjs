/**
 * Walk the *installed* `syncGif` through the life of a page, which is where the greeting lives.
 *
 * The unit test pins the picker — does the slot resolve to a real GIF with a duration — and says
 * nothing about whether the ball ever wears it. What that leaves open is exactly the four ways a
 * startup frame goes wrong: it never appears, it appears behind the resting loop, it appears again
 * on a later repaint (which turns a greeting into a loop), or it swallows something the user did
 * to the ball while it was up.
 *
 * Read out of the installed bundle rather than the source, because a build that dropped the branch
 * would pass every unit test and show nothing here.
 *
 * Each step rebuilds the closure: `syncGif` captures its state as `const`s at construction, so a
 * single instance cannot be walked through a sequence the way the page walks it through events.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
  'dist', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')

const head = source.indexOf('function syncGif(')
if (head === -1) throw new Error('syncGif is not in the installed page')
const open = source.indexOf('{', head)
let depth = 0
let end = -1
for (let i = open; i < source.length; i += 1) {
  if (source[i] === '{') depth += 1
  else if (source[i] === '}') {
    depth -= 1
    if (depth === 0) { end = i; break }
  }
}
const body = source.slice(head, end + 1)

const build = new Function('deps', `
  const { document, pageClosed, syncSleep, dragging, dragSrc, dragIntroSrc, dragIntroUntil,
          clickShown, arriveShown, wakeShown, doneShown, failShown, askShown, typingSrc, replySrc, toolSrc, thinkingSrc,
          speakSrc, speakActive, voiceSrc, dictationPhase, dropShown, webfetchSrc, agentState,
          agentTool, idleSrc, hoverSrc, hoverIntroSrc, introUntil, hovering, napShown, skitInfo,
          skitFrame, sleepFrameAt, running, asking, tccGateVisible, attachedSelection, expanded,
          avatarSrc, freezeGif, Date, WEB_FETCH_TOOL, TYPING_HOLD_MS, typingAt, brokeNow } = deps
  ${body}
  return syncGif
`)

/** What the ball would show for one state of the page, with every other pose disarmed. */
function show(options = {}) {
  const arriveShown = 'arriveShown' in options ? options.arriveShown : { src: 'ARRIVE', step: 1 }
  const gif = { dataset: options.dataset ?? {}, src: undefined }
  build({
    document: { querySelector: () => gif, body: { classList: { contains: () => false } } },
    pageClosed: () => false, syncSleep: () => {},
    dragging: options.dragging === true, dragSrc: 'DRAG', dragIntroSrc: undefined,
    dragIntroUntil: 0,
    clickShown: options.clickShown, arriveShown, wakeShown: options.wakeShown,
    doneShown: options.doneShown,
    // The failure face is off: this walk is about the greeting. `walk_fail_sequence.mjs` walks it.
    failShown: undefined,
    // And the question face, for the same reason the harnesses name it: `syncGif` reads it, so leaving
    // it out of this closure is a `ReferenceError` rather than a wrong answer.
    askShown: undefined,
    typingSrc: undefined, replySrc: options.replySrc, toolSrc: 'TOOL', thinkingSrc: undefined,
    speakSrc: undefined, speakActive: false, voiceSrc: undefined, dictationPhase: 'idle',
    dropShown: options.dropShown, webfetchSrc: undefined,
    agentState: options.agentState ?? '', agentTool: '',
    idleSrc: 'IDLE', hoverSrc: undefined, hoverIntroSrc: undefined, introUntil: 0, hovering: false,
    napShown: undefined, skitInfo: undefined, skitFrame: undefined, sleepFrameAt: () => undefined,
    running: options.running === true, asking: () => false, tccGateVisible: false,
    attachedSelection: '', expanded: options.expanded === true, avatarSrc: 'AVATAR',
    // The poor face is off: this walk is about the greeting, which is over before the resting loop
    // is reached at all. `walk_poor_sequence.mjs` walks the real predicate.
    brokeNow: () => false,
    freezeGif: () => {}, Date,
    WEB_FETCH_TOOL: 'web_fetch', TYPING_HOLD_MS: 3000, typingAt: 0,
  })()
  return { mode: gif.dataset.mode, src: gif.src }
}

/** One case: what the page is doing, and the pose the ball is supposed to be wearing. */
const CASES = [
  ['the page opens, greeting up', {}, { mode: 'arrive-1', src: 'ARRIVE' }],
  ['the repaint after it lands', { arriveShown: { src: 'ARRIVE', step: 1 }, dataset: { mode: 'arrive-1' } },
    { mode: 'arrive-1', src: undefined }],
  ['the greeting expired', { arriveShown: undefined }, { mode: 'idle', src: 'IDLE' }],
  ['a click during the greeting', { clickShown: { src: 'CLICK', step: 1 } }, { mode: 'click-1', src: 'CLICK' }],
  ['a carry during the greeting', { dragging: true }, { mode: 'drag', src: 'DRAG' }],
  ['a release during the greeting', { dropShown: { src: 'DROP', step: 1 } }, { mode: 'drop-1', src: 'DROP' }],
  // The greeting yields to every event cue, the wake word and the finished turn included: the ball
  // appearing is the one thing the page knew about in advance, so it is the one thing that can
  // afford to wait. It does not lose its place — the hold is still running — so the greeting is
  // back, from its first frame, once the cue above it clears.
  ['a wake word mid-greeting', { wakeShown: { src: 'WAKE', step: 1 } }, { mode: 'wake-1', src: 'WAKE' }],
  ['the turn ends mid-greeting', { doneShown: { src: 'DONE', step: 1 } }, { mode: 'done-1', src: 'DONE' }],
  ['a second greeting step', { arriveShown: { src: 'ARRIVE', step: 2 } }, { mode: 'arrive-2', src: 'ARRIVE' }],
  ['an open panel, no greeting', { arriveShown: undefined, expanded: true }, { mode: 'idle', src: 'IDLE' }],
  ['a turn running, no greeting', { arriveShown: undefined, running: true }, { mode: 'play', src: 'AVATAR' }],
  // The greeting outranks the resting poses, which is what makes it a greeting rather than a
  // changed `idle` file: a turn in flight when the orb opens still opens with it.
  ['a turn running, greeting up', { running: true }, { mode: 'arrive-1', src: 'ARRIVE' }],
  ['a reply streaming, greeting up', { agentState: 'replying', replySrc: 'REPLY' },
    { mode: 'arrive-1', src: 'ARRIVE' }],
]

let bad = 0
for (const [label, input, expected] of CASES) {
  const { mode, src } = show(input)
  const ok = mode === expected.mode && src === expected.src
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(28)} -> ${String(mode).padEnd(9)} ${src}`)
  if (!ok) {
    console.log(`      *** expected ${expected.mode} ${expected.src}`)
    bad += 1
  }
}

// A pack that names no arrival: the ball opens on its resting loop, and the branch that would
// have shown a greeting must cost nothing. `arriveShown` is simply never set.
console.log('\nthe same page in a pack that names no arrival:')
for (const [label, input] of [['idle', {}], ['expanded', { expanded: true }]]) {
  const { mode, src } = show({ ...input, arriveShown: undefined })
  const ok = mode === 'idle' && src === 'IDLE'
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(28)} -> ${String(mode).padEnd(9)} ${src}`)
  if (!ok) bad += 1
}

// The branch has to sit above the resting loop, or the greeting is never seen: that is the whole
// difference between this feature and a changed `idle` frame. Both markers are required to be
// there — `indexOf` answers -1 for a branch that was deleted, and -1 is below every position, so a
// missing branch would otherwise pass this check for exactly the wrong reason. That is not theoretical:
// the resting branch used to be spelled `gif.dataset.mode !== 'idle'`, the poor face rewrote it as the
// two-way choice below, and this check has to fail loudly rather than compare against a position that
// no longer exists. It did.
const branch = source.indexOf('arriveShown !== undefined')
const loop = source.indexOf('if (broke || idleSrc !== undefined)')
const ordering = branch !== -1 && loop !== -1 && branch < loop
console.log(`${ordering ? 'ok  ' : 'FAIL'}  the greeting is decided above the resting loop`)
if (!ordering) bad += 1

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
