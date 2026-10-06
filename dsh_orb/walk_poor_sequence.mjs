/**
 * Walk the *installed* page through the resting face's whole decision, with the real predicate.
 *
 * The poor face is not a cue and not a state of its own: it is the resting loop, chosen against a
 * number the host pushes. That makes the decision the feature, and this is where it is walked — with
 * `brokeNow` cut out of the installed `shell.js` rather than restubbed, because the interesting cases
 * are all about what the predicate does with a balance it cannot use:
 *
 *   * a known balance above the line keeps the ordinary loop, and one below the line does not;
 *   * `null` — the host's word for "not known" — keeps the ordinary loop, which is the difference
 *     between a signed-out machine and a broke one;
 *   * a pack that names no poor frame is unaffected whatever the balance says;
 *   * the two faces are different `dataset.mode` values, or the swap would not repaint the `<img>`;
 *   * an event cue and the nap still outrank the resting loop, poor or not.
 *
 * Everything is read from the installed bundle rather than the source tree: a build that dropped the
 * branch would pass every unit test and show the wrong face for ever.
 *
 * Each case rebuilds the closure, because `syncGif` captures its state as `const`s at construction.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
  'dist', 'helper', 'assets', 'shell.js')
const source = readFileSync(SHELL, 'utf8')

/**
 * The live configuration's own line, in CNY, used as the default for every case below.
 *
 * Read rather than written here: the number is a preference somebody will change (it has been 60 and
 * then 5), and a walk whose cases carry a stale line of their own reports the wrong verdict the moment
 * it moves — which is exactly what happened when the line went to 5 and this file still compared
 * against 60. Cases that are *about* the line pass their own.
 */
const LIVE_LINE = JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-orb', 'memes.json'), 'utf8')).poor?.below
const LINE = typeof LIVE_LINE === 'number' && LIVE_LINE > 0 ? LIVE_LINE : 5

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
          clickShown, arriveShown, wakeShown, doneShown, typingSrc, replySrc, toolSrc, thinkingSrc,
          speakSrc, speakActive, voiceSrc, dictationPhase, dropShown, webfetchSrc, agentState,
          agentTool, idleSrc, poorSrc, balanceCny, poorBelow, hoverSrc, hoverIntroSrc, introUntil,
          hovering, napShown, sleepFrameAt, skitInfo, skitFrame, running, asking, tccGateVisible,
          attachedSelection, expanded, avatarSrc, freezeGif, Date, WEB_FETCH_TOOL, TYPING_HOLD_MS,
          typingAt } = deps
  ${pageFunction('brokeNow')}
  ${pageFunction('syncGif')}
  return { syncGif, brokeNow }
`)

/** What the ball would show for one page state, with every pose this walk is not about disarmed. */
function show(options = {}) {
  const gif = { dataset: {}, src: undefined }
  const built = build({
    document: { querySelector: () => gif, body: { classList: { contains: () => false } } },
    pageClosed: () => false, syncSleep: () => {},
    dragging: false, dragSrc: 'DRAG', dragIntroSrc: undefined, dragIntroUntil: 0,
    clickShown: options.clickShown, arriveShown: undefined, wakeShown: undefined, doneShown: undefined,
    typingSrc: undefined, replySrc: undefined, toolSrc: 'TOOL', thinkingSrc: undefined,
    speakSrc: undefined, speakActive: false, voiceSrc: undefined, dictationPhase: 'idle',
    dropShown: undefined, webfetchSrc: undefined, agentState: '', agentTool: '',
    // `'x' in options` rather than a default, because `undefined` and `null` are both cases under
    // test here: one is "no poor frame in the pack", the other is "the host does not know".
    idleSrc: 'IDLE',
    poorSrc: 'poorSrc' in options ? options.poorSrc : 'POOR',
    balanceCny: 'balanceCny' in options ? options.balanceCny : LINE + 500,
    poorBelow: 'poorBelow' in options ? options.poorBelow : LINE,
    hoverSrc: undefined, hoverIntroSrc: undefined, introUntil: 0, hovering: false,
    // The nap branch asks `sleepFrameAt()` for the frame the timeline is on, so a nap case is a
    // frame rather than a flag: `napShown` is only the clock's own record of it.
    napShown: options.napShown, sleepFrameAt: () => options.nap, skitInfo: undefined,
    skitFrame: options.skitFrame,
    running: false, asking: () => false, tccGateVisible: false,
    attachedSelection: '', expanded: options.expanded === true, avatarSrc: 'AVATAR',
    freezeGif: () => {}, Date,
    WEB_FETCH_TOOL: 'web_fetch', TYPING_HOLD_MS: 3000, typingAt: 0,
  })
  built.syncGif()
  const broke = built.brokeNow()
  return { mode: gif.dataset.mode, src: gif.src, broke }
}

let bad = 0
const check = (label, actual, expected) => {
  const ok = actual.mode === expected.mode && actual.src === expected.src
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(46)} -> ${String(actual.mode).padEnd(8)} ${actual.src}`)
  if (!ok) {
    console.log(`      *** expected ${expected.mode} ${expected.src}`)
    bad += 1
  }
}

