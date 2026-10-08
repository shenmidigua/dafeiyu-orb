/**
 * The face worn for words arriving in a conversation this ball is not in.
 *
 * The ball used to react only to its own session: its turn state, its transcript, its bell. The DSH window
 * the user actually reads in is a different session, so an answer being written there was invisible to it.
 * The host now forwards that fact — never the words — on `orb:session-turn`, and the page opens a window for
 * it. This file is about the page's half: which face that window wears, for how long, and what it must not
 * disturb.
 *
 * `syncGif` is compiled out of the page, as the other page tests do, because the branch order *is* the
 * behaviour: "the ball's own answer wins" is a claim about two `if`s being in a particular order, and only
 * the real function can be asked about it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
const host = readFileSync(join(here, '../../host/src/orb.ts'), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching. */
function pageFunction(name: string): string {
  const found = new RegExp(`(?:^|[^\\w$])(?:async )?function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = found.index
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let index = open; index < shell.length; index += 1) {
    if (shell[index] === '{') depth += 1
    else if (shell[index] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, index + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const REPLY = 'data:image/gif;base64,REPLY'
const THINKING = 'data:image/gif;base64,THINKING'
const TOOL = 'data:image/gif;base64,TOOL'
/** The face the pack drew for `pwsh`, which has to be distinguishable from the shared one to be a test. */
const READ = 'data:image/gif;base64,READ'
const IDLE = 'data:image/gif;base64,IDLE'
/** The page's own window, read out of the page so a change to it cannot leave this file passing. */
const HOLD_MS = Number(/const OTHER_STREAM_HOLD_MS = (\d+)/.exec(shell)?.[1] ?? 0)
const WORK_MS = Number(/const OTHER_WORK_HOLD_MS = (\d+)/.exec(shell)?.[1] ?? 0)

interface Gif {
  dataset: { mode?: string }
  src: string | undefined
}

/**
 * Paint the ball once with only the two things this file is about, and report what it chose.
 *
 * Everything else is disarmed rather than stubbed with a sentinel: a change that moves a new branch above
 * this one has to show up here as a different answer, not as a silent behaviour change in the orb.
 */
function paint(options: {
  agentState?: string
  typingAt?: number
  thinkingAt?: number
  toolAt?: number
  toolSrc?: string
  /** The tool another conversation is calling, as the host reports it. */
  otherTool?: string
  /**
   * The hold the page keeps between repaints, as `{ mode, until }`.
   *
   * Passed in rather than owned here, because the rule being tested is what happens *across* two repaints: a
   * face goes up, the call ends, and the next repaint has to leave it alone for a moment. A fresh object per
   * call would test nothing.
   */
  hold?: { mode: string; until: number }
}): Gif {
  // The page keeps one window per kind; this file only ever needs the three it is about.
  const windows = new Map<string, number>()
  if (options.typingAt !== undefined) windows.set('typing', options.typingAt)
  if (options.thinkingAt !== undefined) windows.set('thinking', options.thinkingAt)
  if (options.toolAt !== undefined) windows.set('tool', options.toolAt)
  const gif: Gif = { dataset: {}, src: undefined }
  const factory = new Function('deps', `
    const {
      document, pageClosed, syncSleep, dragging, dragSrc, dropShown, dockArriveShown, clickShown, arriveShown,
      wakeShown, doneShown, failShown, askShown, typingSrc, replySrc, thinkingSrc, toolSrc, speakSrc,
      voiceSrc, dictationPhase, idleSrc, hoverSrc, agentState, agentTool, brokeNow,
      introTimer, napShown, skitInfo, running, asking, tccGateVisible, attachedSelection, expanded,
      avatarSrc, freezeGif, Date, sleepFrameAt, skitFrame, hoverIntroSrc, introUntil, hovering,
      typingAt, TYPING_HOLD_MS, speakActive, otherStreamAt, OTHER_STREAM_HOLD_MS, OTHER_WORK_HOLD_MS,
      toolFrames, otherTool, toolFaceHoldState, docked, dockedAt
    } = deps
    ${pageFunction('syncGif')}
    return syncGif
  `)
  const run = factory({
    document: { querySelector: () => gif },
    pageClosed: () => false,
    syncSleep: () => {},
    dragging: false,
    dragSrc: undefined,
    dropShown: undefined,
    dockArriveShown: undefined,
    clickShown: undefined,
    arriveShown: undefined,
    wakeShown: undefined,
    doneShown: undefined,
    failShown: undefined,
    askShown: undefined,
    typingSrc: undefined,
    typingAt: 0,
    TYPING_HOLD_MS: 3000,
    replySrc: REPLY,
    thinkingSrc: THINKING,
    toolSrc: options.toolSrc ?? TOOL,
    speakSrc: undefined,
    speakActive: false,
    voiceSrc: undefined,
    dictationPhase: 'idle',
    agentState: options.agentState ?? '',
    agentTool: '',
    idleSrc: IDLE,
    hoverSrc: undefined,
    hoverIntroSrc: undefined,
    introUntil: 0,
    hovering: false,
    introTimer: undefined,
    napShown: undefined,
    skitInfo: undefined,
    skitFrame: undefined,
    sleepFrameAt: () => undefined,
    running: false,
    asking: () => false,
    tccGateVisible: false,
    attachedSelection: '',
    expanded: false,
    avatarSrc: 'data:image/gif;base64,AVATAR',
    freezeGif: () => {},
    brokeNow: () => false,
    Date,
    otherStreamAt: windows,
    otherTool: options.otherTool ?? '',
    toolFaceHoldState: options.hold ?? { mode: '', until: 0 },
    // The pack's answers: `pwsh` was drawn apart, `grep` was not — a cached `null` means exactly that.
    toolFrames: new Map([['pwsh', 'data:image/gif;base64,READ'], ['grep', null]]),
    OTHER_STREAM_HOLD_MS: HOLD_MS,
    OTHER_WORK_HOLD_MS: WORK_MS,
    // Left `undefined` rather than `false`: the page's own convention is that a *named* dock means the ball is
    // in its strip and nothing below paints, so `undefined` is the state this file wants — the ball on screen.
    docked: undefined,
    dockedAt: 0
  }) as () => void
  run()
  // "Nothing painted" is a real answer here, and the one the tool-face hold produces: the face is already on
  // the ball and the hold is what keeps it there, so a repaint that changes nothing is the rule working rather
  // than a branch falling through. Every other case still has to paint, which is what this check is for.
  if (options.hold === undefined || options.hold.mode === '') {
    assert.notEqual(gif.dataset.mode, undefined, 'syncGif fell through every branch without painting')
  }
  return gif
}

describe('the face for words arriving in another conversation', () => {
  it('reads a window out of the page at all', () => {
    assert.ok(HOLD_MS > 0, 'OTHER_STREAM_HOLD_MS is missing from the page, so this file proves nothing')
  })

  it('types along while the words are arriving', () => {
    const painted = paint({ typingAt: Date.now() })
    assert.equal(painted.dataset.mode, 'reply-elsewhere', 'words written in the DSH window no longer reach the ball')
    assert.equal(painted.src, REPLY, 'the typing face was chosen but another image was worn')
  })

  it('gives the resting loop back once they stop', () => {
    const painted = paint({ typingAt: Date.now() - HOLD_MS - 1_000 })
    assert.notEqual(painted.dataset.mode, 'reply-elsewhere', 'the typing face outlived the window it is held by')
    assert.equal(painted.dataset.mode, 'idle')
  })

  it('takes the face off the moment the host says the answer is written', () => {
    // The window is a fallback, not the mechanism: from this side one message looks like any other, and there
    // is nothing to count down. The host does know when the attempt ends and says so — so the ball has to stop
    // typing when the words do, rather than sitting there for the rest of the grace period.
    assert.match(shell, /outcome === 'streamed'[\s\S]{0,140}otherStreamAt\.clear\(\)/,
      'the page no longer closes the window when the stream ends')
    // And the host has that ending to send. It has to be handled *before* the session test throws the frame
    // away, which is the ordering mistake this pins: put it after, and another session's ending is dropped.
    const handler = host.slice(host.indexOf('private onAssistantStream'))
    const endAt = handler.indexOf("frame.type === 'end'")
    const foreignAt = handler.indexOf('session?.id !== this.sessionId')
    assert.notEqual(endAt, -1, 'the host no longer looks at the end frame')
    assert.ok(foreignAt === -1 || endAt < foreignAt,
      'the end frame is handled after the session test, so another session\u2019s ending is thrown away')
    assert.match(host, /announceOtherStreamEnded\(\)/, 'nothing tells the ball that the writing stopped')
  })

  it('leaves this page\u2019s own turn alone', () => {
    // `agentState` is *this* page's turn — its clock, its tool cards, its bell. Another conversation's stream
    // must not move it, and that is why the windows above are their own state rather than a turn flag.
    const same = paint({ agentState: 'replying', typingAt: Date.now() })
    const stale = paint({ agentState: 'replying' })
    assert.equal(same.dataset.mode, stale.dataset.mode, 'the elsewhere window changed what this page\u2019s own turn wears')
    assert.equal(same.dataset.mode, 'reply', 'this page\u2019s own answer no longer wins over somebody else\u2019s')
  })

  it('wears the face of the work, not the face of writing, for work that is not writing', () => {
    // The reason this file has one window per kind. A turn reasons, writes, then calls a tool, and each of
    // those is its own event with its own face — the ball must not type while the answer is being thought
    // about, and must not sit still while it is being thought about either.
    assert.ok(WORK_MS > 0, 'OTHER_WORK_HOLD_MS is missing from the page, so the other kinds have nowhere to be kept')
    const thinking = paint({ thinkingAt: Date.now() })
    assert.equal(thinking.dataset.mode, 'thinking-elsewhere', 'reasoning elsewhere no longer shows the reasoning face')
    assert.equal(thinking.src, THINKING, 'the reasoning face was chosen but another image was worn')
    const tool = paint({ toolAt: Date.now() })
    assert.equal(tool.dataset.mode, 'tool-elsewhere', 'a call elsewhere no longer shows the tool face')
    assert.equal(tool.src, TOOL)
  })

  it('wears the face a pack drew for the tool another conversation is calling', () => {
    // The name has to come over the wire, because the ball's transcript is not that conversation and has no tool
    // card to read it from — which is exactly why a per-tool mapping worked in the ball's own panel and did
    // nothing in the window the user types in. Both halves are pinned: a listed tool wears its own face, and an
    // unlisted one keeps the shared face.
    const listed = paint({ toolAt: Date.now(), otherTool: 'pwsh' })
    assert.equal(listed.dataset.mode, 'tool-named-elsewhere:pwsh', 'a listed tool kept the shared face over there')
    assert.equal(listed.src, READ, 'the shared face was worn for a tool the pack named')
    const unlisted = paint({ toolAt: Date.now(), otherTool: 'grep' })
    assert.equal(unlisted.dataset.mode, 'tool-elsewhere', 'an unlisted tool took a face that was never drawn for it')
    assert.equal(unlisted.src, TOOL, 'an unlisted tool did not wear the shared face')
    // And a host that says nothing keeps the old behaviour, because an old host is a supported one.
    assert.equal(paint({ toolAt: Date.now() }).dataset.mode, 'tool-elsewhere', 'a nameless call stopped wearing the shared face')
  })

  it('keeps a tool face up long enough to be seen, even when the call is instant', () => {
    // The report was that the same tool sometimes played its animation and sometimes did not, and the cause was
    // that the frames run about a second while a command can finish in ten milliseconds. Without the floor the
    // face is painted and replaced inside one repaint, which is indistinguishable from never painting it.
    const hold = { mode: '', until: 0 }
    const during = paint({ toolAt: Date.now(), otherTool: 'pwsh', hold })
    assert.equal(during.dataset.mode, 'tool-named-elsewhere:pwsh', 'the tool face was not the one worn while it ran')

    // The call is over: the window has closed and nothing has taken its place yet. The face stays — which shows
    // up as a repaint that paints nothing, because the ball is already wearing the right picture.
    const justAfter = paint({ hold })
    assert.equal(justAfter.dataset.mode, undefined, 'the matching face went back up, so the clip restarted from its first frame')
    assert.equal(during.dataset.mode, 'tool-named-elsewhere:pwsh', 'the face that is being held is not the tool face')

    // And the hold is a delay, never a veto: once it is up, the resting loop has the ball back.
    hold.until = 0
    assert.equal(paint({ hold }).dataset.mode, 'idle', 'the tool face outlived its hold')
  })

  it('ranks the kinds, and this page\u2019s own turn above all of them', () => {
    // The order is the semantics, so it is checked rather than assumed. Among the kinds it is this page's own
    // order — the page puts `reply` above `tool` above `thinking`, and the elsewhere faces follow it, so the
    // same turn wearing two of them at once reads the same way on both sides. Above all of them is what this
    // page is doing itself.
    const both = paint({ typingAt: Date.now(), thinkingAt: Date.now() })
    assert.equal(both.dataset.mode, 'reply-elsewhere', 'a thought arriving alongside words took the face off the words')
    assert.equal(paint({ thinkingAt: Date.now(), toolAt: Date.now() }).dataset.mode, 'tool-elsewhere',
      'reasoning outranked a call, which this page does not do either')
    assert.equal(paint({ agentState: 'thinking', thinkingAt: Date.now() }).dataset.mode, 'thinking',
      'somebody else\u2019s reasoning outranked this page\u2019s own')
    assert.equal(paint({ agentState: 'tooling', toolAt: Date.now() }).dataset.mode, 'tool',
      'somebody else\u2019s call outranked this page\u2019s own')
  })

  it('is wired from the host through to the page', () => {
    // Three layers, and a slot missing from any of them fails silently — the ball simply never moves.
    assert.match(main, /record\.type === 'session-turn'/, 'the helper no longer forwards the message')
    assert.match(main, /win\.webContents\.send\('orb:session-turn'/, 'and does not put it on a channel')
    assert.match(preload, /onSessionTurn\(callback\)\s*\{[\s\S]*?ipcRenderer\.on\('orb:session-turn'/,
      'the preload no longer exposes it')
    assert.match(shell, /api\.onSessionTurn\(\(payload\) => \{[\s\S]*?otherStreamAt\.set\(outcome, Date\.now\(\)\)/,
      'the page no longer opens a window when the news arrives')
    // The host has to say *which* kind, or the page cannot tell writing from thinking.
    assert.match(host, /function streamNews\(/, 'the host no longer classifies stream frames')
    assert.match(host, /chunk\.type === 'text-delta'[\s\S]{0,40}kind: 'typing'/, 'text is no longer the writing kind')
    assert.match(host, /chunk\.type === 'reasoning-delta'[\s\S]{0,40}kind: 'thinking'/, 'reasoning is no longer its own kind')
    // A tool call arrives two ways and both have to be recognised. Watching only the streamed-arguments case is
    // how a ten-second call came to produce no frames at all: the arguments were handed over as one block.
    assert.match(host, /chunk\.type === 'tool-call-delta'\)[\s\S]{0,160}kind: 'tool'/, 'streamed tool arguments are no longer a call')
    assert.match(host, /chunk\.type === 'block-start' \|\| chunk\.type === 'block-end'[\s\S]{0,220}kind: 'tool'/,
      'a tool call handed over as a whole block is no longer recognised as a call')
    // And it has to pass the tool's *name* on, or a pack's per-tool faces are unreachable from the window the
    // user actually types in — which is where they were reported missing, while working in the ball's panel.
    assert.match(host, /tool: name/, 'the tool name no longer rides along with the call')
    assert.match(host, /announceOtherStream\(news\.kind,[\s\S]{0,60}news\.tool\)/, 'the name is no longer handed to the announcer')
    assert.match(host, /session-turn', outcome: kind, sessionId[\s\S]{0,40}tool/, 'the name is no longer broadcast')
    assert.match(shell, /outcome === 'tool' && typeof payload\?\.tool === 'string'/, 'the page no longer reads the name')
    assert.match(shell, /namedOtherTool !== '' \? namedToolFaces\.get\(namedOtherTool\)/, 'the other conversation\u2019s call no longer looks up its own face')
  })
})
