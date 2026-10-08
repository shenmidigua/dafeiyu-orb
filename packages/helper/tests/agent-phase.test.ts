/**
 * The ball's own face, and the one thing that used to be able to freeze it.
 *
 * `agentPhase` is the only place that decides whether the ball is writing, thinking or waiting on a tool, and it
 * decides it from a `running` flag the host sets. Twice now the ball has been reported stuck on a tool face while
 * nothing was running — the flag had been set and nothing settled it — and both times the page had no way back,
 * because a block that never changes produces no further messages to react to.
 *
 * So the page believes a running block only while the transcript is still moving, and this file is about that:
 * a live block is believed, a silent one is not, and the ball comes back on its own.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')

/** The source of a top-level function, from its name to its closing brace. */
function pageFunction(name: string): string {
  const head = shell.indexOf(`function ${name}(`)
  assert.notEqual(head, -1, `${name} is missing from the page`)
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let index = open; index < shell.length; index += 1) {
    if (shell[index] === '{') depth += 1
    else if (shell[index] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, index + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/** The window read out of the page, so a change to it cannot leave this file passing. */
const STALE_MS = Number(/const STALE_BLOCK_MS = (\d+)/.exec(shell)?.[1] ?? 0)
/** The windows another conversation's work is trusted for, read out of the page for the same reason. */
const WORK_MS = Number(/const OTHER_WORK_HOLD_MS = (\d+)/.exec(shell)?.[1] ?? 0)
const WORDS_MS = Number(/const OTHER_STREAM_HOLD_MS = (\d+)/.exec(shell)?.[1] ?? 0)


/**
 * `restingNow` with the page's windows handed in.
 *
 * This is the predicate the nap clock and the skit are gated on, so it decides whether the ball is available to
 * do its little routines. It reads module-level state, which is why it is compiled with its dependencies passed
 * in rather than reached for.
 */
function resting(options: {
  /** Milliseconds since the other conversation last sent anything, by kind. */
  typingAgo?: number
  toolAgo?: number
  thinkingAgo?: number
  /** A per-tool face that is up, and how long its floor has left. */
  holdMode?: string
  holdLeftMs?: number
}): boolean {
  const windows = new Map<string, number>()
  const now = Date.now()
  if (options.typingAgo !== undefined) windows.set('typing', now - options.typingAgo)
  if (options.toolAgo !== undefined) windows.set('tool', now - options.toolAgo)
  if (options.thinkingAgo !== undefined) windows.set('thinking', now - options.thinkingAgo)
  const hold = { mode: options.holdMode ?? '', until: now + (options.holdLeftMs ?? 0) }
  const factory = new Function('deps', `
    const { otherStreamAt, OTHER_WORK_HOLD_MS, OTHER_STREAM_HOLD_MS, toolFaceHoldState, Date, pageClosed,
            hovering, expanded, running, asking, tccGateVisible, attachedSelection, agentState,
            document } = deps
    ${pageFunction('restingNow')}
    return restingNow
  `)
  const run = factory({
    otherStreamAt: windows,
    OTHER_WORK_HOLD_MS: WORK_MS,
    OTHER_STREAM_HOLD_MS: WORDS_MS,
    toolFaceHoldState: hold,
    Date,
    pageClosed: () => false,
    hovering: false,
    expanded: false,
    running: false,
    asking: () => false,
    tccGateVisible: false,
    attachedSelection: '',
    agentState: '',
    document: { body: { classList: { contains: () => false } } },
  }) as () => boolean
  return run()
}

interface Phase {
  state: string
  tool: string
}

/**
 * `agentPhase` over one transcript.
 *
 * `transcriptAt` is passed in because that is the whole question: the page's own value is a clock, and this file
 * needs to say "the transcript has been silent for longer than that".
 */
function phase(blocks: { key: string; kind: string; text: string; running: boolean }[], silentForMs: number): Phase {
  const map = new Map(blocks.map((block) => [block.key, block]))
  const factory = new Function('deps', `
    const { blockData, transcriptAt, Date, STALE_BLOCK_MS } = deps
    ${pageFunction('agentPhase')}
    return agentPhase
  `)
  const run = factory({
    blockData: map,
    transcriptAt: Date.now() - silentForMs,
    Date,
    STALE_BLOCK_MS: STALE_MS,
  }) as () => Phase
  return run()
}

describe('the ball\u2019s own phase', () => {
  it('reads the window and the page\u2019s own threshold', () => {
    assert.ok(STALE_MS > 0, 'STALE_BLOCK_MS is missing from the page, so this file proves nothing')
  })

  it('believes a running block while the transcript is moving', () => {
    const tool = [{ key: 'a', kind: 'tool', text: 'pwsh', running: true }]
    assert.deepEqual(phase(tool, 0), { state: 'tooling', tool: 'pwsh' },
      'a live tool call no longer puts the tool face up')
    const writing = [{ key: 'a', kind: 'assistant', text: 'hi', running: true }]
    assert.deepEqual(phase(writing, 0), { state: 'replying', tool: '' }, 'live words no longer count as writing')
    const thinking = [{ key: 'a', kind: 'reasoning', text: 'hmm', running: true }]
    assert.deepEqual(phase(thinking, 0), { state: 'thinking', tool: '' }, 'live reasoning no longer counts as thinking')
  })

  it('stops believing one the transcript has gone quiet about', () => {
    // The bug this exists for: a `running` flag that nothing settled leaves the ball frozen on a tool face, and
    // because the block never changes again there is no message to react to. Silence is the way back.
    const tool = [{ key: 'a', kind: 'tool', text: 'pwsh', running: true }]
    assert.deepEqual(phase(tool, STALE_MS + 1000), { state: '', tool: '' },
      'a stale tool call still held the ball on a tool face')
    const writing = [{ key: 'a', kind: 'assistant', text: 'hi', running: true }]
    assert.deepEqual(phase(writing, STALE_MS + 1000), { state: '', tool: '' },
      'a stale writing block still held the ball on the typing face')
    // And just inside the window it is still believed, so the guard is a timeout and not a switch.
    assert.deepEqual(phase(tool, STALE_MS - 1000), { state: 'tooling', tool: 'pwsh' },
      'a call that is still fresh was written off')
  })

  it('does not count as rest while another conversation is working', () => {
    // This is what let the skit play over the work animations: `agentState` is only ever about this panel's own
    // transcript, so a ball sitting idle while the user works in the DSH window looked available, and the skit
    // went off in the middle of somebody else's answer — reported as "the dance covers the working animations".
    assert.equal(resting({}), true, 'a quiet ball is no longer available for its routines')
    for (const kind of ['typingAgo', 'toolAgo', 'thinkingAgo'] as const) {
      assert.equal(resting({ [kind]: 100 }), false, `${kind} did not count as work happening elsewhere`)
      assert.equal(resting({ [kind]: WORK_MS + WORDS_MS + 1000 }), true, `${kind} kept the ball busy forever`)
    }
    // And the floor under a per-tool face counts as busy too, for as long as it has left.
    assert.equal(resting({ holdMode: 'tool-named-elsewhere:pwsh', holdLeftMs: 1000 }), false,
      'the ball started a routine while a tool face was still up')
    assert.equal(resting({ holdMode: 'tool-named-elsewhere:pwsh', holdLeftMs: -1000 }), true,
      'an expired hold kept the ball busy')
  })

  it('keeps the order the faces are ranked in', () => {
    // Writing beats a call beats reasoning, which is what the transcript reader relies on. A guard that broke the
    // order would be a behaviour change dressed up as a fix.
    const both = [
      { key: 'a', kind: 'tool', text: 'pwsh', running: true },
      { key: 'b', kind: 'assistant', text: 'hi', running: true },
    ]
    assert.deepEqual(phase(both, 0), { state: 'replying', tool: '' }, 'a call outranked words being written')
    const tool = [
      { key: 'a', kind: 'reasoning', text: 'hmm', running: true },
      { key: 'b', kind: 'tool', text: 'pwsh', running: true },
    ]
    assert.deepEqual(phase(tool, 0), { state: 'tooling', tool: 'pwsh' }, 'reasoning outranked a call')
  })
})
