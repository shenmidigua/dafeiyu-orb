/**
 * The fetch face: what the ball wears while the agent is pulling a web page down.
 *
 * `tool` was already a slot, but it is one frame for every tool the agent can call, so a pack that
 * wanted to say something about a *fetch* had nowhere to say it. This slot is that somewhere.
 *
 * Four things here are easy to get wrong, and each has already been wrong somewhere in this page's
 * history, so all four are pinned:
 *
 *   * the *tool name has to reach the frame*. `agentPhase()` used to answer a bare
 *     `'tooling'`, which is the same answer for a fetch and for a `bash`. Two tools in a row are
 *     therefore the same state, and `syncAgent` — which repaints only on a change — would never
 *     fire between them. The face would work on the first tool call of a turn and then silently
 *     stop working for the rest of the session.
 *   * the *two modes must differ*. `dataset.mode` is the only thing `syncGif` compares before
 *     touching `src`, so a fetch and a `bash` sharing the mode `tool` means the swap repaints
 *     nothing and the fetch face stays frozen on the ball through the next call.
 *   * the *edges*. The frame is read on the way in and dropped on the way out. Dropping it is what
 *     makes an edited `memes.json` apply to the next fetch rather than the next restart; not
 *     dropping it would pin one build's answer for the life of the page.
 *   * the *fallback*. A pack that names no `webfetch` must behave exactly as it did before this
 *     slot existed — `tool` in charge of a fetch — rather than leaving the ball bare.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching. */
