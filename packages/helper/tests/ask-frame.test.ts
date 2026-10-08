/**
 * The question face: what the ball wears when the agent stops the turn to ask the user something.
 *
 * `ask_user_question` reaches the ball as the question card, and the card is the only event this
 * slot hangs off — the same payload, the same moment. What the file adds is the half the card
 * cannot say on its own: a question that arrives while the panel is collapsed would otherwise be
 * answered by a ball that looks exactly as it did before, and the turn is parked until the user
 * notices.
 *
 * Four things are easy to get wrong, and all four are pinned below.
 *
 *   * the *trigger*. It hangs off `showQuestion`, which is where every question the host sends
 *     lands, and off the repeat path as well: a payload for the question already on screen is still
 *     the agent asking, so it restarts the beat rather than being dropped.
 *   * the *priority*. A question arrives **as a running tool call**, so `syncGif` is in its
 *     `tooling` state for the whole time the ball is waiting. A branch placed below that face is
 *     never reached at all: the file would sit in the pack, wired into five layers, and the ball
 *     would show its drawing board while it waited for an answer. The branch therefore sits above
 *     every face the agent wears while it works — and below the wake reaction, which is the one cue
 *     that answers the user's own voice.
 *   * the *hold*. A fixed {@link ASK_HOLD_MS}, not one pass of the file. The clip loops forever, so
 *     `oneShotHoldMs` would give it a single pass minus a lead — about a second — and "the ball is
 *     waiting on you" is not something a blink says. Nothing is handed over at the end of the beat
 *     either: what follows is whatever the ball was already doing.
 *   * the *single instance*. One `#ball-gif` and one timer. A second question takes a new step,
 *     which is what makes the image element reload the clip from its first frame, and clears the
 *     pending timer, which is what restarts the six seconds instead of leaving the first one's clock
 *     running. Nothing in the slot appends an element or leaves a callback behind.
 *
 * A fifth case is the one that must not be a case at all: a pack that names no question file, or
 * names one that is not on disk, has to leave the ball exactly as it was. `fetchAsk` answers `null`
 * for both and `playAskFrame` returns without painting, without throwing and without scheduling.
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

/** The hold the page schedules, read out of the page itself rather than restated here. */
const ASK_HOLD_MS = Number(/const ASK_HOLD_MS = (\d+)/.exec(shell)?.[1])
assert.ok(Number.isFinite(ASK_HOLD_MS) && ASK_HOLD_MS > 0, 'ASK_HOLD_MS is missing from the page')

const ASK = 'data:image/gif;base64,ASK'
const TOOL = 'data:image/gif;base64,TOOL'
const IDLE = 'data:image/gif;base64,IDLE'

interface GifInputs {
  askShown?: { src: string; step: number }
  dragging?: boolean
  dragSrc?: string
  dropShown?: { src: string; step: number }
  clickShown?: { src: string; step: number }
  wakeShown?: { src: string; step: number }
  doneShown?: { src: string; step: number }
  arriveShown?: { src: string; step: number }
  agentState?: string
  agentTool?: string
  toolSrc?: string
  idleSrc?: string
  /**
   * Whether the carry is one pulled out of the dock, which outranks the question face by not
   * wearing a carry face of its own — see the case below.
   */
  carriedFromDock?: boolean
}

/**
 * Run the page's own `syncGif` with every pose this file is not about disarmed, and report the
 * mode it chose. Disarmed rather than stubbed, so a change that moves a branch above or below the
 * question face shows up as this function's answer changing.
 */
