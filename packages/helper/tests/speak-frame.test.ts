/**
 * The read-aloud frame: what the ball wears while the speaker is talking, and what puts it back.
 *
 * This slot exists because the page had no face for it — `voice` is the *dictation* pose (the user
 * talking into the microphone) and `reply` is the agent streaming text, so a finished answer being
 * read aloud had nothing of its own and fell through to whatever was left over.
 *
 * Two things are easy to get wrong and expensive to notice, so both are pinned here:
 *
 *   * the *edges*. The speaker is the only thing that knows when a sentence starts and when the
 *     last one ends, and those are two separate events. A redraw on only one of them is how this
 *     page has already shipped one stuck pose (`endDictation` forgot its `syncGif`). The comment in
 *     the page claims both edges repaint; this file is what makes that claim checkable.
 *   * the *priority*. Read-aloud deliberately outranks dictation, because when the two overlap the
 *     thing the user can hear is the one the face should be showing. That is a judgement call, and
 *     a judgement call that nobody re-checks is a judgement call that quietly changes.
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

/**
 * The same cut, for a function the page assigns rather than declares.
 *
 * `syncSpeechButtons` is written as `syncSpeechButtons = function (state) { … }` because the
 * speaker is constructed at module scope, long before the page reaches the definition. Cutting it
 * out by name alone would fail on a function that exists and works. It comes back *named*, so it
 * can be pasted into a test body as a declaration rather than as a block.
 */
function assignedFunction(source: string, name: string): string {
  const head = source.indexOf(`${name} = function`)
  assert.notEqual(head, -1, `${name} is not assigned in the page`)
  // `head` sits on the name, so the `function` keyword begins `name.length` plus `" = "` later.
  const start = head + name.length + ' = '.length
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return `function ${name}${source.slice(start + 'function'.length, i + 1)}`
    }
  }
  throw new Error(`${name} never closes`)
}

const SPEAK = 'data:image/gif;base64,SPEAK'
const VOICE = 'data:image/gif;base64,VOICE'
const IDLE = 'data:image/gif;base64,IDLE'

interface GifInputs {
  speakSrc?: string
  speakActive?: boolean
  voiceSrc?: string
  dictationPhase?: string
}

/**
 * Run `syncGif` with every higher-priority pose disarmed, and report which `dataset.mode` it chose.
 *
 * The one-shot reactions and the agent's own frames are all left undefined rather than stubbed, so
 * a change that puts a new branch above the speaking frame shows up as this test's answer changing
 * rather than as a silent behaviour change in the orb.
 */
function modeFor(inputs: GifInputs): string {
  const gif = { dataset: {} as { mode?: string; src?: string } }
  const factory = new Function('deps', `
    const { document, pageClosed, syncSleep, dragging, clickShown, arriveShown, wakeShown, doneShown,
            typingSrc, replySrc, toolSrc, thinkingSrc, speakSrc, speakActive, voiceSrc,
            dictationPhase, dropShown, dropStep, webfetchSrc, agentState, agentTool,
            WEB_FETCH_TOOL, brokeNow } = deps
    ${pageFunction(shell, 'syncGif')}
    return syncGif
  `)
  const syncGif = factory({
    document: { querySelector: () => gif },
    pageClosed: () => false,
    syncSleep: () => {},
    // The poor face is off: this file is about the ball talking, and the account's balance has
    // nothing to do with that. `dsh_orb/walk_poor_sequence.mjs` walks the real predicate.
    brokeNow: () => false,
    dragging: false,
    clickShown: undefined,
    // The arrival is disarmed the same way and for the same reason: this page has been open for
    // longer than its greeting lasts, and leaving it undefined is what shows the speaking frame
    // does not have to wait for a greeting to finish.
    arriveShown: undefined,
    wakeShown: undefined,
    doneShown: undefined,
    typingSrc: undefined,
    replySrc: undefined,
    toolSrc: undefined,
    thinkingSrc: undefined,
    speakSrc: inputs.speakSrc,
    speakActive: inputs.speakActive ?? false,
    voiceSrc: inputs.voiceSrc,
    dictationPhase: inputs.dictationPhase ?? 'idle',
    // A new branch above this one has to be named here, or the harness dies with
    // "dropShown is not defined" instead of reporting which mode won. It stays undefined because
    // no release is in progress while the speaker is talking. The fetch face is disarmed the same
    // way: nothing is being fetched in these cases, and leaving it undefined is what proves this
    // slot does not reach up past the speaking frame.
    dropShown: undefined,
    dropStep: 0,
    webfetchSrc: undefined,
    agentState: '',
    agentTool: '',
    WEB_FETCH_TOOL: 'web_fetch',
  }) as () => void
  syncGif()
  assert.notEqual(gif.dataset.mode, undefined, 'syncGif fell through every branch without painting')
  return gif.dataset.mode as string
}

