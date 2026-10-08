/**
 * The failure face has one caller, and it is the turn's ending.
 *
 * `playFailFrame` is played from `setRunning` alone, off the host's own reading of `turn/end`'s reason
 * (`packages/host/src/failure.ts`): a run that threw wears this face, a turn that ran to its own end
 * rings the bell, and a stop the user pressed does neither.
 *
 * A second caller was tried and withdrawn, and this file is where the reason is kept. A subagent runs in
 * a session of its own, and `drain()` reads the *ball's* session, so a subagent that stopped working was
 * thought to be catchable from the parent's side: its call appears in this turn's blocks as a tool named
 * `subagent` or `subagent_*`, and a run that ended badly would settle with `detail.isError`. Measured
 * against two real subagents whose insides failed — a `read` of a missing file, and a shell syntax error —
 * the parent's `tool/result` was `isError: false` for both, because a subagent that can still answer ends
 * its own turn `completed`. The flag the page can read is not the flag that means "stopped working".
 *
 * The ending that *does* mean it is the child's own `turn/end: { reason: { kind: 'error' } }`, in the
 * child's log, which the helper can read and the page cannot. Until a channel carries it, the page-side
 * predicate stays where it is and stays uncalled, and this test pins that it is uncalled rather than
 * quietly wired to a signal that is always false.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching, the way the other page tests do. */
function pageFunction(name: string): string {
  const found = new RegExp(`(?:^|[^\\w$])(?:async )?function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = (found as RegExpExecArray).index + ((found as RegExpExecArray)[0].startsWith('async ') ? 6 : 0)
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let index = open; index < shell.length; index += 1) {
    if (shell[index] === '{') depth += 1
    else if (shell[index] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, index + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

describe('the failure face', () => {
  it('is played by the turn ending, and by nothing else', () => {
    // Three mentions and no fourth: the definition, the retry inside it for a face that is not in hand
    // yet, and the one caller that means it. A new caller has to be argued for here.
    const callers = shell.match(/playFailFrame\(\)/g) ?? []
    assert.equal(callers.length, 3,
      `playFailFrame has ${callers.length} call sites: the definition, its own retry and setRunning were expected`)
    assert.match(pageFunction('setRunning'), /playFailFrame\(\)/, 'a failed turn no longer wears the face')
  })

  it('does not read the parent side for a subagent that stopped working', () => {
    // The signal that looked obvious and is not: the subagent's call settles in this page as a tool block,
    // so `detail.isError` reads like "it failed". Measured against two real subagents whose insides failed,
    // the parent's result was `isError: false` for both — a subagent that can still answer ends its own
    // turn `completed`. Nothing in the block path may play the face off that flag; the child session's own
    // `turn/end: error` is what means it, and only the helper can read it.
    const upsert = pageFunction('upsertBlock')
    assert.equal(/playFailFrame/.test(upsert), false, 'the block path plays the failure face')
    assert.equal(/isSubagentTool\(/.test(upsert), false, 'the block path decides about subagents again')
    assert.equal(/isError/.test(upsert), false, 'the block path reads a result flag that is always false for a subagent')
    // Kept for the channel that will carry it, and pinned so removing it is a decision.
    assert.match(pageFunction('isSubagentTool'), /name === 'subagent'/,
      'the subagent tool name is no longer recognised')
  })

  it('does not ring the bell for a turn the user stopped', () => {
    // The other half of the same edge, read in the same message: `interrupted` is the host's word for a
    // turn that was cancelled or repaired, and it must reach neither the failure face nor the bell.
    const setRunning = pageFunction('setRunning')
    assert.match(setRunning, /if \(failed && !interrupted\) playFailFrame\(\)/,
      'a failed turn is no longer distinguished from a cancelled one')
    assert.match(setRunning, /else if \(wasRunning && !interrupted\) playDoneFrame\(\)/,
      'a cancelled turn is ringing the bell again')
  })
})
