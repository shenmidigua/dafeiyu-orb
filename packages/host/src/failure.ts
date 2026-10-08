/**
 * What a finished turn's reason means for the ball.
 *
 * DSH ends every turn with a reason (`TurnEndReason`), and what the ball's owner asked for is one face
 * on "the run failed". That word is exactly one member of that vocabulary — `error`, which carries the
 * `LlmFailure` the model request threw (`{ message, code }`, e.g. code `MALFORMED_RESPONSE` with the
 * message `DeepSeek Messages stream: tool input is invalid JSON`):
 *
 *   error        the run failed: an adapter failure, or anything else that closed the turn by
 *                throwing. Present even when the failure happened before the stream started, which is
 *                why this event rather than `assistant/attempt` is the signal.
 *   completed    the turn did what it was asked to
 *   aborted      cancelled — `reason.reason.kind` says by whom: `user` (stop was pressed), `parent`, a
 *                `hook` (a plugin refused, with its own reason string), or `disposed` (shutdown)
 *   interrupted  *synthesized on a cold read*: a persisted log whose last turn was left open — the app
 *                died mid-turn — is closed with this. It is repair, not something the user did.
 *   forked       the same closer, for a fork's seed prefix
 *   max-tokens   the model reached its output ceiling; the turn ended, nothing threw
 *   blocked      the turn never got to run
 *
 * Matching on the *text* of an error was the alternative, and it is strictly worse: `MALFORMED_RESPONSE`
 * is a code that sits beside the message rather than inside it, so a text match would have to be a list
 * of strings maintained against somebody else's vocabulary. The kind is what DSH itself branches on —
 * its own chat client draws its failed-turn row from `reason.kind === 'error'` the same way — and a
 * retry that succeeds ends the turn as `completed`, so a retry never cries.
 *
 * Read from the real logs on this machine: 166 turn ends across 28 sessions, of which `completed` 132,
 * `aborted` 26, `interrupted` 7, `error` 1 — and that one carries exactly the message and code above.
 */

/** The failure DSH reported for a turn, in the two fields that say what happened. */
export interface TurnFailure {
  /** Machine-readable category, e.g. `MALFORMED_RESPONSE`. */
  readonly code: string
  /** The human-readable line, e.g. `DeepSeek Messages stream: tool input is invalid JSON`. */
  readonly message: string
}

/** How one turn ended, in the terms the ball cares about. */
export interface TurnEnd {
  /** The failure, or `null` when the turn did not fail. */
  readonly failure: TurnFailure | null
  /**
   * True when the turn ended without the user getting what they asked for and without it throwing:
   * they cancelled it themselves (`aborted`), the app died mid-turn and the log's open turn was closed
   * on the next read (`interrupted`), or the ball was already told about a cancellation.
   */
  readonly interrupted: boolean
}

/** One turn's ending, and the `turn` message that carries it to the ball. */
export interface TurnEnding {
  readonly end: TurnEnd
  /**
   * The tail of the `turn` message: `failed` for a run that threw, `interrupted` for one that was
   * cancelled or repaired, and neither for a turn that ran to its own end. The two are exclusive —
   * there is no face for "failed and cancelled" — which is why they are decided together, here, rather
   * than by whichever caller happens to check first.
   */
  readonly message: { readonly running: false; readonly interrupted?: true; readonly failed?: true }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** The local cast the other host modules keep to themselves; this one does not need a shared home. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Read one `turn/end` reason.
 *
 * An `error` with an unreadable payload is still a failure: the turn threw, and the code is what this
 * feature is about. The fields are clipped by the caller when they travel, like every other string
 * this plugin sends to the ball.
 */
export function readTurnEnd(reason: unknown): TurnEnd {
  const record = asRecord(reason)
  const kind = text(record?.kind)
  if (kind === 'error') {
    const failure = asRecord(record?.error)
    return {
      failure: {
        code: text(failure?.code) || 'unknown',
        message: text(failure?.message) || kind,
      },
      interrupted: false,
    }
  }
  return { failure: null, interrupted: kind === 'aborted' || kind === 'interrupted' }
}

/**
 * Read one `turn/end` reason, plus whether the ball already knows this turn was cancelled.
 *
 * This is the whole of what the ball is told when a turn ends, which is why it is one function: the
 * face a failed run wears and the bell a finished one rings are decided here, and a caller that
 * assembled the message itself would be a second place for the two to disagree. A cancellation wins
 * over a failure — a turn stopped *because* it was being cancelled did not fail in any sense the user
 * needs a face for.
 */
export function readTurnEnding(reason: unknown, cancelled = false): TurnEnding {
  const end = readTurnEnd(reason)
  const interrupted = cancelled || end.interrupted
  return {
    end: { failure: end.failure, interrupted },
    message: {
      running: false,
      ...(interrupted ? { interrupted: true as const } : {}),
      ...(end.failure === null || interrupted ? {} : { failed: true as const }),
    },
  }
}