describe('the read-aloud frame', () => {
  it('wears the speaking frame while the speaker is talking', () => {
    assert.equal(modeFor({ speakSrc: SPEAK, speakActive: true }), 'speak')
  })

  it('stops wearing it the moment the audio ends', () => {
    // The regression this whole slot was added to prevent, in its simplest form: a frame that
    // outlasts the state that asked for it.
    assert.notEqual(modeFor({ speakSrc: SPEAK, speakActive: false, voiceSrc: VOICE,
      dictationPhase: 'recording' }), 'speak')
  })

  it('outranks dictation, because the ball is the one making the noise', () => {
    assert.equal(modeFor({ speakSrc: SPEAK, speakActive: true, voiceSrc: VOICE,
      dictationPhase: 'recording' }), 'speak')
  })

  it('leaves dictation its own frame when nothing is being read aloud', () => {
    assert.equal(modeFor({ speakSrc: SPEAK, speakActive: false, voiceSrc: VOICE,
      dictationPhase: 'recording' }), 'voice')
  })

  it('does not paint a frame that was never configured', () => {
    // An unconfigured slot must behave exactly as it did before this feature existed, rather than
    // painting `undefined` into the image.
    assert.equal(modeFor({ speakSrc: undefined, speakActive: true, voiceSrc: VOICE,
      dictationPhase: 'recording' }), 'voice')
  })
})

/**
 * Drive `syncSpeechButtons` with a stub speaker state and count the repaints it asks for.
 *
 * The feature is on but no buttons exist, so the button loop has nothing to do and every repaint
 * counted here came from the state edge rather than from a button being repainted as a side effect.
 * `speakActive` and `speechStatus` are re-declared with `let` rather than pulled out of `deps`:
 * they are the two things this function assigns, and a `const` binding would fail the first
 * assignment instead of testing the branch that follows it.
 */
function repaintsFor(sequence: boolean[], frameLoaded = true): {
  repaints: number; loads: number; mutes: number; unmutes: number
} {
  const status = { textContent: '' }
  const factory = new Function('deps', `
    const { speechButtons, status, speechStatusText, paintSpeakButton, speakSrc,
            loadSpeakFrame, syncGif, wake } = deps
    let speakActive = false
    let speechStatus = ''
    ${assignedFunction(shell, 'syncSpeechButtons')}
    return (state) => syncSpeechButtons(state)
  `)
  const counter = { repaints: 0, loads: 0, mutes: 0, unmutes: 0 }
  const call = factory({
    speechButtons: new Map(),
    status,
    speechStatusText: () => '',
    paintSpeakButton: () => {},
    // `frameLoaded` decides whether the page still has to fetch the GIF. With it already in hand the
    // repaint count is about the edges alone; without it the on-demand fetch has its own test.
    speakSrc: frameLoaded ? SPEAK : undefined,
    loadSpeakFrame: () => { counter.loads += 1 },
    syncGif: () => { counter.repaints += 1 },
    // Declared, and counted, rather than merely defined: the mute rides the same edge as the
    // repaint, and a stub that swallowed it would let this file keep passing after the wake word
    // had stopped being muted. `wake-mute-wiring.test.ts` covers the shape; this covers the fact
    // that this function is what calls it.
    wake: {
      mute: () => { counter.mutes += 1 },
      unmute: () => { counter.unmutes += 1 },
    },
  }) as (state: { speaking: boolean; enabled: boolean }) => void

  for (const speaking of sequence) call({ speaking, enabled: true })
  return { ...counter }
}