function modeFor(inputs: GifInputs): string {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const factory = new Function('deps', `
    const { document, pageClosed, syncSleep, dragging, dragSrc, dropShown, dockArriveShown, clickShown, arriveShown,
            wakeShown, doneShown, failShown, askShown, typingSrc, replySrc, toolSrc, thinkingSrc, speakSrc,
            speakActive, voiceSrc, dictationPhase, idleSrc, hoverSrc, introTimer, napShown, skitInfo,
            running, asking, tccGateVisible, attachedSelection, expanded, avatarSrc, freezeGif, Date,
            sleepFrameAt, skitFrame, hoverIntroSrc, introUntil, hovering, agentState,
            agentTool, brokeNow, dragIntroSrc, dragIntroUntil, carriedFromDock, docked } = deps
    ${pageFunction(shell, 'syncGif')}
    return syncGif
  `)
  const syncGif = factory({
    document: { querySelector: () => gif },
    pageClosed: () => false,
    syncSleep: () => {},
    // The poor face is a decision about the resting loop, which every case below sits above.
    brokeNow: () => false,
    dragging: inputs.dragging ?? false,
    dragSrc: inputs.dragging === true ? 'data:image/gif;base64,DRAG' : undefined,
    dragIntroSrc: undefined,
    dragIntroUntil: 0,
    carriedFromDock: inputs.carriedFromDock ?? false,
    dropShown: inputs.dropShown,
    // The docked arrival is disarmed here the way it is at rest: nothing is docked in a case that is
    // about another face, so the branch above every one of them has to be reachable and inert.
    dockArriveShown: undefined,
    // And nothing is docked, which is what lets the resting loop be reached at all: a docked ball
    // wears the strip's faces, never the idle loop.
    docked: undefined,
    clickShown: inputs.clickShown,
    arriveShown: inputs.arriveShown,
    wakeShown: inputs.wakeShown,
    doneShown: inputs.doneShown,
    // Named because the branch above this one reads it, and disarmed because these cases are about the
    // question face: a run that failed is not what any of them is showing. `walk_fail_sequence.mjs`
    // is where the failure face is walked for real.
    failShown: undefined,
    askShown: inputs.askShown,
    typingSrc: undefined,
    replySrc: undefined,
    toolSrc: inputs.toolSrc,
    thinkingSrc: undefined,
    speakSrc: undefined,
    speakActive: false,
    voiceSrc: undefined,
    dictationPhase: 'idle',
    idleSrc: inputs.idleSrc ?? IDLE,
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
    agentState: inputs.agentState ?? '',
    agentTool: inputs.agentTool ?? '',
  }) as () => void
  syncGif()
  assert.notEqual(gif.dataset.mode, undefined, 'syncGif fell through every branch without painting')
  return gif.dataset.mode as string
}

describe('the question face in syncGif', () => {
  it('wears the question face while it is up', () => {
    assert.equal(modeFor({ askShown: { src: ASK, step: 1 } }), 'ask-1')
  })

  it('outranks the tool face it actually arrives as', () => {
    // The whole feature in one assertion. A question is a running tool call, so this is the state
    // the ball is in for every second of the wait; a branch below it is dead code that no test of
    // the picker, the IPC or the preload could ever notice.
    assert.equal(modeFor({
      askShown: { src: ASK, step: 1 },
      agentState: 'tooling',
      agentTool: 'ask_user_question',
      toolSrc: TOOL,
    }), 'ask-1')
  })

  it('outranks a turn that just ended, and the greeting', () => {
    // A turn that ends by asking, or a question asked inside the first seconds of a page's life:
    // the user is waiting on the card either way, and both faces are shorter than the wait.
    assert.equal(modeFor({
      askShown: { src: ASK, step: 3 },
      doneShown: { src: 'data:image/gif;base64,DONE', step: 1 },
      arriveShown: { src: 'data:image/gif;base64,ARRIVE', step: 1 },
    }), 'ask-3')
  })

  it('outranks the resting loop it replaced', () => {
    assert.notEqual(modeFor({ askShown: { src: ASK, step: 1 } }), 'idle')
  })

  it('yields to the user’s own hand, and to the wake reaction', () => {
    // A carry, a release and a click are all the user acting on the ball right now; the wake chime
    // is their own voice being answered. Each is shorter than this hold, and each is a cue that
    // would be lost outright if a six-second face covered it — while this one, being a hold,
    // simply resumes for whatever is left of its six seconds.
    assert.equal(modeFor({ dragging: true, askShown: { src: ASK, step: 1 } }), 'drag')
    assert.equal(modeFor({
      dropShown: { src: 'data:image/gif;base64,DROP', step: 1 },
      askShown: { src: ASK, step: 1 },
    }), 'drop-1')
    assert.equal(modeFor({
      clickShown: { src: 'data:image/gif;base64,CLICK', step: 1 },
      askShown: { src: ASK, step: 1 },
    }), 'click-1')
    assert.equal(modeFor({
      wakeShown: { src: 'data:image/gif;base64,WAKE', step: 1 },
      askShown: { src: ASK, step: 1 },
    }), 'wake-1')
  })

  it('goes back to the resting loop once the beat is over', () => {
    assert.equal(modeFor({ askShown: undefined }), 'idle')
  })
})

