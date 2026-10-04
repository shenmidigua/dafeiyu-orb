import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The mute has to be wired up on the page side, and it is wired up by hand.
 *
 * `wake-mute.test.ts` proves the engine stops scoring when muted. It says nothing about whether
 * anything ever mutes it — an engine that is never muted behaves exactly like an engine without
 * the fix, and every test in that file still passes. This file covers the other half: that the
 * ball's speaking state is what mutes it.
 *
 * Assertions are on the source text rather than on behaviour because the alternative would mean
 * running the whole page with a live microphone. What is checked is the specific shape that is
 * easy to get wrong: the mute sits on the edge, not on the level.
 */

const shell = readFileSync(fileURLToPath(new URL('../assets/shell.js', import.meta.url)), 'utf8')

/** The body of `syncSpeechButtons`, which is where the speaker's state arrives. */
function syncSpeechButtons(): string {
  const start = shell.indexOf('syncSpeechButtons = function (state)')
  assert.notEqual(start, -1, 'syncSpeechButtons is gone')
  // The function ends at the first `  }` that closes it at two-space indentation, which is the
  // shape this file uses for every `= function` assignment in the page. `\r?\n` because the
  // checkout may carry CRLF on Windows and this file is read straight off disk.
  const match = /\r?\n {2}\}\r?\n/.exec(shell.slice(start))
  assert.notEqual(match, null, 'could not find the end of syncSpeechButtons')
  return shell.slice(start, start + (match?.index as number))
}

describe('muting the wake word from the page', () => {
  it('mutes and unmutes from the speaking edge', () => {
    const body = syncSpeechButtons()
    assert.match(body, /if \(speakActive\) wake\.mute\(\)/,
      'starting to speak does not mute the wake word')
    assert.match(body, /else wake\.unmute\(\)/,
      'finishing speaking does not un-mute it, so the feature would stay off')
  })

  it('does not mute on the level, only on the change', () => {
    // Muting on `state.speaking` rather than on the edge would re-run `reset()` — and therefore
    // drop the embedding ring — on every state the speaker emits, including the per-sentence
    // updates a long read-aloud produces. The wake word would then start from silence every time
    // the ball finished a clause.
    const body = syncSpeechButtons()
    const edge = body.indexOf('if (state.speaking !== speakActive)')
    assert.notEqual(edge, -1, 'the speaking edge guard is gone')
    const mute = body.indexOf('wake.mute()')
    assert.ok(mute > edge,
      'the mute is no longer inside the edge guard, so it fires on every state')
  })

  it('asks for the speaking frame on the same edge, after muting', () => {
    // Order: mute first. The frame fetch is an await, and a frame that arrives between the two
    // would be scored before the mute landed.
    const body = syncSpeechButtons()
    const mute = body.indexOf('wake.mute()')
    const load = body.indexOf('loadSpeakFrame()')
    assert.ok(mute !== -1 && load > mute, 'the speaking frame is fetched before the mute')
  })
})