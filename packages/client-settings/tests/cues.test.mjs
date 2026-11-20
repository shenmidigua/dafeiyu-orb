import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

const page = readFileSync(join(root, 'packages/client-settings/client.js'), 'utf8')
const engine = readFileSync(join(root, 'packages/helper/assets/wake.js'), 'utf8')

/** Pull `const NAME = [ ... ]` out of a source file and read the note objects it holds. */
function notesIn(source, name) {
  const match = source.match(new RegExp(`const ${name} = (\\[[^\\]]*\\])`))
  assert.ok(match, `${name} is missing`)
  return [...match[1].matchAll(/\{([^}]*)\}/g)].map((entry) => {
    const at = Number(entry[1].match(/at:\s*([\d.]+)/)[1])
    const freq = Number(entry[1].match(/freq:\s*([\d.]+)/)[1])
    const len = Number(entry[1].match(/len:\s*([\d.]+)/)[1])
    // The ball's cues are all sine, so an absent waveform is the sine one.
    const type = (entry[1].match(/type:\s*'(\w+)'/) ?? [undefined, 'sine'])[1]
    return { at, freq, len, type }
  })
}

describe('the main window speaks the ball\'s cue language', () => {
  // A cue copied once drifts: someone retunes the ball, the page keeps the old pitch, and the two
  // halves of the same feature stop sounding like each other. Read both sides instead of trusting
  // a comment that says "same as wake.js".
  it('uses the same notes, timing and order as the wake engine', () => {
    const pairs = [
      ['OPEN_NOTES', 'CUE_OPEN'],
      ['CLOSE_NOTES_HEARD', 'CUE_HEARD'],
      ['CLOSE_NOTES_EMPTY', 'CUE_EMPTY'],
      ['SHUT_NOTES', 'CUE_SHUT'],
    ]
    for (const [onBall, onPage] of pairs) {
      assert.deepEqual(notesIn(page, onPage), notesIn(engine, onBall), `${onPage} must mirror ${onBall}`)
    }
  })

  it('keeps the sent cue distinct from the three it could be confused with', () => {
    const sent = notesIn(page, 'CUE_SENT')
    assert.ok(sent.length > 0, 'a sent turn needs a sound of its own')
    // One note: two of them read as a word being spoken rather than a thing being done.
    assert.equal(sent.length, 1, 'the sent cue is one sound, not a two-syllable phrase')
    for (const name of ['CUE_OPEN', 'CUE_HEARD', 'CUE_EMPTY', 'CUE_SHUT']) {
      assert.notDeepEqual(sent, notesIn(page, name), `CUE_SENT must not repeat ${name}`)
    }
    // Rising or level, never falling: "down" is the ball's word for a microphone that stopped.
    assert.ok(sent[sent.length - 1].freq >= sent[0].freq, 'the sent cue must not fall like a close cue')
    // The sent cue used to climb to 1568 Hz — the opening cue's only note — and the two were told
    // apart by nothing but length, which is how "it went" came to sound like "listening". A cue that
    // must not be mistaken for the microphone opening cannot land on that pitch, and it carries a
    // different instrument as well, so it is not just the same blip twice.
    const opening = notesIn(page, 'CUE_OPEN').map((note) => note.freq)
    assert.ok(sent.every((note) => !opening.includes(note.freq)),
      `the sent cue must not visit the opening pitch (${opening.join(', ')} Hz)`)
    assert.ok(sent.some((note) => note.type !== 'sine'), 'and must not be made of the same sine')
  })

  it('plays each cue where the same event plays on the ball', () => {
    // One assertion per cue so a removal names the cue that went missing, rather than a diff. Both
    // doors into a turn — the button and a wake — run the same recorder now, so there is one place
    // per event to check rather than one per door.
    assert.match(page, /markListening\(true\)[\s\S]{0,400}?tone\(CUE_OPEN, 1\)[\s\S]{0,200}?await recordUtterance\(limits\)/, 'opening the microphone')
    // Only for words that stay in the box: a turn that sends says so with the sending cue instead,
    // and the two used to ring together.
    assert.match(page, /if \(!send\) tone\(CUE_HEARD, 0\.8\)/, 'a sentence came back')
    assert.match(page, /tone\(CUE_EMPTY, 0\.64\)/, 'a recording with no words')
    assert.match(page, /tone\(CUE_SHUT, 0\.48\)/, 'the user ended the exchange')
    assert.match(page, /tone\(CUE_SENT, 0\.45\)/, 'a sent transcript')
  })

  // Two cues with no gap between them is one broken buzz, not two messages: recognising a short
  // sentence takes less time than a cue rings for. Whatever else changes, a cue that starts while
  // another is still sounding has to silence the old one first.
  it('keeps the cues monophonic', () => {
    assert.match(page, /hush\(ctx\.currentTime\)[\s\S]{0,600}?createOscillator\(\)/,
      'a new cue has to fade out the ringing one before it builds its own notes')
    assert.match(page, /ringing = \{ gain, oscs \}/, 'the cue that is sounding has to be remembered')
    const hush = page.slice(page.indexOf('function hush(at)'), page.indexOf('function tone('))
    assert.match(hush, /cancelAndHoldAtTime|setValueAtTime/, 'the fade starts from the level it is at')
    assert.match(hush, /exponentialRampToValueAtTime\(0\.0001/, 'and reaches silence without a click')
    assert.match(hush, /osc\.stop\(at \+ /, 'a cut cue has to stop its notes, not just mute them')
  })

  // Electron pages start an audio context inside a gesture. The wake word is not one, so without
  // this the first cue of a session would be swallowed and "no sound" would look like a bug.
  it('arms the audio context on the first click or keypress', () => {
    assert.match(page, /addEventListener\('pointerdown', armAudio, true\)/)
    assert.match(page, /addEventListener\('keydown', armAudio, true\)/)
  })
})
