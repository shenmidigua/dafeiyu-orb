import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { WakeEngine } from '../assets/wake.js'
import { ContinuousVoice } from '../assets/voice-turn.js'

/**
 * Continuous conversation: say the wake word once, then talk turn after turn.
 *
 * The loop crosses four places that cannot see each other — the speaker's completion edge, the
 * page's scheduler, the wake engine's recorder, and the turn's own ending — so this file covers
 * the two that can be run on their own (the state machine and the recorder) and pins the wiring
 * that joins them. The behaviour under test is exactly the request:
 *
 *   reply finished -> microphone opens (after a "ding")
 *   speech heard   -> a normal turn, and the loop repeats
 *   nobody spoke   -> the quiet window closes the recorder ("duh") and the wake word waits again
 *   user stopped   -> same resting state, without waiting for a window
 */

/** An engine that never reaches the models: the recorder's own decisions are what is tested. */
function engine() {
  const wake = new WakeEngine({ wakeConfig: async () => ({}), wakeReport: async () => ({}) } as never)
  wake.running = true
  wake.runVad = async () => false
  wake.runModels = async () => {}
  wake.vadState.h = { data: new Float32Array(128).fill(0) }
  wake.vadState.c = { data: new Float32Array(128).fill(0) }
  return wake
}

/** One 80 ms frame of digital silence. */
function frame() {
  return new Float32Array(1280)
}

/** The recorder's own frames, as the worklet would hand them over. */
async function feed(wake: WakeEngine, count: number) {
  for (let index = 0; index < count; index += 1) await wake.collectDictation(frame())
}

/** The quiet window is clamped to its configured minimum; 80 ms is one frame. */
const QUIET_MS = 1600
const QUIET_FRAMES = QUIET_MS / 80

describe('the continuous exchange state machine', () => {
  it('opens the microphone when the reply is read, and returns to the wake word on silence', () => {
    // The whole loop in one test, in the order the page sees it: a dictated message arms the
    // exchange, the speaker's completion edge asks for the microphone, and an empty recording
    // ends the exchange. What "opens the microphone" means is `wantsOpen`, which the page's timer
    // reads; what "returns to the wake word" means is `idle`, which leaves the wake engine alone.
    const voice = new ContinuousVoice()
    assert.equal(voice.state, 'idle')

    voice.dictated()
    assert.equal(voice.state, 'armed', 'a sent voice message is what arms the exchange')
    assert.equal(voice.active, true)

    assert.equal(voice.spoken({ running: false, asking: false, error: '' }), 'opening')
    assert.equal(voice.wantsOpen, true)
    assert.equal(voice.active, true)

    // The recorder's quiet window ran out; `startDictation` reports that by cancelling.
    voice.cancel()
    assert.equal(voice.state, 'idle')
    assert.equal(voice.wantsOpen, false, 'the wake word is the only listener left')
  })

  it('waits for a reply read in the middle of a turn, then opens when the turn ends', () => {
    // A mid-turn narration block is read while the agent is still working. Opening there would
    // record the agent's next block as the user's answer, so the exchange waits for the turn.
    const voice = new ContinuousVoice()
    voice.dictated()
    assert.equal(voice.spoken({ running: true }), 'waiting')
    assert.equal(voice.wantsOpen, false)

    assert.equal(voice.turnEnded(), 'opening')
    assert.equal(voice.wantsOpen, true)
  })

  it('does not reopen after a failed or cancelled reading', () => {
    const voice = new ContinuousVoice()
    voice.dictated()
    // A cancelled reading never raises the speaker's `finished` edge at all; a failed one does,
    // but with its reason attached. The latter is the one the state machine has to refuse.
    assert.equal(voice.spoken({ error: 'offline' }), 'idle')
    assert.equal(voice.wantsOpen, false)
  })

  it('does not reopen after the user stopped the turn', () => {
    for (const ending of [{ interrupted: true }, { failed: true }]) {
      const voice = new ContinuousVoice()
      voice.dictated()
      voice.spoken({ running: true })
      assert.equal(voice.turnEnded(ending), 'idle')
      assert.equal(voice.wantsOpen, false)
    }
  })

  it('does not reopen after a typed message or a disabled feature', () => {
    const typed = new ContinuousVoice()
    typed.dictated()
    typed.spoken({ running: true })
    assert.equal(typed.cancel(), 'idle')

    const off = new ContinuousVoice({ enabled: false })
    assert.equal(off.dictated(), 'idle', 'a disabled switch never arms an exchange')
    assert.equal(off.spoken({ running: false }), 'idle')
    assert.equal(off.wantsOpen, false)
  })

  it('keeps a second finished block from opening the microphone early', () => {
    // Two blocks finishing before the delay expires must not queue two openings: the page reads
    // `wantsOpen` once per timer, and a `waiting` state makes the earlier timer a no-op.
    const voice = new ContinuousVoice()
    voice.dictated()
    voice.spoken({ running: false })
    voice.spoken({ running: true })
    assert.equal(voice.state, 'waiting')
    assert.equal(voice.wantsOpen, false)
  })
})

