import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const page = readFileSync(join(here, '../client.js'), 'utf8')

// A wake used to reach the microphone by pressing the voice plugin's record button and reading its
// waveform. That is a different ear from the ball's, and a wake recorded that way behaves unlike the
// button beside it — a longer pause, a coarser end of sentence, a "插入文字" step when the plugin
// cannot place its transcript. The page now records every turn itself, so these assertions are about
// keeping the two doors on one ear rather than about any particular line.
describe('a wake turn uses the page\'s own recorder', () => {
  it('hands the turn to the shared recorder with the ball\'s numbers', () => {
    assert.match(
      page,
      /async function oneTurn\(command, afterReply = false\)[\s\S]{0,2000}?return await voiceTurn\(limits, command\.send === true, grace\)/,
      'a wake turn must run the same recorder the microphone button runs',
    )
  })

  it('no longer presses the voice plugin or reads its animation', () => {
    assert.doesNotMatch(page, /data-voice-activity/, 'the plugin\'s row and waveform are not this page\'s ear')
    assert.doesNotMatch(page, /开始录音/, 'pressing the plugin\'s record button is what a wake no longer does')
    assert.doesNotMatch(page, /插入文字/, 'the transcript is written here, so there is nothing to insert by hand')
  })

  it('shows the listening state on the microphone button, whichever door opened it', () => {
    assert.match(page, /window\.__dshOrbListening = \(\) => listening/, 'the button has to be able to read it')
    assert.match(page, /markListening\(true\)[\s\S]{0,400}?tone\(CUE_OPEN, 1\)/, 'the device opens behind a cue')
  })

  // Read-aloud is what broke the second sentence of every continuous exchange: the reply is played
  // through the speakers while the page is already reopening the microphone, and Chromium's echo
  // canceller gates the capture along with the echo. Measured on this machine: 0.0038 quiet against
  // 0.0017 while a tone plays. The wait has to come before the device opens.
  it('waits for read-aloud to finish before opening the device', () => {
    assert.match(
      page,
      /async function voiceTurn\(limits, send, graceMs = 0\) \{\s*try \{[\s\S]{0,400}?await waitForQuiet\(180_000, graceMs\)[\s\S]{0,400}?markListening\(true\)/,
      'a microphone opened into a reply that is still being read records the reply',
    )
    assert.match(page, /data-phase="playing"\], \[data-phase="preparing"/, 'the read-aloud button publishes its phase')
  })

  it('draws the level it measures, not an animation of it', () => {
    assert.match(page, /className = 'dsh-orb-level'/, 'the waveform overlay is part of this page')
    assert.match(page, /meterPush\(level\)/, 'the bars are fed from the samples the recorder measures')
  })

  // The composer is a Lexical editor, not a textarea: words written to its DOM are on screen while
  // the editor's own state stays empty, so the send button never enables and nothing leaves the box.
  // Text has to go in the way typing does, and the send has to be read back rather than assumed.
  it('writes the transcript through the editor and checks that it left', () => {
    assert.match(page, /const composerEditor = \(\) =>/, 'the composer is located before it is written to')
    assert.match(page, /execCommand\('insertText', false, next\)/, 'the text has to arrive as an insert, not as a DOM write')
    assert.match(page, /new InputEvent\('beforeinput'[\s\S]{0,120}?inputType: 'insertText'/, 'a refused execCommand falls back to the event behind it')
    assert.match(
      page,
      /async function submit\(text\)[\s\S]{0,900}?if \(gone\(\)\) return true/,
      'a click on a disabled send looks like a click that worked; the box is what answers',
    )
    assert.match(page, /if \(!\(await submit\(text\)\)\) \{[\s\S]{0,200}?return 'failed'/, 'a turn that stays in the box is not a sent turn')
  })

  // The ball's own recorder has always been given a grace after its chime; the hand-off to this
  // window had none, so its first frames could catch the tail of "我在". The grace is its own
  // constant, smaller than the chime's: the clip arrives with its silence trimmed, so `ended` is
  // already at the last syllable and only the output buffer is left to cover.
  it('gives the hand-off a grace of its own, not the chime one', () => {
    const shell = readFileSync(join(here, '../../helper/assets/shell.js'), 'utf8')
    assert.match(
      shell,
      /whenVoiceDone\(\d+_?\d*\)\.then\(\(\) => \{\s*setTimeout\(\(\) => \{ api\.mainVoiceStart\(\) \}, MAIN_VOICE_GAP_MS\)/,
      'the main window opens its microphone on its own grace',
    )
    assert.doesNotMatch(
      shell,
      /setTimeout\(\(\) => \{ api\.mainVoiceStart\(\) \}, DICTATION_DELAY_MS\)/,
      'the 350 ms chime grace is for a cue this page plays, not for a finished clip',
    )
    const gap = Number(/const MAIN_VOICE_GAP_MS = (\d+)/.exec(shell)[1])
    assert.ok(gap <= 150, `the hand-off grace stays short, got ${gap} ms`)
  })

  // The wait between a finished reading and the microphone reopening. The reader's `phase` only
  // returns to `idle` when its whole queue is empty, so a gap between two of its sentences does not
  // look idle — the tail does not have to guard against those, and 700 ms of it was heard as the
  // system thinking between the reply and the listener.
  it('reopens the microphone 200 ms after the reading ends, not a second', () => {
    const tail = Number(/const SPEECH_TAIL_MS = (\d+)/.exec(page)[1])
    const poll = Number(/const SPEAK_POLL_MS = (\d+)/.exec(page)[1])
    assert.ok(tail <= 200, `the tail after a reading stays under 200 ms, got ${tail}`)
    assert.ok(poll <= 60, `the reading is watched at least every 60 ms, got ${poll}`)
    assert.match(
      page,
      /Date\.now\(\) - idleAt >= \(spoke \? SPEECH_TAIL_MS : grace\)/,
      'the tail must be the constant above, not a literal',
    )
  })

  // `followUpMs` is the host's gap between a finished reply and the next turn. It is measured in
  // milliseconds of DOM update now: the turn opens with its own cue, so nothing is waiting on the
  // user noticing.
  it('keeps the gap after a reply in the same range', () => {
    const orb = readFileSync(join(here, '../../host/src/orb.ts'), 'utf8')
    const gap = Number(/const MAIN_VOICE_FOLLOW_UP_MS = (\d+)/.exec(orb)[1])
    assert.ok(gap <= 200, `the follow-up gap stays short, got ${gap}`)
  })

  // The microphone had one direction: pressing it opened a turn, and nothing but a pause closed
  // one. A press on a live button now ends the turn it started, and says so while it is live. A
  // turn that is running without the device being open — still waiting out the previous reply, or
  // already recognising the words — is a live turn too, and a press there must not be a press that
  // paints the button red for a turn that will never start.
  it('turns the microphone into a stop button while it is listening', () => {
    assert.match(
      page,
      /if \(recording \|\| live \|\| running\) \{[\s\S]{0,400}?host\.__dshOrbStopListening[\s\S]{0,400}?stop\(\) === true/,
      'a second press has to reach the bridge, and only ends a turn that is really open',
    )
    assert.match(
      page,
      /'aria-label': recording \? text\.micStop : text\.micLabel/,
      'the button says what the next press will do',
    )
  })

  // `whenVoiceDone()` resolves on `ended`, which is the end of the file — not the end of the
  // speech inside it. The clips shipped with half a second of silence around the two syllables,
  // so a wake spent that half second loading, and the wait was different on every take.
  it('hands over a clip with its silence already trimmed', () => {
    const voices = join(here, '../../helper/assets/voices')
    for (const name of ['c1.wav', 'c2.wav', 'c3.wav']) {
      const clip = readWav(join(voices, name))
      const gate = clip.peak * 0.05
      const window = Math.max(1, Math.round(clip.rate * 0.02))
      const loud = (from, step) => {
        for (let start = from; start >= 0 && start + window <= clip.samples.length; start += step) {
          let sum = 0
          for (let index = start; index < start + window; index += 1) sum += clip.samples[index] ** 2
          if (Math.sqrt(sum / window) >= gate) return start
        }
        return -1
      }
      const first = loud(0, 1)
      const last = loud(clip.samples.length - window, -1)
      const lead = (first / clip.rate) * 1000
      const tail = ((clip.samples.length - last - window) / clip.rate) * 1000
      assert.ok(lead <= 40, `${name}: ${lead.toFixed(0)} ms of silence before the first word`)
      assert.ok(tail <= 160, `${name}: ${tail.toFixed(0)} ms of silence after the last word`)
    }
  })
})

/** Enough of a WAV reader to measure a clip: RIFF chunks, 16-bit little-endian, mono or stereo. */
function readWav(path) {
  const buffer = readFileSync(path)
  let at = 12
  let rate = 0
  let channels = 1
  let samples = null
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4)
    const size = buffer.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      rate = buffer.readUInt32LE(body + 4)
      channels = buffer.readUInt16LE(body + 2)
    } else if (id === 'data') {
      const count = Math.floor(size / 2 / channels)
      samples = new Float32Array(count)
      for (let index = 0; index < count; index += 1) {
        const sample = buffer.readInt16LE(body + index * 2 * channels)
        samples[index] = sample / 32768
      }
    }
    at = body + size + (size % 2)
  }
  assert.ok(samples !== null && rate > 0, `${path} is not a readable WAV`)
  let peak = 0
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample))
  return { rate, channels, samples, peak }
}
