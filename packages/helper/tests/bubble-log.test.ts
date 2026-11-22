/**
 * The bubble's conversation: two columns of chat bubbles.
 *
 * The conversation itself happens in the main window, so the ball's own transcript is usually empty
 * and the card used to look like it did nothing. What it shows now is both sides of that exchange —
 * the greeting the clip says ("我在"), the sentence just dictated, the answer being written or read
 * aloud — the way a chat app does it: the user's words on the right, the ball's on the left.
 *
 * The functions are compiled out of the page the same way `other-stream.test.ts` compiles `syncGif`,
 * because the rules that matter here (one bubble per message, a stream that grows in place instead
 * of pushing a bubble per chunk, a docked ball that is not pulled out for a message) are claims
 * about the real code, not about a copy of it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const markup = readFileSync(join(here, '../assets/floating.html'), 'utf8')
const styles = readFileSync(join(here, '../assets/floating.css'), 'utf8')
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

/** The numbers the page uses, read out of the page so a change there cannot leave this file passing. */
const ROWS = Number(/const BUBBLE_LOG_ROWS = (\d+)/.exec(shell)?.[1] ?? 0)
const CHARS = Number(/const BUBBLE_LOG_CHARS = (\d+)/.exec(shell)?.[1] ?? 0)
const STATUS_MS = Number(/const BUBBLE_STATUS_MS = (\d+)/.exec(shell)?.[1] ?? 0)
const TWIN_MS = Number(/const BUBBLE_TWIN_MS = (\d+)/.exec(shell)?.[1] ?? 0)
/** The fold toggle's two labels, read out of the Chinese table so a reworded label cannot leave this passing. */
const MORE = /bubbleMore: '(.+?)'/.exec(shell)?.[1] ?? ''
const LESS = /bubbleLess: '(.+?)'/.exec(shell)?.[1] ?? ''

/** The smallest DOM the page's own code can be run against. */
class FakeNode {
  parent: FakeNode | undefined
  children: FakeNode[] = []
  hidden = false
  scrollTop = 0
  className = ''
  nodeType = 1
  type = ''
  dataset: Record<string, string> = {}
  textContent = ''
  /** The attributes the fold toggle reads and writes (`data-open`, `aria-expanded`). */
  attrs = new Set<string>()
  listeners: Record<string, Array<(event?: unknown) => void>> = {}

  constructor(readonly tag: string) {}

  get scrollHeight(): number {
    return 0
  }

  get childElementCount(): number {
    return this.children.length
  }

  get firstElementChild(): FakeNode | undefined {
    return this.children[0]
  }