// The live configuration's own line is the default for every case, so this reads as a walk of what
// the ball does rather than of a number invented here. `poorBelow` travels with each case, so the walk
// itself works at any line.
console.log(`the resting face against the balance the host pushed (line ${LINE} CNY):`)
check(`${LINE + 500} is well above it`, show({ balanceCny: LINE + 500 }), { mode: 'idle', src: 'IDLE' })
check(`${LINE}, exactly the line, is not below it`, show({ balanceCny: LINE }), { mode: 'idle', src: 'IDLE' })
check(`${LINE - 0.01} is below it`, show({ balanceCny: LINE - 0.01 }), { mode: 'poor', src: 'POOR' })
check('0.00 is below it', show({ balanceCny: 0 }), { mode: 'poor', src: 'POOR' })
check('null (not known) keeps the ordinary loop', show({ balanceCny: null }), { mode: 'idle', src: 'IDLE' })
check('a line of 0 can never be undercut', show({ balanceCny: 0, poorBelow: 0 }), { mode: 'idle', src: 'IDLE' })

console.log('\na pack that names no poor frame is unaffected:')
check('a broke account, no poor frame', show({ balanceCny: 0, poorSrc: undefined }), { mode: 'idle', src: 'IDLE' })

console.log('\nthe two faces are different modes, or the swap would not repaint:')
// `syncGif` only assigns `src` when `dataset.mode` changes, so one mode for both faces means a ball
// that keeps its old GIF: the poor frame would never appear, and the ordinary one never come back.
const idleMode = show({ balanceCny: LINE + 500 }).mode
const poorMode = show({ balanceCny: Math.max(0, LINE - 1) }).mode
const distinct = idleMode !== poorMode
console.log(`${distinct ? 'ok  ' : 'FAIL'}  idle wears '${idleMode}', poor wears '${poorMode}'`)
if (!distinct) bad += 1
// The repaint itself: coming back to the same balance has to actually hand the image back.
const returned = show({ balanceCny: LINE + 500, dataset: { mode: 'poor' } })
check('a top-up repaints the ordinary loop', returned, { mode: 'idle', src: 'IDLE' })

console.log('\nthe resting loop is still the lowest thing on the ball:')
check('a click wins over a broke account', show({ balanceCny: Math.max(0, LINE - 1), clickShown: { src: 'CLICK', step: 1 } }),
  { mode: 'click-1', src: 'CLICK' })
check('a nap wins over a broke account', show({ balanceCny: Math.max(0, LINE - 1), nap: { mode: 'sleep-1', src: 'NAP' } }),
  { mode: 'sleep-1', src: 'NAP' })
check('a skit wins over a broke account', show({ balanceCny: Math.max(0, LINE - 1), skitFrame: { src: 'SKIT', step: 1 } }),
  { mode: 'skit-1', src: 'SKIT' })

console.log('\nan open panel with no idle loop still wears the poor face:')
// `play` (the avatar) is what a panel shows when there is no resting loop to show instead — and the
// poor face is a resting loop, so a pack that names only that one must not fall back to the avatar.
check('panel open, broke, only a poor frame',
  show({ balanceCny: Math.max(0, LINE - 1), idleSrc: undefined, expanded: true }),
  { mode: 'poor', src: 'POOR' })

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