describe('a continuous recording that hears nothing', () => {
  it('closes itself, sounds the single shut cue, and reports the wake word listening again', async () => {
    const wake = engine()
    const cues: string[] = []
    const states: string[] = []
    wake.state = 'detected'
    wake.playShutTone = () => { cues.push('shut') }
    wake.playCloseTone = (captured: boolean) => { cues.push(`close:${captured}`) }
    wake.publish = async (state: string) => {
      states.push(state)
      wake.state = state
    }

    const utterance = wake.dictate({ noSpeechMs: QUIET_MS, cue: 'continuous' })
    await feed(wake, QUIET_FRAMES)
    const wav = await utterance

    assert.equal(wav, undefined, 'nothing was said, so there is no audio to transcribe')
    assert.deepEqual(cues, ['shut'], 'the close cue is the single "duh", not the failed-recording knocks')
    assert.deepEqual(states, ['listening'], 'the badge returns to the wake word as the cue sounds')
    assert.equal(wake.dictation, undefined, 'the recorder is released')
    assert.equal(wake.melBuffer.length, 0, 'the wake word cannot re-arm itself from the old audio')
  })

  it('keeps the two-knock cue for an ordinary dictation that hears nothing', async () => {
    const wake = engine()
    const cues: string[] = []
    wake.playShutTone = () => { cues.push('shut') }
    wake.playCloseTone = (captured: boolean) => { cues.push(`close:${captured}`) }

    const utterance = wake.dictate({ noSpeechMs: QUIET_MS })
    await feed(wake, QUIET_FRAMES)
    assert.equal(await utterance, undefined)
    assert.deepEqual(cues, ['close:false'], 'a normal empty recording keeps its existing cue')
  })
})

/**
 * The wiring the page adds around those two pieces.
 *
 * These are source assertions rather than a page run because `shell.js` is one large module that
 * opens a microphone, fetches models and draws the ball; the shape is what is easy to lose — an
 * edge that stops listening, a recorder opened without its cue, a timeout that leaves the
 * exchange armed — and each assertion names the consequence, not just the line.
 */
const shell = readFileSync(fileURLToPath(new URL('../assets/shell.js', import.meta.url)), 'utf8')
const speech = readFileSync(fileURLToPath(new URL('../assets/speech.js', import.meta.url)), 'utf8')

describe('the page wiring for the continuous loop', () => {
  it('turns the speaker completion edge into one scheduled microphone opening', () => {
    assert.match(shell, /import \{ ContinuousVoice \} from '\.\/voice-turn\.js'/)
    assert.match(shell, /if \(state\.finished !== speechFinished\) \{/)
    assert.match(shell, /const next = continuousVoice\.spoken\(\{/)
    assert.match(shell, /if \(next === 'opening'\) scheduleVoiceTurn\(\)/)
  })

  it('plays the opening cue before the recorder starts, and passes the configured quiet window', () => {
    const start = shell.slice(shell.indexOf('async function startDictation'), shell.indexOf('function applyTranscript'))
    assert.match(start, /if \(continuous\) wake\.playOpenTone\(\)/)
    // Before the delay, so the tone is over before the first frame can be scored as speech.
    assert.ok(start.indexOf('playOpenTone') < start.indexOf('await wait('))
    assert.match(start, /noSpeechMs: continuousNoSpeechMs\(\)/)
    assert.match(start, /cue: 'continuous'/)
  })

  it('closes the exchange when the recorder heard nothing, and only schedules when it may open', () => {
    const start = shell.slice(shell.indexOf('async function startDictation'), shell.indexOf('function applyTranscript'))
    assert.match(start, /status\.textContent = continuous \? messages\.continuousEmpty : messages\.dictationEmpty/)
    assert.match(start, /if \(continuous \|\| voiceTurn\) continuousVoice\.cancel\(\)/)
    assert.match(shell, /if \(!continuousVoice\.wantsOpen\) return/)
    // The microphone belongs to the main window's composer now, so the scheduled turn closes the
    // exchange instead of opening the ball's own recorder. A stray `startDictation({ continuous })`
    // would put a second recorder on the same device.
    assert.doesNotMatch(shell, /void startDictation\(\{ continuous: true \}\)/)
    assert.match(shell, /continuousVoice\.cancel\(\)\s*\}, CONTINUOUS_TURN_DELAY_MS\)/)
  })

  it('returns to the wake word when the turn or the reading is stopped', () => {
    assert.match(shell, /continuousVoice\.turnEnded\(\{ interrupted, failed \}\)/)
    assert.match(shell, /speaker\.cancel\(\)\n\s+\/\/ The user stopped the reading on purpose[\s\S]*?continuousVoice\.cancel\(\)/)
    assert.match(shell, /if \(!voiceSubmit\) continuousVoice\.cancel\(\)/)
  })

  it('counts only normal settles as "the reply was read to its end"', () => {
    // The page needs the edge, and a cancelled reading must not raise it: `settle` only moves the
    // counter when the run says every sentence played, while `cancel()` clears the state without
    // touching it.
    assert.match(speech, /this\.finished = 0/)
    assert.match(speech, /finished: this\.finished/)
    const settle = speech.slice(speech.indexOf('  settle(generation, completed = false) {'))
    assert.ok(settle !== '', 'the settle signature is what the slice below hinges on')
    assert.match(settle.slice(0, settle.indexOf('\n  }')), /if \(completed\) this\.finished \+= 1/)
  })
})