  /** The real name for what `parent` holds: the page walks `anchorNode.parentNode` to find the row. */
  get parentNode(): FakeNode | undefined {
    return this.parent
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  setAttribute(name: string): void {
    this.attrs.add(name)
  }

  toggleAttribute(name: string, force?: boolean): boolean {
    const next = force ?? !this.attrs.has(name)
    if (next) this.attrs.add(name)
    else this.attrs.delete(name)
    return next
  }

  addEventListener(type: string, handler: (event?: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(handler)
  }

  /** Fire what a browser would fire, so the test runs the page's own handler rather than guessing. */
  fire(type: string, event?: unknown): void {
    for (const handler of this.listeners[type] ?? []) handler(event)
  }

  append(node: FakeNode): void {
    node.remove()
    node.parent = this
    this.children.push(node)
  }

  remove(): void {
    if (this.parent === undefined) return
    const index = this.parent.children.indexOf(this)
    if (index >= 0) this.parent.children.splice(index, 1)
    this.parent = undefined
  }

  replaceChildren(): void {
    for (const child of this.children) child.parent = undefined
    this.children = []
  }

  contains(node: FakeNode | null | undefined): boolean {
    if (node === null || node === undefined) return false
    if (node === this) return true
    return this.children.some((child) => child.contains(node))
  }
}

/** Every message drawn, newest last, as `role:text`. */
function drawn(log: FakeNode): string[] {
  return log.children.map((row) => `${row.dataset.role ?? ''}:${row.children[0]?.textContent ?? ''}`)
}

interface Sandbox {
  log: FakeNode
  /** How many times the card was opened by a message. */
  opened: number
  push: (role: string, text: unknown) => void
  status: (text: unknown, hold?: number) => void
  append: (text: unknown) => void
  settle: () => void
  clear: () => void
  /** The turn boundary the page calls on a new greeting or a new sentence of the user's. */
  turn: () => void
}

/**
 * Build the conversation over a fake log node.
 *
 * `docked` and `asking` are inputs because they are the two states the open rule is about: the page's
 * own convention is that a *named* dock means the ball is behind its strip, so `undefined` is "on screen".
 */
function sandbox(options: { expanded?: boolean; docked?: string; asking?: boolean; autoExpand?: boolean } = {}): Sandbox {
  const log = new FakeNode('div')
  log.hidden = true
  const counts = { opened: 0 }
  const document = { createElement: (tag: string) => new FakeNode(tag) }
  const factory = new Function('deps', `
    const {
      bubbleLog, document, expanded, asking, docked, setExpanded, setTimeout, clearTimeout, wake, Date, messages,
      BUBBLE_LOG_ROWS, BUBBLE_LOG_CHARS, BUBBLE_STATUS_MS, BUBBLE_TWIN_MS
    } = deps
    // The page keeps these as block-scoped \`let\`s beside the functions; declared here so the
    // functions below share one binding, exactly as they do in the page.
    let bubbleLogTimer
    let bubbleStatusRow
    let bubbleStreamRow
    let bubbleStream = ''
    let bubbleStreamText = ''
    let bubbleStreamAt = 0
    let bubbleTurnBalls = []
    ${pageFunction('oneLine')}
    ${pageFunction('clipBubble')}
    ${pageFunction('followBubbleLog')}
    ${pageFunction('trimBubbleLog')}
    ${pageFunction('createBubble')}
    ${pageFunction('dropBubbleStatus')}
    ${pageFunction('showBubbleStatus')}
    ${pageFunction('foldBubbleRow')}
    ${pageFunction('beginBubbleTurn')}
    ${pageFunction('registerBubbleRow')}
    ${pageFunction('pushBubble')}
    ${pageFunction('clearBubbleLog')}
    ${pageFunction('openBubbleForLine')}
    ${pageFunction('appendBubbleStream')}
    ${pageFunction('settleBubbleStream')}
    return { pushBubble, showBubbleStatus, appendBubbleStream, settleBubbleStream, clearBubbleLog, beginBubbleTurn }
  `)
  const run = factory({
    bubbleLog: log,
    document,
    expanded: options.expanded === true,
    asking: () => options.asking === true,
    docked: options.docked,
    messages: { bubbleMore: MORE, bubbleLess: LESS },
    // The profile's own "may the card open by itself"; `undefined` is the page's default (on).
    wake: { autoExpand: () => options.autoExpand !== false },
    setExpanded: (next: boolean) => {
      counts.opened += 1
      return Promise.resolve(next)
    },
    setTimeout,
    clearTimeout,
    Date,
    BUBBLE_LOG_ROWS: ROWS,
    BUBBLE_LOG_CHARS: CHARS,
    BUBBLE_STATUS_MS: STATUS_MS,
    BUBBLE_TWIN_MS: TWIN_MS
  }) as {
    pushBubble: (role: string, text: unknown) => void
    showBubbleStatus: (text: unknown, hold?: number) => void
    appendBubbleStream: (text: unknown) => void
    settleBubbleStream: () => void
    clearBubbleLog: () => void
    beginBubbleTurn: () => void
  }
  return {
    log,
    get opened() {
      return counts.opened
    },
    push: run.pushBubble,
    status: run.showBubbleStatus,
    append: run.appendBubbleStream,
    settle: run.settleBubbleStream,
    clear: run.clearBubbleLog,
    turn: run.beginBubbleTurn
  }
}

describe('the bubble conversation', () => {
  it('draws your words on the right and the ball\'s on the left', () => {
    const page = sandbox()
    page.push('me', '帮我看看这个报错')
    page.push('ball', '是哪一行？')
    assert.deepEqual(drawn(page.log), ['me:帮我看看这个报错', 'ball:是哪一行？'])
    // Both sides in one list: that is the whole point of the change.
    assert.equal(page.log.children.length, 2)
    assert.equal(page.log.hidden, false)
  })

  it('keeps the order of a whole exchange, greeting first', () => {
    const page = sandbox()
    page.push('ball', '我在。')
    page.push('me', '现在几点')
    page.push('ball', '现在下午三点整。')
    assert.deepEqual(drawn(page.log), ['ball:我在。', 'me:现在几点', 'ball:现在下午三点整。'])
  })

  it('drops the oldest messages instead of growing without end', () => {
    const page = sandbox()
    for (let index = 0; index < ROWS + 3; index += 1) page.push('ball', `第${index}句`)
    assert.equal(page.log.children.length, ROWS)
    // The window slid: the newest line is still last, the first three are gone.
    assert.equal(drawn(page.log)[0], 'ball:第3句')
    assert.equal(drawn(page.log).at(-1), `ball:第${ROWS + 2}句`)
  })

  it('collapses runs of whitespace, because a rendered reply is full of them', () => {
    const page = sandbox()
    page.push('ball', '  第一行\n\n  第二行  ')
    assert.deepEqual(drawn(page.log), ['ball:第一行 第二行'])
  })

  it('keeps the newest end of a message too long for one bubble', () => {
    const page = sandbox()
    page.push('ball', `${'很长的开头'.repeat(400)}最新的结尾`)
    const text = drawn(page.log)[0].slice('ball:'.length)
    assert.equal(text.length, CHARS + 1)
    assert.equal(text.startsWith('…'), true)
    assert.equal(text.endsWith('最新的结尾'), true)
  })

  it('ignores an empty message rather than drawing an empty bubble', () => {
    const page = sandbox()
    page.push('ball', '   ')
    assert.equal(page.log.children.length, 0)
    assert.equal(page.log.hidden, true)
    assert.equal(page.opened, 0)
  })

  it('opens a collapsed card and leaves an open one alone', () => {
    const collapsed = sandbox()
    collapsed.push('ball', '我在。')
    assert.equal(collapsed.opened, 1)
    const open = sandbox({ expanded: true })
    open.push('ball', '我在。')
    assert.equal(open.opened, 0)
  })

  it('does not pull a docked ball out of its strip', () => {
    // The strip means the user parked the ball; a message is not a reason to undo that.
    const page = sandbox({ docked: 'left' })
    page.push('ball', '我在。')
    assert.equal(page.opened, 0)
    assert.equal(drawn(page.log).length, 1)
  })

  it('does not open the card over a pending question', () => {
    const page = sandbox({ asking: true })
    page.push('ball', '我在。')
    assert.equal(page.opened, 0)
  })

  it('obeys a profile that turned the automatic card off', () => {
    // `autoExpandOnWake` is the profile's answer to "may the card open by itself": off means the
    // message appears on the card the user opens by hand, not one that pops up on its own.
    const page = sandbox({ autoExpand: false })
    page.push('ball', '我在。')
    assert.equal(page.opened, 0)
    assert.equal(page.log.hidden, false)
  })

  it('keeps one state row that the next state replaces', () => {
    const page = sandbox()
    page.status('正在听你说…', 0)
    page.status('正在识别…', 0)
    assert.deepEqual(drawn(page.log), ['system:正在识别…'])
  })

  it('takes the state row down when a real message arrives', () => {
    // "正在识别…" outliving the sentence it was about is a card that lies about what it is doing.
    const page = sandbox()
    page.status('正在识别…', 0)
    page.push('me', '现在几点')
    assert.deepEqual(drawn(page.log), ['me:现在几点'])
  })

  it('lets a state row expire on its own', async () => {
    const page = sandbox()
    page.status('正在听你说…', 15)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(page.log.children.length, 0)
    assert.equal(page.log.hidden, true)
  })

  it('holds a state row that has no end of its own', () => {
    // A recording and a recognition both have no visible end, so `hold` 0 must leave the row up
    // rather than schedule a timer that would blank it mid-sentence.
    const page = sandbox()
    page.status('正在听你说…', 0)
    assert.deepEqual(drawn(page.log), ['system:正在听你说…'])
  })

  it('grows one bubble as an answer streams in, instead of one bubble per chunk', () => {
    const page = sandbox()
    page.append('第一句。')
    page.append('第二句。')
    page.append('第三句。')
    assert.equal(page.log.children.length, 1)
    assert.deepEqual(drawn(page.log), ['ball:第一句。第二句。第三句。'])
    page.settle()
    // Settling keeps the bubble it grew in; only a new message moves on.
    assert.deepEqual(drawn(page.log), ['ball:第一句。第二句。第三句。'])
    // A second settle with nothing new is a no-op rather than a duplicate bubble.
    page.settle()
    assert.equal(page.log.children.length, 1)
  })

  it('puts the next turn under the answer it interrupted', () => {
    const page = sandbox()
    page.append('它说了一半')
    page.push('me', '我说的下一句')
    assert.deepEqual(drawn(page.log), ['ball:它说了一半', 'me:我说的下一句'])
    // The stream that was open is closed, so nothing more lands in the old bubble.
    page.append('半句话的尾巴')
    assert.deepEqual(drawn(page.log), ['ball:它说了一半', 'me:我说的下一句', 'ball:半句话的尾巴'])
  })

  it('does not draw the same finished answer twice', () => {
    // The sentence reaches the bubble once as the stream this page followed and once as the
    // finished reply; the second copy would sit under the first saying the same thing.
    const page = sandbox()
    page.append('三点整。')
    page.settle()
    page.push('ball', '三点整。')
    assert.deepEqual(drawn(page.log), ['ball:三点整。'])
  })

  it('drops the chat when a new conversation starts', () => {
    const page = sandbox()
    page.push('ball', '我在。')
    page.push('me', '现在几点')
    page.clear()
    assert.equal(page.log.children.length, 0)
    assert.equal(page.log.hidden, true)
  })

  it('forgets what was folded when a new conversation starts', () => {
    // The rows went with the log; the list of them has to go too, or the next turn would try to fold
    // nodes that are no longer in the document.
    const page = sandbox()
    page.push('me', '查一下')
    page.push('ball', '我看看')
    page.clear()
    page.push('ball', '新的答案')
    assert.equal(page.log.children[0]?.dataset.folded, undefined)
  })
})

describe('narration folds, the answer does not', () => {
  /** The rows of the log as the reader sees them: `role:folded|plain`. */
  function shape(log: FakeNode): string[] {
    return log.children.map((row) => `${row.dataset.role}:${row.dataset.folded === '1' ? 'folded' : 'plain'}`)
  }

  it('folds the ball\'s earlier message once it says something newer', () => {
    // The shape this exists for: a tool-calling answer narrates what it is about to do ("我查一下"),
    // then comes back with the answer. Both landed in the card as messages, so the card read like the
    // model thinking out loud with the answer hidden under it.
    const page = sandbox({ expanded: true })
    page.push('me', '现在几点')
    page.push('ball', '我查一下时间。')
    page.push('ball', '现在下午三点整。')
    assert.deepEqual(shape(page.log), ['me:plain', 'ball:folded', 'ball:plain'])
    // Folded, not deleted: the words are still there to be opened.
    assert.equal(page.log.children[1]?.children[0]?.textContent, '我查一下时间。')
  })

  it('says nothing about the earlier exchange when the user speaks again', () => {
    // The last answer of the previous turn is an answer. A new sentence is a new exchange, so nothing
    // before it is narration of it.
    const page = sandbox({ expanded: true })
    page.push('me', '现在几点')
    page.push('ball', '三点整。')
    page.push('me', '那明天呢')
    page.push('ball', '我看看')
    page.push('ball', '明天同样整点报时。')
    assert.deepEqual(shape(page.log), ['me:plain', 'ball:plain', 'me:plain', 'ball:folded', 'ball:plain'])
  })

  it('folds an attempt that a later attempt of the same turn replaces', () => {
    // The main window retries, and each attempt narrates while it streams. Only the last one is the
    // answer; the ones it replaced are the process.
    const page = sandbox({ expanded: true })
    page.push('me', '看一下这个报错')
    page.append('先查日志。')
    page.settle()
    page.append('再看一下配置。')
    page.settle()
    page.push('ball', '是端口冲突。')
    assert.deepEqual(shape(page.log), ['me:plain', 'ball:folded', 'ball:folded', 'ball:plain'])
  })

  it('keeps growing inside one bubble instead of folding a half-written answer', () => {
    const page = sandbox({ expanded: true })
    page.append('正在')
    page.append('写')
    assert.equal(page.log.children[0]?.dataset.folded, undefined)
  })

  it('never folds your own message', () => {
    const page = sandbox({ expanded: true })
    page.push('me', '第一句')
    page.push('me', '第二句')
    assert.deepEqual(shape(page.log), ['me:plain', 'me:plain'])
  })

  it('opens a folded line and folds it again on the toggle', () => {
    const page = sandbox({ expanded: true })
    page.push('me', '现在几点')
    page.push('ball', '我查一下时间。')
    page.push('ball', '现在下午三点整。')
    const folded = page.log.children[1]!
    const toggle = folded.children[1]!
    assert.equal(toggle.tag, 'button')
    assert.equal(toggle.textContent, MORE)
    toggle.fire('click', { stopPropagation() {} })
    assert.equal(folded.hasAttribute('data-open'), true)
    assert.equal(toggle.textContent, LESS)
    assert.equal(toggle.attrs.has('aria-expanded'), true)
    toggle.fire('click', { stopPropagation() {} })
    assert.equal(folded.hasAttribute('data-open'), false)
    assert.equal(toggle.textContent, MORE)
  })

  it('folds a line once, not once per later message', () => {
    const page = sandbox({ expanded: true })
    page.push('ball', '一句')
    page.push('ball', '两句')
    page.push('ball', '三句')
    const first = page.log.children[0]!
    assert.deepEqual(first.children.map((child) => child.tag), ['div', 'button'])
  })
})

describe('the conversation is wired to both sides of the exchange', () => {
  it('puts the acknowledgement clip in the ball\'s column', () => {
    const wake = pageFunction('applyWakeStatus')
    assert.match(wake, /playWakeFrame\(\)/)
    assert.match(wake, /pushBubble\('ball', wake\.voiceText\(\) \?\? messages\.wakeAck\)/)
  })

  it('puts the dictation on screen before, during and after recognition', () => {
    assert.match(pageFunction('startDictation'), /showBubbleStatus\(messages\.dictating/)
    assert.match(pageFunction('startDictation'), /showBubbleStatus\(messages\.wakeTranscribing/)
    // The recognized sentence used to land in a composer the bubble no longer shows; it is the
    // user's own message on the card now.
    assert.match(pageFunction('applyTranscript'), /pushBubble\('me', text\)/)
  })

  it('puts the reply in the ball\'s column whether or not it is read out', () => {
    const reply = pageFunction('speakReply')
    assert.match(reply, /pushBubble\('ball', text\)/)
    // Before the read-aloud switch: with read-aloud off the card is the only place the answer is visible.
    assert.match(reply, /pushBubble\('ball', text\)[^]*if \(!speaker\.autoPlay\) return/)
  })

  it('takes the main window\'s words off the session-turn message', () => {
    assert.match(shell, /if \(outcome === 'user'\) {[^]*pushBubble\('me', payload\.text\)/)
    assert.match(shell, /if \(outcome === 'text'\) {[^]*appendBubbleStream\(payload\?\.text\)/)
    assert.match(shell, /if \(outcome === 'ended'\) {[^]*settleBubbleStream\(\)/)
    assert.match(shell, /if \(outcome === 'streamed'\) {[^]*settleBubbleStream\(\)/)
    // A new turn closes the answer that was being written, so the next chunks do not land in it.
    assert.match(shell, /if \(outcome === 'user'\) {[^]*settleBubbleStream\(\)/)
  })

  it('has a host that sends the words, not only the face cue', () => {
    assert.match(host, /private announceOtherText/)
    assert.match(host, /outcome: 'text', text/)
    // The user's own sentence rides the cue it already had.
    assert.match(host, /outcome: 'user', \.\.\.\(said === ''/)
    // The words waiting in the buffer are flushed at the end of the answer, not dropped.
    assert.match(host, /this\.flushOtherText\(\)[^]*this\.announceOtherStreamEnded\(\)/)
  })

  it('opens the card only within what the profile allows', () => {
    const open = pageFunction('openBubbleForLine')
    assert.match(open, /docked !== undefined/)
    assert.match(open, /wake\.autoExpand\(\)/)
  })

  it('starts a new exchange at the greeting and at the user\'s sentence', () => {
    // The two places a turn actually begins. Without the greeting one, the woken ball would fold
    // whatever it had just answered; without the user's, an answer to the previous sentence would be.
    assert.match(pageFunction('applyWakeStatus'), /beginBubbleTurn\(\)\n {4}pushBubble\('ball'/)
    assert.match(pageFunction('pushBubble'), /if \(role === 'me'\) beginBubbleTurn\(\)/)
  })

  it('folds the ball\'s rows, including the ones an attempt streamed into', () => {
    assert.match(pageFunction('pushBubble'), /if \(role === 'ball'\) registerBubbleRow\(bubble\.row\)/)
    assert.match(pageFunction('appendBubbleStream'), /registerBubbleRow\(bubbleStreamRow\.row\)/)
  })
})

describe('the card is shaped like a chat window', () => {
  it('has somewhere to draw it', () => {
    assert.match(markup, /<div id="bubble-log" role="log" aria-live="polite" hidden><\/div>/)
    assert.match(shell, /const bubbleLog = document\.querySelector\('#bubble-log'\)/)
    assert.match(styles, /#bubble-log {/)
    assert.match(styles, /#bubble-log\[hidden\] {/)
  })

  it('draws the two sides apart', () => {
    assert.match(styles, /\.bubble-msg\[data-role="me"\] {\n  justify-content: flex-end;\n}/)
    assert.match(styles, /\.bubble-msg\[data-role="me"\] \.bubble-text {/)
    assert.match(styles, /\.bubble-msg\[data-role="system"\] \.bubble-text {/)
  })

  it('is as tall as its messages and scrolls past the ceiling', () => {
    // The card has no fixed height; the log asks for its content's height and stops growing at
    // `--bubble-max-height`, where it becomes the thing that scrolls.
    assert.match(styles, /#bubble-log {[^}]*flex: 0 1 auto;/)
    assert.match(styles, /#bubble-log {[^}]*min-height: 0;/)
    assert.match(styles, /#bubble-log {[^}]*overflow-y: auto;/)
    assert.match(styles, /#panel {[^}]*height: auto;/)
    assert.match(styles, /#panel {[^}]*max-height: var\(--bubble-max-height\);/)
  })

  it('does not paint the prose transcript under the bubbles', () => {
    // Hiding is the half of the old panel that stays: the page still writes to `#transcript`
    // (and the question card was measured against it), it is just not the thing on screen.
    assert.match(styles, /#transcript {\n  display: none;\n}/)
  })

  it('steps aside for a question that has to be answered', () => {
    assert.match(styles, /body\.asking #bubble-log {\n  display: none;\n}/)
  })

  it('draws a folded line as an aside rather than as something being said', () => {
    // Dim, no bubble shape, two lines and an ellipsis — the answer under it is what the card is for.
    assert.match(styles, /\.bubble-msg\[data-folded\] {\n  flex-direction: column;/)
    assert.match(styles, /\.bubble-msg\[data-folded\] \.bubble-text \{[^}]*font-size: 12\.5px;/)
    assert.match(styles, /\.bubble-msg\[data-folded\]:not\(\[data-open\]\) \.bubble-text \{[^}]*overflow: hidden;/)
    // The toggle is a button, because a click on a bubble is how the user places a caret in it now.
    assert.match(styles, /\.bubble-more \{[^}]*cursor: pointer;/)
  })
})

describe('the conversation can be copied', () => {
  /**
   * Build `bubbleHasSelection` over a fake selection.
   *
   * The page asks the document for a selection and then asks the log whether that selection is
   * inside it; those two objects are the whole interface, so they are what gets stubbed.
   */
  function selectionSandbox() {
    const log = new FakeNode('div')
    const message = new FakeNode('div')
    const label = new FakeNode('div')
    const textNode = new FakeNode('#text')
    textNode.nodeType = 3
    log.append(message)
    message.append(label)
    label.append(textNode)
    const outside = new FakeNode('div')
    const state: { isCollapsed: boolean; anchorNode: FakeNode | null } = { isCollapsed: true, anchorNode: null }
    const factory = new Function('deps', `
      const { bubbleLog, document } = deps
      ${pageFunction('bubbleHasSelection')}
      return { bubbleHasSelection }
    `)
    const run = factory({
      bubbleLog: log,
      document: { getSelection: () => state }
    }) as { bubbleHasSelection: () => boolean }
    return {
      run,
      textNode,
      message,
      outside,
      select(next: { isCollapsed: boolean; anchorNode: FakeNode | null }) {
        state.isCollapsed = next.isCollapsed
        state.anchorNode = next.anchorNode
      }
    }
  }

  it('knows a selection inside the conversation from one that is not', () => {
    const page = selectionSandbox()
    assert.equal(page.run.bubbleHasSelection(), false, 'nothing selected is nothing to protect')
    // A caret — a click without a drag — is collapsed: counting it as a selection would mean the card
    // never closes again, because clicking in the card is how one opens what is already open.
    page.select({ isCollapsed: true, anchorNode: page.textNode })
    assert.equal(page.run.bubbleHasSelection(), false)
    page.select({ isCollapsed: false, anchorNode: page.textNode })
    assert.equal(page.run.bubbleHasSelection(), true)
    // An anchor on the message element itself counts too: a double-click selects the word, but a
    // right-click that picked a whole bubble anchors on the row.
    page.select({ isCollapsed: false, anchorNode: page.message })
    assert.equal(page.run.bubbleHasSelection(), true)
    page.select({ isCollapsed: false, anchorNode: page.outside })
    assert.equal(page.run.bubbleHasSelection(), false, 'a selection elsewhere is not this card holding text')
  })

  it('lets the text be selected at all', () => {
    // `html, body` turns selection off for the whole overlay; the conversation has to say otherwise,
    // or a drag inside a bubble selects nothing and Ctrl+C copies nothing.
    assert.match(styles, /#bubble-log,\n\.bubble-text \{\n {2}user-select: text;\n {2}-webkit-user-select: text;\n {2}cursor: text;\n\}/)
  })

  it('picks the message under a right-click, so the menu has something to copy', () => {
    assert.match(shell, /function pickBubbleMessage\(event\)/)
    assert.match(shell, /target\.closest\('\.bubble-text'\)/)
    assert.match(shell, /range\.selectNodeContents\(text\)/)
    // Already-selected text is left alone: drag then right-click copies the drag, not a whole bubble.
    assert.match(shell, /if \(bubbleHasSelection\(\)\) return\n {4}const target = event\?\.target/)
    assert.match(shell, /bubbleLog\.addEventListener\('contextmenu', pickBubbleMessage\)/)
  })

  it('does not close the card out from under a selection', () => {
    assert.match(shell, /collapseTimer = setTimeout\(\(\) => \{\n {6}collapseTimer = undefined\n {6}\/\/ A selection[^]*if \(bubbleHasSelection\(\)\) \{\n {8}scheduleCollapse\(\)\n {8}return\n {6}\}/)
  })

  it('gives the helper a menu for a selection, because Electron has none of its own', () => {
    // The handler used to `return` on `hasSelection`, which drew nothing at all: right-click over
    // selected text was a no-op in a window that ships no default context menu.
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    assert.match(main, /if \(params\?\.hasSelection\) \{\n {6}const zh = menuZh\(\)/)
    assert.match(main, /role: 'copy'/)
    assert.match(main, /role: 'selectAll'/)
  })
})