/** A clock that keeps every scheduled callback, so a stacked hold is countable. */
class FakeClock {
  private next = 1
  readonly pending = new Map<number, { ms: number; callback: () => void }>()
  private savedSet: typeof setTimeout | undefined
  private savedClear: typeof clearTimeout | undefined

  install(): void {
    this.savedSet = globalThis.setTimeout
    this.savedClear = globalThis.clearTimeout
    globalThis.setTimeout = ((callback: () => void, ms: number) => {
      const id = this.next
      this.next += 1
      this.pending.set(id, { ms, callback })
      return id
    }) as never
    globalThis.clearTimeout = ((id: number) => {
      this.pending.delete(id)
    }) as never
  }

  restore(): void {
    globalThis.setTimeout = this.savedSet as never
    globalThis.clearTimeout = this.savedClear as never
  }

  /** Every hold still pending, in milliseconds — one entry per live callback. */
  get holds(): number[] {
    return [...this.pending.values()].map((timer) => timer.ms)
  }

  /** Fire the pending holds, newest first, and report how many ran. */
  fireAll(): number {
    const running = [...this.pending.entries()]
    this.pending.clear()
    for (const [, timer] of running) timer.callback()
    return running.length
  }
}

interface AskHarness {
  readonly modes: (string | undefined)[]
  readonly clock: FakeClock
  /** What the image element is showing right now, or `undefined` while nothing has painted it. */
  painted(): string | undefined
  play(): void
  flush(): Promise<void>
}

type Frame = { src: string; ms: number; loops: boolean }

/**
 * Build a `playAskFrame` against a stubbed `fetchAsk`, and report what it paints.
 *
 * The page's own `setTimeout`/`clearTimeout` are the ambient globals this function calls, so the
 * clock is installed around each play rather than injected — which is also what lets `askStep`
 * survive two questions in one harness, the whole point of the stacking case below.
 *
 * `cached` is the frame the page already holds: a real one for the ordinary case, `undefined` for
 * the question that beats the frame sweep, and `null` for a pack that names no question file at
 * all. `fetched` is what the on-demand read answers, so the two can be told apart.
 */
function askHarness(cached: Frame | null | undefined, fetched: Frame | null = cached ?? null): AskHarness {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const modes: (string | undefined)[] = []
  const factory = new Function('deps', `
    const { gif, ASK_HOLD_MS } = deps
    let askFrame = deps.FRAME
    let askShown
    let askTimer
    let askStep = 0
    let askPending = false
    const fetchAsk = async () => deps.FETCHED
    const syncGif = () => {
      if (askShown !== undefined) {
        const mode = \`ask-\${askShown.step}\`
        if (gif.dataset.mode !== mode) { gif.dataset.mode = mode; gif.src = askShown.src }
        return
      }
      gif.dataset.mode = 'idle'
    }
    ${pageFunction(shell, 'playAskFrame')}
    return { play: playAskFrame }
  `)
  const built = factory({ gif, ASK_HOLD_MS, FRAME: cached, FETCHED: fetched }) as { play: () => void }
  const clock = new FakeClock()
  const painted = (): string | undefined => gif.dataset.mode
  return {
    modes,
    clock,
    painted,
    play: () => {
      clock.install()
      try {
        built.play()
      } finally {
        clock.restore()
      }
      modes.push(painted())
    },
    flush: async () => {
      // The on-demand read resolves on a microtask, and the play it re-enters schedules its hold on
      // whatever clock is ambient at that point — so the clock goes on around the flush too. No
      // macrotask boundary is crossed, so the test framework's own timers are never swapped.
      clock.install()
      try {
        await Promise.resolve()
        await Promise.resolve()
      } finally {
        clock.restore()
      }
      modes.push(painted())
    },
  }
}