describe('the read-aloud repaint', () => {
  it('repaints on both edges, not just the one that starts the audio', () => {
    // start → stop is two events and needs two repaints. One repaint here is the stuck-pose bug.
    const both = repaintsFor([true, false])
    assert.equal(both.repaints, 2, 'starting and stopping must each repaint the ball')

    const startOnly = repaintsFor([true])
    assert.equal(startOnly.repaints, 1)
  })

  it('does not repaint when nothing changed', () => {
    // The speaker emits on every sentence boundary, so a naive edge check that fires on the state
    // rather than on the change would repaint several times per reply for no reason.
    assert.equal(repaintsFor([true, true, true]).repaints, 1)
    assert.equal(repaintsFor([false, false]).repaints, 0)
  })

  it('asks for the frame when audio starts before the frames have been swept', () => {
    // The first reply of a session can begin before `refreshFrames` has made its round, and a pose
    // that arrives late on the one occasion the user is listening for it is a pose they never see.
    // Asked for exactly once, on the edge that needs it — not on every sentence of the reply.
    assert.equal(repaintsFor([true], false).loads, 1)
    assert.equal(repaintsFor([true, false, true], false).loads, 2)
    assert.equal(repaintsFor([true], true).loads, 0, 'no refetch when the frame is already in hand')
  })

  it('mutes the wake word on exactly the edges it repaints on', () => {
    // The mute shares this function's edge because this function is the only place both edges of
    // the speaking state are visible. Counting them separately is the point: a mute on the level
    // rather than the edge would reset the embedding ring on every per-sentence state the speaker
    // emits, so the wake word would restart from silence between clauses.
    const both = repaintsFor([true, false])
    assert.equal(both.mutes, 1, 'starting to speak did not mute the wake word')
    assert.equal(both.unmutes, 1, 'finishing the last sentence left the wake word muted')

    const repeated = repaintsFor([true, true, true, false, false])
    assert.equal(repeated.mutes, 1, 'per-sentence states re-muted an engine that was already muted')
    assert.equal(repeated.unmutes, 1, 'per-sentence states un-muted an engine that was still speaking')
    assert.equal(repeated.repaints, 2)
  })

  it('keeps the wake word scoring when read-aloud never runs', () => {
    // The mute is driven entirely by the speaking edge, so a session in which the feature is off
    // must leave the wake word untouched. A mute on `state.speaking` rather than on the change
    // would fire here on every state and leave the feature permanently deaf after one reply.
    assert.equal(repaintsFor([false, false, false]).mutes, 0)
  })
})

describe('the read-aloud slot end to end', () => {
  it('is wired from the config through the helper to the page', () => {
    // Four hops, and each one can be missing while every test above still passes, because they all
    // stub the hop. A renamed channel is the failure that only shows up as a ball that stays quiet.
    const memes = readFileSync(join(here, '../src/memes.ts'), 'utf8')
    const main = readFileSync(join(here, '../src/main.ts'), 'utf8')
    const preload = readFileSync(join(here, '../preload.cjs'), 'utf8')

    assert.match(memes, /speak: NamedFrame/, 'the config type carries the slot')
    assert.match(memes, /speak: readNamed\(record\.speak\)/, 'the config file is parsed for it')
    assert.match(memes, /async speak\(\) \{[\s\S]*?named\(current\.speak, current\.dirs\)/,
      'the picker resolves it')
    assert.match(main, /ipcMain\.handle\('orb:meme-speak'/, 'the helper answers the channel')
    assert.match(preload, /memeSpeak\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-speak'\)/,
      'the preload exposes it')
    assert.match(shell, /api\.memeSpeak\(\)/, 'the page asks for the frame')
  })
})
