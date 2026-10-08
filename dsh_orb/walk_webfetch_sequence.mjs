/**
 * Walk the *installed* `syncGif` through the state sequence this feature exists for.
 *
 * The unit tests already pin each branch in isolation against the source tree. What they cannot
 * do is show the sequence as the user meets it: one turn that fetches a page, then runs a command,
 * then searches, then starts answering. Each of those is `tooling` or `replying`, and the whole
 * question is whether the face changes at the right moments and holds still at the wrong ones.
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
  const { document, pageClosed, syncSleep, dragging, clickShown, arriveShown, wakeShown, doneShown, failShown, askShown, typingSrc,
          replySrc, toolSrc, thinkingSrc, speakSrc, speakActive, voiceSrc, dictationPhase,
          dropShown, dropStep, webfetchSrc, agentState, agentTool, idleSrc, hoverSrc, introTimer,
          napShown, skitInfo, running, asking, tccGateVisible, attachedSelection, expanded,
          avatarSrc, freezeGif, Date, sleepFrameAt, skitFrame, hoverIntroSrc, introUntil, hovering,
          WEB_FETCH_TOOL, TYPING_HOLD_MS, typingAt, brokeNow } = deps
  ${body}
  return syncGif
`)

/**
 * What the ball would show for one (phase, tool) pair, with every other pose disarmed.
 *
 * The options object is read with `'x' in options` rather than destructured, because a
 * destructuring default fires on an explicit `undefined` — and the case that matters most here is
 * exactly `show({ webfetchSrc: undefined })`, "this pack names no fetch face". Destructured, that
 * call would get the frame back and the fallback would report itself broken.
 */
function show(options = {}) {
  const { state = '', tool = '', toolSrc = 'TOOL' } = options
  const webfetchSrc = 'webfetchSrc' in options ? options.webfetchSrc : 'WEBFETCH'
  const gif = { dataset: {}, src: undefined }
  build({
    document: { querySelector: () => gif, body: { classList: { contains: () => false } } },
    pageClosed: () => false, syncSleep: () => {}, dragging: false,
    clickShown: undefined, arriveShown: undefined, wakeShown: undefined, doneShown: undefined,
    failShown: undefined, askShown: undefined,
    typingSrc: undefined, replySrc: undefined, toolSrc, thinkingSrc: undefined,
    speakSrc: undefined, speakActive: false, voiceSrc: undefined, dictationPhase: 'idle',
    dropShown: undefined, dropStep: 0,
    webfetchSrc,
    agentState: state, agentTool: tool,
    idleSrc: 'IDLE', hoverSrc: undefined, introTimer: undefined, napShown: undefined,
    skitInfo: undefined, running: false, asking: () => false, tccGateVisible: false,
    attachedSelection: '', expanded: false, avatarSrc: 'AVATAR', freezeGif: () => {}, Date,
    sleepFrameAt: () => undefined, skitFrame: undefined, hoverIntroSrc: undefined,
    introUntil: 0, hovering: false, WEB_FETCH_TOOL: 'web_fetch', TYPING_HOLD_MS: 3000, typingAt: 0,
    // The poor face is off: this walk is about the tool faces. `walk_poor_sequence.mjs` walks the
    // real predicate against the same installed page.
    brokeNow: () => false,
  })()
  return { mode: gif.dataset.mode, src: gif.src }
}

// One turn, in the order the agent actually does these: look something up, pull the page, run a
// command, look up another thing, then answer.
const SEQUENCE = [
  ['idle', {}],
  ['web_fetch starts', { state: 'tooling', tool: 'web_fetch' }],
  ['bash runs next', { state: 'tooling', tool: 'bash' }],
  ['web_search runs', { state: 'tooling', tool: 'web_search' }],
  ['a second web_fetch', { state: 'tooling', tool: 'web_fetch' }],
  ['the answer streams', { state: 'replying', tool: '' }],
  ['back to a fetch', { state: 'tooling', tool: 'web_fetch' }],
  ['tooling, name unknown', { state: 'tooling', tool: '' }],
]

let bad = 0
for (const [label, input] of SEQUENCE) {
  const { mode, src } = show(input)
  console.log(label.padEnd(24), '->', String(mode).padEnd(9), src)
  const expected = input.state === 'tooling'
    ? (input.tool === 'web_fetch' ? 'webfetch' : 'tool')
    : input.state === 'replying' ? 'idle' : 'idle'
  if (mode !== expected) {
    console.log(`   *** expected ${expected}`)
    bad += 1
  }
}

console.log('\nthe fetch face in a pack that names none of it:')
for (const tool of ['web_fetch', 'bash']) {
  const { mode, src } = show({ state: 'tooling', tool, webfetchSrc: undefined })
  console.log(String(tool).padEnd(24), '->', String(mode).padEnd(9), src)
  if (mode !== 'tool' || src !== 'TOOL') {
    console.log('   *** a fetch in an unconfigured pack should keep the shared tool face')
    bad += 1
  }
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