describe('playing the question face', () => {
  it('holds it for the fixed beat, and puts it away when the beat expires', () => {
    const harness = askHarness({ src: ASK, ms: 1120, loops: true })
    harness.play()
    assert.equal(harness.modes[0], 'ask-1')
    // Not one pass of the clip: the shipped question GIF loops every 1120ms, and `oneShotHoldMs`
    // would hand it 952ms of a six-second wait.
    assert.deepEqual(harness.clock.holds, [ASK_HOLD_MS])
    assert.equal(harness.clock.fireAll(), 1)
    assert.equal(harness.painted(), 'idle', 'the question face outstayed its own beat')
  })

  it('takes a new step for a second question, so the clip replays instead of freezing', () => {
    const harness = askHarness({ src: ASK, ms: 1120, loops: true })
    harness.play()
    harness.play()
    assert.deepEqual(harness.modes, ['ask-1', 'ask-2'],
      'the second question reused the first mode, so the GIF would not have restarted')
  })

  it('leaves exactly one hold pending however many questions arrive', () => {
    // The "no stacking" invariant, counted rather than asserted in prose: three questions, three
    // scheduled holds, two of them cleared — one live callback, one image element, one face.
    const harness = askHarness({ src: ASK, ms: 1120, loops: true })
    harness.play()
    harness.play()
    harness.play()
    assert.equal(harness.clock.holds.length, 1, 'a question left more than one hold pending')
    assert.deepEqual(harness.clock.holds, [ASK_HOLD_MS])
    assert.equal(harness.clock.fireAll(), 1, 'more than one hold was still able to end the face')
    assert.equal(harness.painted(), 'idle')
  })

  it('restarts the beat from the second question rather than the first', () => {
    // Firing the one live callback after the second question is what "reset" means: the face comes
    // down six seconds after the *latest* question, not six seconds after the first one.
    const harness = askHarness({ src: ASK, ms: 1120, loops: true })
    harness.play()
    const first = [...harness.clock.pending.entries()][0]?.[0]
    harness.play()
    assert.equal(harness.clock.pending.has(first as number), false,
      'the first question’s hold was still armed, so the face could come down mid-second-question')
    assert.equal(harness.clock.fireAll(), 1)
    assert.equal(harness.painted(), 'idle')
  })

  it('reads a frame that has not arrived yet, and paints the face when it does', async () => {
    // The first question after a page load can beat the frame sweep, and waiting for a poll timer
    // before answering the agent's question is not on. The cold cache reads instead of skipping.
    const cold = askHarness(undefined, { src: ASK, ms: 1120, loops: true })
    cold.play()
    assert.equal(cold.painted(), undefined, 'the cold cache painted a face it did not have')
    assert.deepEqual(cold.clock.holds, [], 'the cold cache scheduled a hold for a frame it never got')
    await cold.flush()
    assert.equal(cold.painted(), 'ask-1')
    assert.deepEqual(cold.clock.holds, [ASK_HOLD_MS])
  })

  it('paints nothing at all when there is no frame, and never throws', async () => {
    // The pack names no question file, or names one that is not on disk: the read answers null and
    // the ball keeps the face it had. No paint, no hold, no error — the question card still works.
    const missing = askHarness(null, null)
    missing.play()
    await missing.flush()
    assert.deepEqual(missing.modes, [undefined, undefined])
    assert.equal(missing.painted(), undefined)
    assert.deepEqual(missing.clock.holds, [])
  })
})

/**
 * The page's own `fetchAsk`, against a stubbed bridge, running the page's own `timedFrameOf` and
 * `loopsForever` as well: what the slot accepts as a frame is part of what is under test, and a
 * harness that passed anything through would prove nothing about the malformed answer.
 *
 * The two shapes of "there is no frame" both have to be silent rather than fatal, and both are the
 * same answer to the caller (`null`) — which is what lets `playAskFrame` be written without a
 * single try/catch of its own.
 */
function fetchAskWith(api: unknown): () => Promise<unknown> {
  const factory = new Function('deps', `
    const { api } = deps
    ${pageFunction(shell, 'loopsForever')}
    ${pageFunction(shell, 'timedFrameOf')}
    ${pageFunction(shell, 'fetchAsk')}
    return fetchAsk
  `)
  return factory({ api }) as () => Promise<unknown>
}