function pageFunction(source: string, name: string): string {
  const head = source.indexOf(`function ${name}(`)
  assert.notEqual(head, -1, `${name} is missing from the page`)
  const start = source.slice(head - 6, head) === 'async ' ? head - 6 : head
  const open = source.indexOf('{', head)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

const WEBFETCH = 'data:image/gif;base64,WEBFETCH'
const TOOL = 'data:image/gif;base64,TOOL'
const IDLE = 'data:image/gif;base64,IDLE'

interface GifInputs {
  agentState?: string
  agentTool?: string
  webfetchSrc?: string
  toolSrc?: string
  replySrc?: string
  thinkingSrc?: string
}

/**
 * Run `syncGif` with every pose this test is not about left undefined, and report the mode and
 * image it chose.
 *
 * The one-shots and the agent's other frames are disarmed rather than stubbed with a sentinel, so a
 * change that moves a new branch above the tool face shows up as this function's answer changing
 * instead of as a silent behaviour change in the orb.
 */
function paintFor(inputs: GifInputs): { mode: string; src: string | undefined } {
  // The page writes the image to `gif.src` and only the mode to `gif.dataset.mode`, so the stub
  // carries both: reading `dataset.src` here would report `undefined` for every case and this file
  // would pass while proving nothing about which image the ball was given.
  const gif = { dataset: {} as { mode?: string }, src: undefined as string | undefined }
  const factory = new Function('deps', `
    const { document, pageClosed, syncSleep, dragging, dragSrc, dropShown, clickShown, arriveShown,
            wakeShown, doneShown, typingSrc, replySrc, toolSrc, thinkingSrc, speakSrc, speakActive,
            voiceSrc, dictationPhase, webfetchSrc, agentState, agentTool, idleSrc, hoverSrc,
            introTimer, napShown, skitInfo, running, asking, tccGateVisible, attachedSelection,
            expanded, avatarSrc, freezeGif, Date, sleepFrameAt, skitFrame, hoverIntroSrc,
            introUntil, hovering, WEB_FETCH_TOOL, brokeNow } = deps
    ${pageFunction(shell, 'syncGif')}
    return syncGif
  `)
  const syncGif = factory({
    document: { querySelector: () => gif },
    pageClosed: () => false,
    syncSleep: () => {},
    // The poor face is off: this file is about which face a tool call wears, and the resting loop
    // sits below all of it. `dsh_orb/walk_poor_sequence.mjs` walks the real predicate.
    brokeNow: () => false,
    dragging: false,
    dragSrc: undefined,
    dropShown: undefined,
    clickShown: undefined,
    // The greeting sits above this branch while it is up, so it has to be named here or the
    // harness dies with "arriveShown is not defined". It is disarmed because a page whose greeting
    // is still playing is not the case this file is about.
    arriveShown: undefined,
    wakeShown: undefined,
    doneShown: undefined,
    typingSrc: undefined,
    replySrc: inputs.replySrc,
    toolSrc: inputs.toolSrc,
    thinkingSrc: inputs.thinkingSrc,
    speakSrc: undefined,
    speakActive: false,
    voiceSrc: undefined,
    dictationPhase: 'idle',
    webfetchSrc: inputs.webfetchSrc,
    agentState: inputs.agentState ?? '',
    agentTool: inputs.agentTool ?? '',
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
    Date,
    WEB_FETCH_TOOL: 'web_fetch',
  }) as () => void
  syncGif()
  assert.notEqual(gif.dataset.mode, undefined, 'syncGif fell through every branch without painting')
  return { mode: gif.dataset.mode as string, src: gif.src }
}

describe('the fetch face in syncGif', () => {
  it('wears the fetch frame while a web_fetch call is running', () => {
    const painted = paintFor({ agentState: 'tooling', agentTool: 'web_fetch',
      webfetchSrc: WEBFETCH, toolSrc: TOOL })
    assert.equal(painted.mode, 'webfetch')
    assert.equal(painted.src, WEBFETCH, 'the fetch frame was named but the tool face was worn')
  })

  it('leaves every other tool on the shared tool face', () => {
    // A pack that names a fetch face has not said anything about `bash`, and must not lose it.
    for (const name of ['bash', 'pwsh', 'read', 'write', 'edit', 'web_search', 'grep']) {
      const painted = paintFor({ agentState: 'tooling', agentTool: name,
        webfetchSrc: WEBFETCH, toolSrc: TOOL })
      assert.equal(painted.mode, 'tool', `${name} was given the fetch face`)
      assert.equal(painted.src, TOOL, `${name} was painted with the wrong image`)
    }
  })

  it('gives a fetch the tool face when the pack names no fetch frame', () => {
    // The unconfigured case has to be byte-for-byte the behaviour from before this slot existed.
    const painted = paintFor({ agentState: 'tooling', agentTool: 'web_fetch',
      webfetchSrc: undefined, toolSrc: TOOL })
    assert.equal(painted.mode, 'tool')
    assert.equal(painted.src, TOOL)
  })

  it('paints a different mode for the two, so the swap back actually repaints', () => {
    // This is the one that is invisible until it bites. `syncGif` only writes `src` when the mode
    // changes, so a shared mode means fetch → bash repaints nothing and the ball keeps the fetch
    // face for the rest of the call. The assertion is on the mode strings, not on the images,
    // because the images are already covered above.
    const fetchMode = paintFor({ agentState: 'tooling', agentTool: 'web_fetch',
      webfetchSrc: WEBFETCH, toolSrc: TOOL }).mode
    const toolMode = paintFor({ agentState: 'tooling', agentTool: 'bash',
      webfetchSrc: WEBFETCH, toolSrc: TOOL }).mode
    assert.notEqual(fetchMode, toolMode, 'both tool faces share one mode, so the swap never repaints')
  })

  it('does not wear it once the call is over', () => {
    // The frame is a state, not an event: a turn that has moved on to reasoning must not keep
    // showing that it was fetching something.
    assert.equal(paintFor({ agentState: 'thinking', agentTool: '',
      webfetchSrc: WEBFETCH, toolSrc: TOOL,
      thinkingSrc: 'data:image/gif;base64,THINKING' }).mode, 'thinking')
  })

  it('stays out of the way of the frames above it', () => {
    // Priority is a judgement call nobody re-checks, so it is checked here: a reply streaming in
    // over a fetch keeps its own face, exactly as it would before this slot existed.
    assert.equal(paintFor({ agentState: 'replying', agentTool: '',
      webfetchSrc: WEBFETCH, toolSrc: TOOL, replySrc: 'data:image/gif;base64,REPLY' }).mode, 'reply')
  })
})

/**
 * Drive `agentPhase` over a set of blocks and report what it says.
 *
 * `blockData` is passed in as a `Map` because that is what the page keeps, and the iteration order
 * of a `Map` is insertion order — which is the whole reason "the last running tool wins" is a
 * statement about arrival order rather than about severity.
 */
function phaseFor(blocks: readonly { key: string; kind: string; text: string; running?: boolean }[]): {
  state: string; tool: string
} {
  const factory = new Function('deps', `
    const { blockData } = deps
    ${pageFunction(shell, 'agentPhase')}
    return agentPhase()
  `)
  const map = new Map(blocks.map((block) => [block.key, block]))
  return factory({ blockData: map }) as { state: string; tool: string }
}

describe('what the agent phase reports', () => {
  it('names the tool that is running', () => {
    assert.deepEqual(phaseFor([{ key: 'a', kind: 'tool', text: 'web_fetch', running: true }]),
      { state: 'tooling', tool: 'web_fetch' })
  })

  it('reports the most recently started call when two overlap', () => {
    // A fetch that is still running while the next tool starts must not keep the face: the agent
    // is waiting on the newer one. Map order is arrival order, so the answer is the last entry.
    assert.deepEqual(phaseFor([
      { key: 'a', kind: 'tool', text: 'web_fetch', running: true },
      { key: 'b', kind: 'tool', text: 'bash', running: true },
    ]), { state: 'tooling', tool: 'bash' })
  })

  it('skips a call that has already finished', () => {
    // Otherwise a finished fetch would hold the face over whatever the agent does next, which is
    // the same class of bug as a frame outlasting its state.
    assert.deepEqual(phaseFor([
      { key: 'a', kind: 'tool', text: 'web_fetch', running: false },
      { key: 'b', kind: 'tool', text: 'bash', running: true },
    ]), { state: 'tooling', tool: 'bash' })
  })

  it('still answers a phase for the states that are not tools', () => {
    assert.deepEqual(phaseFor([{ key: 'a', kind: 'assistant', text: 'hi', running: true }]),
      { state: 'replying', tool: '' })
    assert.deepEqual(phaseFor([{ key: 'a', kind: 'reasoning', text: '', running: true }]),
      { state: 'thinking', tool: '' })
    assert.deepEqual(phaseFor([{ key: 'a', kind: 'user', text: 'hi', running: false }]),
      { state: '', tool: '' })
  })
})

/**
 * Drive the real `syncAgent` over a live set of blocks and report what it asked for.
 *
 * Both functions are cut out of the page and run together, so the tool name really does travel
 * `blockData` → `agentPhase` → `syncAgent` → the frame read, rather than this file asserting that
 * the source contains some strings. `loadWebfetchFrame` is stubbed because the real one reads a
 * whole GIF over IPC; the count of asks for it *is* the edge under test.
 *
 * `agentState`, `agentTool` and `webfetchSrc` are declared with `let` in the harness because they
 * are the three things `syncAgent` assigns, and a `const` pulled out of `deps` would fail the first
 * assignment instead of exercising the branch that follows it.
 */
function agentHarness(blocks: readonly { key: string; kind: string; text: string; running?: boolean }[] = [],
  initial: { state?: string; tool?: string; webfetchSrc?: string } = {}): {
  repaints: number; loads: number; run: () => void; frame: () => string | undefined
} {
  const counter = { repaints: 0, loads: 0 }
  const factory = new Function('deps', `
    const { blockData, syncGif, loadWebfetchFrame, WEB_FETCH_TOOL } = deps
    let agentState = deps.agentState
    let agentTool = deps.agentTool
    let webfetchSrc = deps.webfetchSrc
    ${pageFunction(shell, 'agentPhase')}
    ${pageFunction(shell, 'syncAgent')}
    return { run: syncAgent, frame: () => webfetchSrc, state: () => agentState, tool: () => agentTool }
  `)
  const built = factory({
    blockData: new Map(blocks.map((block) => [block.key, block])),
    syncGif: () => { counter.repaints += 1 },
    loadWebfetchFrame: () => { counter.loads += 1 },
    agentState: initial.state ?? '',
    agentTool: initial.tool ?? '',
    webfetchSrc: initial.webfetchSrc,
    WEB_FETCH_TOOL: 'web_fetch',
  }) as { run: () => void; frame: () => string | undefined; state: () => string; tool: () => string }
  return {
    get repaints() { return counter.repaints },
    get loads() { return counter.loads },
    run: () => { built.run() },
    frame: built.frame,
  }
}

const FETCH_RUNNING = [{ key: 'a', kind: 'tool', text: 'web_fetch', running: true }]
const BASH_RUNNING = [{ key: 'a', kind: 'tool', text: 'bash', running: true }]

describe('the fetch edge in syncAgent', () => {
  it('asks for the frame on the edge where a fetch starts', () => {
    // The frame is normally in hand from the startup sweep, but the first fetch of a session
    // routinely beats it, and a face that arrives after the call is over is a face nobody sees.
    const idle = agentHarness()
    idle.run()
    assert.equal(idle.loads, 0, 'a repaint with no tool running still read a GIF')

    const starting = agentHarness(FETCH_RUNNING)
    starting.run()
    assert.equal(starting.loads, 1, 'a starting fetch did not read its frame')
    assert.equal(starting.repaints, 1)
  })

  it('does not read the frame for any other tool', () => {
    // The whole point of a separate slot is that it costs nothing elsewhere: a turn that only ever
    // runs `bash` must not pay an IPC read of a GIF it never wears.
    const bash = agentHarness(BASH_RUNNING)
    bash.run()
    assert.equal(bash.loads, 0)
    assert.equal(bash.repaints, 1, 'a tool that is not a fetch still repainted nothing at all')
  })

  it('drops the frame once the call is over, so an edited config applies to the next fetch', () => {
    // Without this the page would pin one build's answer for its whole life: `memes.json` is
    // re-read on a ten-second cadence by the helper, but the page would only ever ask once.
    const held = agentHarness(FETCH_RUNNING, { webfetchSrc: WEBFETCH })
    held.run()
    assert.equal(held.frame(), WEBFETCH, 'the frame in hand was thrown away mid-call')

    const finished = agentHarness([], { state: 'tooling', tool: 'web_fetch', webfetchSrc: WEBFETCH })
    finished.run()
    assert.equal(finished.frame(), undefined, 'the fetch frame outlived the fetch')
    assert.equal(finished.repaints, 1, 'ending a call did not repaint')
  })

  it('reads it again for the next fetch, which is what makes an edit take effect', () => {
    // The other half of the drop above. Releasing the frame without re-reading would just move
    // the staleness from "forever" to "once per turn".
    const finished = agentHarness([], { state: 'tooling', tool: 'web_fetch', webfetchSrc: WEBFETCH })
    finished.run()
    const next = agentHarness(FETCH_RUNNING, { state: '', tool: '' })
    next.run()
    assert.equal(next.loads, 1, 'the second fetch of a session reused the first frame')
  })

  it('repaints when the tool changes even though the phase does not', () => {
    // The regression in one assertion. `syncAgent` used to bail out on an unchanged phase, and two
    // tools in a row are both `tooling` — so the fetch face worked once per turn and then stopped.
    const swap = agentHarness(BASH_RUNNING, { state: 'tooling', tool: 'web_fetch' })
    swap.run()
    assert.equal(swap.repaints, 1, 'a fetch replacing another tool in the same phase went unnoticed')
  })

  it('does not repaint when nothing changed', () => {
    // `onBlock` fires on every streamed token, and this runs on each one.
    const steady = agentHarness(FETCH_RUNNING, { state: 'tooling', tool: 'web_fetch' })
    steady.run()
    steady.run()
    assert.equal(steady.repaints, 0)
    assert.equal(steady.loads, 0, 'the frame was re-read on a call that had not changed')
  })
})

describe('the fetch slot end to end', () => {
  it('is wired from the config through the helper to the page', () => {
    // Four hops, and each can be missing while every test above still passes, because they all
    // stub the hop. A renamed channel is a failure that only shows up as a ball that never changes.
    const memes = readFileSync(join(here, '../src/memes.ts'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')

    assert.match(memes, /webfetch: NamedFrame/, 'the config type carries the slot')
    assert.match(memes, /webfetch: readNamed\(record\.webfetch\)/, 'the config file is parsed for it')
    assert.match(memes, /async webfetch\(\) \{[\s\S]*?named\(current\.webfetch, current\.dirs\)/,
      'the picker resolves it')
    assert.match(main, /ipcMain\.handle\('orb:meme-webfetch'/, 'the helper answers the channel')
    assert.match(preload, /memeWebfetch\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-webfetch'\)/,
      'the preload exposes it')
    assert.match(shell, /api\.memeWebfetch\(\)/, 'the page asks for the frame')
  })

  it('is prefetched with the other named frames, not only on demand', () => {
    // On demand alone would work, but every fetch of every turn would then pay an IPC read of a
    // whole GIF. The sweep is what makes the common case free.
    const body = pageFunction(shell, 'refreshFrames')
    assert.match(body, /loadWebfetchFrame\(\)/, 'the startup sweep never asks for the fetch frame')
  })

  it('matches the tool name the host actually sends', () => {
    // `web_fetch` is spelled here, in the page, and in the transcript model's variant table. If the
    // host ever renames the call, this constant is what silently stops matching — so it is pinned
    // against the model rather than left as a bare literal.
    const model = readFileSync(join(here, '../assets/transcript-model.js'), 'utf8')
    assert.match(model, /web_fetch: 'read'/, 'the transcript model no longer knows web_fetch')
    assert.match(shell, /const WEB_FETCH_TOOL = 'web_fetch'/,
      'the page watches a tool name the transcript model does not classify')
  })
})
