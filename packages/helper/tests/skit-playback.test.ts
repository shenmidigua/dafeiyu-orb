/**
 * What one skit plays, in order: the scripted run, the repeated clip, and the draw between them.
 *
 * The pool is two kinds of item now. A *sequence* is a group — the pack drew a gag with a setup and a
 * punchline — so it plays each clip once and stops; a *single* clip is the loop this slot has always
 * been, repeated a few times with the interjection dropped in the middle. The draw between skits is
 * also here, because it is the half that knows what played last: the helper hands the whole pool over
 * once, when the page loads, and this runs every few minutes for as long as the ball is on screen.
 *
 * Run against the page's own `skitSequence`, cut out of `assets/shell.js`, with `Math` replaced so
 * the draw and the repetition count are the test's rather than the clock's.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching. */
function pageFunction(name: string): string {
  const head = shell.indexOf(`function ${name}(`)
  assert.notEqual(head, -1, `${name} is missing from the page`)
  const open = shell.indexOf('{', head)
  let depth = 0
  for (let i = open; i < shell.length; i += 1) {
    if (shell[i] === '{') depth += 1
    else if (shell[i] === '}') {
      depth -= 1
      if (depth === 0) return shell.slice(head, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/** A `{ src, ms, loops }` frame as `timedFrameOf` hands one over. */
const frame = (name: string, ms: number) => ({ src: `data:image/gif;base64,${name}`, ms, loops: false })
/** A single clip: the item that repeats a few times with an interjection in the middle. */
const single = (name: string, ms = 500) => ({ kind: 'single', frame: frame(name, ms) })
/** A scripted run: the item that plays each of its clips once, in order. */
const sequence = (...names: string[]) => ({ kind: 'sequence', frames: names.map((name, index) => frame(name, 400 + index * 100)) })

/**
 * The page's skit rotation with its ambient dependencies supplied.
 *
 * `Math` is injected so the draw is the test's: `random` is read as a raw value rather than as a
 * sequence of calls, which is what makes "the same item twice, then a different one" expressible.
 */
function harness(options: { pool: unknown[]; times?: [number, number]; interject?: unknown; random?: () => number }) {
  const factory = new Function('deps', `
    const { Math, MEME_POLL_MS, pool, times, interject } = deps
    let skitLastSrc
    ${pageFunction('pickIn')}
    ${pageFunction('pickOne')}
    ${pageFunction('skitLead')}
    ${pageFunction('rotateSkit')}
    ${pageFunction('skitSequence')}
    return { sequence: skitSequence, last: () => skitLastSrc, info: { files: pool, item: pool[0], times, interject } }
  `)
  return factory({
    // The real `Math` with `random` swapped: its members are non-enumerable, so a spread would drop
    // every one of them and `pickIn`'s clamp would die on `Math.min is not a function`.
    Math: Object.create(Math, { random: { value: options.random ?? (() => 0) } }),
    MEME_POLL_MS: 60_000,
    pool: options.pool,
    times: options.times ?? [3, 3],
    interject: options.interject ?? null,
  }) as { sequence: (info: unknown) => { src: string }[]; last: () => string; info: unknown }
}

describe('one skit from the page', () => {
  it('plays a run once through, in the order the config wrote it', () => {
    const page = harness({ pool: [sequence('A', 'B', 'C')] })
    const frames = page.sequence(page.info)
    assert.deepEqual(frames.map((frame) => frame.src), ['A', 'B', 'C'].map((name) => `data:image/gif;base64,${name}`))
  })

  it('does not repeat a run, however the repetition range is set', () => {
    // The range is what a single clip is repeated by. A run is a group with a beginning and an end, so
    // handing it the same treatment would play the punchline four times.
    const page = harness({ pool: [sequence('A', 'B')], times: [5, 5] })
    assert.equal(page.sequence(page.info).length, 2)
  })

  it('does not drop an interjection into the middle of a run', () => {
    // The interjection interrupts a clip that is about to be shown again. A run's clips are each shown
    // once, so there is no repeat to break up and nothing to insert between them.
    const page = harness({ pool: [sequence('A', 'B')], interject: frame('I', 300) })
    const frames = page.sequence(page.info)
    assert.deepEqual(frames.map((frame) => frame.src), ['A', 'B'].map((name) => `data:image/gif;base64,${name}`))
  })

  it('keeps repeating a single clip, with the interjection in the middle', () => {
    // The behaviour a config written before runs existed expects, unchanged: `times` is the whole of
    // what is random about it, and the interjection lands between two of the repeats.
    const page = harness({ pool: [single('A')], times: [3, 3], interject: frame('I', 300) })
    assert.deepEqual(
      page.sequence(page.info).map((frame) => frame.src),
      ['A', 'I', 'A', 'A'].map((name) => `data:image/gif;base64,${name}`),
    )
  })

  it('never begins the same item twice in a row while the pool can spare it', () => {
    // `random` always answers 0, so both skits draw the pool's first item: the second draw has to see
    // that item as the one just played and take the other. A run is remembered by where it starts,
    // which is what the ball shows while it plays. `C` is a single clip, so it is repeated — that is
    // its own behaviour and not the rotation's; what the rotation decides is *which* item leads.
    const page = harness({ pool: [sequence('A', 'B'), single('C')], random: () => 0 })
    const first = page.sequence(page.info)
    assert.equal(first[0].src, 'data:image/gif;base64,A')
    const second = page.sequence(page.info)
    assert.equal(second[0].src, 'data:image/gif;base64,C', 'the run that just played was drawn again')
    assert.ok(second.length > 1, 'a single clip should still be repeated, whatever the rotation did')
  })

  it('replays the only item when that is all there is', () => {
    // A pool of one is all repeats by definition, so the rotation hands it over rather than filtering
    // it down to nothing — which would leave the ball resting through a skit that never plays.
    const page = harness({ pool: [sequence('A')], random: () => 0 })
    assert.equal(page.sequence(page.info).length, 1)
    assert.equal(page.sequence(page.info).length, 1)
  })

  it('falls back to the plan own item when the pool is missing', () => {
    // `info.item` is the fallback for a plan with no pool, and the item is read defensively — the ball
    // must not go dark over a plan it half understands.
    const page = harness({ pool: [], times: [2, 2] })
    const frames = page.sequence({ files: [], item: single('B', 1_200), times: [2, 2], interject: null })
    assert.deepEqual(frames.map((frame) => frame.src), ['B', 'B'].map((name) => `data:image/gif;base64,${name}`))
  })

  it('plays nothing at all for an empty pool rather than throwing', () => {
    const page = harness({ pool: [] })
    assert.equal(page.sequence({ files: [], item: undefined, times: [3, 3], interject: null }).length, 0)
  })
})
