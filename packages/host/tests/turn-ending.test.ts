/**
 * The six turn endings, and the shape the host has to read them out of.
 *
 * The host classifies a turn ending by `turn/end`'s `reason.kind` and sends the ball a category. A first version
 * read `reason` from the event itself instead of from the `data` the event carries it in, so nothing was ever
 * classified and no face appeared for any ending — and because "unclassified" and "no event at all" look the same
 * from the page, it failed silently for a whole round of testing.
 *
 * So this file is about the payload shape above all. The payloads below are copied out of a session's own durable
 * log, which is the producer's word rather than a guess about it.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const built = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')

/** The compiled classifier, taken from the build the profile actually runs. */
function classifier(): (event: Record<string, unknown>) => string | null {
  const at = built.indexOf('function endingCategory(')
  assert.notEqual(at, -1, 'endingCategory is missing from the build')
  const body = built.slice(at, built.indexOf('\n}', at) + 2)
  const asRecord = (value: unknown) => (typeof value === 'object' && value !== null ? value : undefined)
  return new Function('asRecord', `${body}; return endingCategory`)(asRecord) as (event: Record<string, unknown>) => string | null
}

const ending = (kind: string) => ({ type: 'turn/end', seq: 1, data: { turn: 1, reason: { kind } } })

describe('classifying a turn ending', () => {
  it('reads the reason out of the payload the event carries it in', () => {
    const read = classifier()
    // The shape that broke it: `reason` is under `data`, not on the event.
    assert.equal(read({ type: 'turn/end', seq: 12819, data: { turn: 94, reason: { kind: 'completed' } } }), 'done',
      'a completed turn was not classified — the payload nesting has drifted again')
    assert.equal(read({ type: 'turn/end', data: { turn: 96, reason: { kind: 'aborted', reason: { kind: 'user' } } } }), 'fail',
      'a user-aborted turn is not the failure face')
  })

  it('maps all six categories the way the notifier plugin does', () => {
    const read = classifier()
    assert.equal(read(ending('completed')), 'done')
    assert.equal(read(ending('error')), 'fail')
    assert.equal(read(ending('aborted')), 'fail')
    assert.equal(read(ending('interrupted')), 'interrupted')
    assert.equal(read(ending('blocked')), 'approval')
    assert.equal(read(ending('max-tokens')), 'maxtokens')
  })

  it('leaves an ending it does not know alone', () => {
    const read = classifier()
    // A kind a future build adds is not a face, and guessing one would put a wrong picture on the ball.
    assert.equal(read(ending('something-new')), null)
    assert.equal(read({ type: 'turn/end' }), null)
    assert.equal(read({ type: 'turn/end', data: {} }), null)
  })
})
