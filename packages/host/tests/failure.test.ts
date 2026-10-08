import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readTurnEnd, readTurnEnding } from '../src/failure.ts'

describe('what a finished turn means for the ball', () => {
  it('reads the one reason that is a failure, with its code and message', () => {
    // The real event from this machine's own log, verbatim: turn 9 of a dsh_orb session, seq 3079.
    const reason = {
      kind: 'error',
      error: {
        message: 'DeepSeek Messages stream: tool input is invalid JSON',
        code: 'MALFORMED_RESPONSE',
      },
    }
    assert.deepEqual(readTurnEnd(reason), {
      failure: { code: 'MALFORMED_RESPONSE', message: 'DeepSeek Messages stream: tool input is invalid JSON' },
      interrupted: false,
    })
  })

  it('counts a failure whose payload is thin, and names it', () => {
    // A non-adapter failure that closes the turn arrives as `code: 'UNKNOWN'` with a chained message;
    // an error event with nothing readable in it is still an error, and the face is the point.
    assert.deepEqual(readTurnEnd({ kind: 'error', error: { message: 'some plugin threw', code: 'UNKNOWN' } }),
      { failure: { code: 'UNKNOWN', message: 'some plugin threw' }, interrupted: false })
    assert.deepEqual(readTurnEnd({ kind: 'error' }),
      { failure: { code: 'unknown', message: 'error' }, interrupted: false })
    assert.deepEqual(readTurnEnd({ kind: 'error', error: { message: '   ' } }),
      { failure: { code: 'unknown', message: 'error' }, interrupted: false })
  })

  it('never cries for the reasons that are not failures', () => {
    const notFailures: readonly unknown[] = [
      { kind: 'completed' },
      { kind: 'aborted', reason: { kind: 'user' } },
      { kind: 'aborted', reason: { kind: 'parent' } },
      { kind: 'aborted', reason: { kind: 'hook', reason: 'deepseek-account/signed-out' } },
      { kind: 'aborted', reason: { kind: 'disposed' } },
      { kind: 'aborted', reason: { kind: 'legacy' } },
      { kind: 'interrupted' },
      { kind: 'forked' },
      { kind: 'blocked' },
      { kind: 'max-tokens' },
      // Shapes that are not a reason at all — an older host, a truncated event — are not failures
      // either: the face is only for something that actually said it failed.
      undefined,
      null,
      'error',
      {},
      { kind: 42 },
    ]
    for (const reason of notFailures) {
      assert.equal(readTurnEnd(reason).failure, null, JSON.stringify(reason) ?? 'undefined')
    }
  })

  it('tells a cancellation and a crash repair apart from a finished turn', () => {
    // `interrupted` is the crash closer, not a user stop: a persisted log whose last turn was left
    // open is closed with it on the next read. Both it and `aborted` must suppress the bell.
    assert.equal(readTurnEnd({ kind: 'completed' }).interrupted, false)
    assert.equal(readTurnEnd({ kind: 'max-tokens' }).interrupted, false)
    assert.equal(readTurnEnd({ kind: 'blocked' }).interrupted, false)
    assert.equal(readTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }).interrupted, true)
    assert.equal(readTurnEnd({ kind: 'interrupted' }).interrupted, true)
  })
})

describe('what the ball is told when a turn ends', () => {
  const error = { kind: 'error', error: { message: 'boom', code: 'MALFORMED_RESPONSE' } }

  it('says `failed` for a failure, and nothing else about it', () => {
    // The code and the message stay in the host's log; the ball only has to know which face to wear, so
    // the message is one field and the page cannot be handed a reason it might act on differently.
    assert.deepEqual(readTurnEnding(error).message, { running: false, failed: true })
    assert.deepEqual(readTurnEnding({ kind: 'completed' }).message, { running: false })
  })

  it('says `interrupted` for a stop, and never both', () => {
    // There is no face for "failed *and* cancelled": the cancellation is the user's own doing and the
    // last word, so it wins. `cancelled` is the ball already having been told the turn was stopping.
    assert.deepEqual(readTurnEnding({ kind: 'aborted', reason: { kind: 'user' } }).message,
      { running: false, interrupted: true })
    assert.deepEqual(readTurnEnding({ kind: 'interrupted' }).message, { running: false, interrupted: true })
    assert.deepEqual(readTurnEnding(error, true).message, { running: false, interrupted: true })
    assert.deepEqual(readTurnEnding(error, true).end.failure?.code, 'MALFORMED_RESPONSE')
  })

  it('keeps the failure for the log even when the ball is told about a cancellation', () => {
    const ending = readTurnEnding(error, true)
    assert.equal(ending.end.interrupted, true)
    assert.deepEqual(ending.end.failure,
      { code: 'MALFORMED_RESPONSE', message: 'boom' })
  })

  it('reports a plain ending for a turn nobody described', () => {
    // `finishTurn()` is also called from paths that never saw a `turn/end` — a prompt that was rejected
    // before the turn existed, a reset. Those endings must read as "the turn is over", nothing more.
    for (const reason of [undefined, null, {}, 'error', { kind: 'unknown' }]) {
      assert.deepEqual(readTurnEnding(reason).message, { running: false }, JSON.stringify(reason) ?? 'undefined')
    }
  })
})
