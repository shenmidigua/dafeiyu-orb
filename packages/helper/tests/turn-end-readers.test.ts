/**
 * Every category the host can broadcast has to have something on the page that can read it.
 *
 * A category with no reader is a face that silently never appears, and finding one means noticing an absence —
 * which took a round of testing and a wrong guess to do. This compares the two lists instead: the categories the
 * host's source can name, and the keys the page's reader table actually has.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')
const host = readFileSync(join(here, '..', '..', 'host', 'src', 'orb.ts'), 'utf8')

/** The keys of the page's `TURN_END_READERS` table. */
function readerKeys(): string[] {
  const at = shell.indexOf('const TURN_END_READERS = {')
  assert.notEqual(at, -1, 'the page has no TURN_END_READERS table')
  const body = shell.slice(at, shell.indexOf('\n  }', at))
  return [...body.matchAll(/^\s{4}([a-z-]+):/gm)].map((m) => m[1])
}

/** Every category the host's own classifier can return. */
function hostCategories(): string[] {
  const at = host.indexOf('function endingCategory(')
  assert.notEqual(at, -1, 'the host has no endingCategory')
  const body = host.slice(at, host.indexOf('\n}', at))
  const named = [...body.matchAll(/return '([a-z-]+)'/g)].map((m) => m[1])
  // The two endings that are not a \`reason.kind\`: the approval request and the question. They are broadcast
  // literally, so they are collected from the broadcasts themselves.
  for (const m of host.matchAll(/category: '([a-z-]+)'/g)) named.push(m[1])
  for (const m of host.matchAll(/category \}\}/g)) void m
  return [...new Set(named)]
}

describe('the turn-end reader table', () => {
  it('lists exactly the categories the host can name', () => {
    const readers = readerKeys()
    assert.ok(readers.length >= 6, `only ${readers.length} readers are listed`)
    const missing = hostCategories().filter((category) => !readers.includes(category))
    assert.deepEqual(missing, [], `the host can name a category the page cannot read: ${missing.join(', ')}`)
  })

  it('covers the six events the notifier plugin classifies', () => {
    // The mapping this copies. If one of these loses its reader, a whole kind of turn ending goes silent.
    const readers = readerKeys()
    for (const category of ['done', 'fail', 'interrupted', 'approval', 'ask', 'maxtokens']) {
      assert.ok(readers.includes(category), `${category} has no reader`)
    }
  })
})