describe('the question face with nothing to wear', () => {
  it('answers null when the pack names no question file', async () => {
    assert.equal(await fetchAskWith({ memeAsk: async () => null })(), null)
  })

  it('answers null when the helper is an older build with no such channel', async () => {
    // The channel is newer than the bridge in a half-updated install, and a page that threw here
    // would take the question card down with it.
    assert.equal(await fetchAskWith({})(), null)
    assert.equal(await fetchAskWith({ memeAsk: async () => { throw new Error('no handler') } })(), null)
  })

  it('answers null for a frame that is not a usable timed frame', async () => {
    // An empty `src` or a missing length is what a half-written slot resolves to, and neither is
    // something the ball can wear.
    for (const frame of [{ src: '', ms: 100 }, { src: ASK, ms: 0 }, { src: ASK }, null, 'nonsense']) {
      assert.equal(await fetchAskWith({ memeAsk: async () => frame })(), null, JSON.stringify(frame))
    }
  })

  it('reads the loop flag off the frame’s own bytes, so the hold decision is not the harness’s', async () => {
    const frame = { src: ASK, ms: 1120 }
    assert.deepEqual(await fetchAskWith({ memeAsk: async () => frame })(), { ...frame, loops: false })
  })
})

describe('the question face is wired to the question card', () => {
  it('plays on the card, and only after the payload has been accepted', () => {
    const show = pageFunction(shell, 'showQuestion')
    const guard = show.indexOf('payload.questions.length === 0) return')
    const play = show.indexOf('playAskFrame()')
    assert.notEqual(guard, -1, 'the payload guard is gone')
    assert.notEqual(play, -1, 'nothing plays the question face when a question arrives')
    assert.ok(play > guard, 'a malformed payload would still start a six-second face')
  })

  it('plays on the repeat path too, which is what resets the beat', () => {
    // The card already knows this question; the face still has to be restarted, because the repeat
    // is the agent asking again and the six seconds are measured from the last time it asked.
    const show = pageFunction(shell, 'showQuestion')
    const play = show.indexOf('playAskFrame()')
    const repeat = show.indexOf('if (pending?.id === payload.id)')
    assert.notEqual(repeat, -1, 'the repeat path is gone')
    assert.ok(play < repeat, 'a repeated question does not reach the face at all')
  })

  it('prefetches the frame with the other named ones', () => {
    const sweep = pageFunction(shell, 'refreshFrames')
    assert.match(sweep, /askFrame === undefined \|\| askFrame === null/, 'the frame is loaded with the other named ones')
    assert.match(sweep, /await fetchAsk\(\)/, 'and read through the slot’s own fetch')
  })

  it('reaches every layer the other one-shots go through', () => {
    // Five layers, and a slot missing from any one of them fails silently: the ball simply never
    // changes face, and every test that only reads the picker still passes.
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    assert.match(main, /ipcMain\.handle\('orb:meme-ask'/, 'the helper answers the channel')
    assert.match(preload, /memeAsk\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-ask'\)/, 'the preload exposes it')
    assert.match(shell, /api\.memeAsk\(\)/, 'the page asks for the frame')
    assert.match(pageFunction(shell, 'syncGif'), /if \(askShown !== undefined\)/, 'the pose is reachable from syncGif')
    assert.match(pageFunction(shell, 'playAskFrame'), /askStep \+= 1/, 'a new step is what replays the clip')
  })

  it('keeps the question face above the agent’s working faces and below the wake reaction', () => {
    // Precedence is a deliberate order rather than an accident of layout. Above `tooling`, because
    // that is the face the ball is wearing for the entire wait; below the wake reaction, because a
    // six-second hold that swallowed the answer to the user's own voice is the worse trade.
    const gif = pageFunction(shell, 'syncGif')
    assert.ok(gif.indexOf('askShown !== undefined') < gif.indexOf("agentState === 'tooling'"),
      'the question face is below the tool face, which is the state it always arrives in')
    assert.ok(gif.indexOf('wakeShown !== undefined') < gif.indexOf('askShown !== undefined'),
      'the question face covers the wake reaction')
  })
})
