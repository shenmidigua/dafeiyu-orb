import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A wake has to be able to reach a ball that is behind the strip.
 *
 * Docked, the ball is not on screen at all — `syncGif` returns early while `docked` is set, so the
 * acknowledgement clip the wake asks for would be played on an element nobody can see, and the panel
 * would open around a ball that is not there. "It heard you" that the user cannot see is not an
 * acknowledgement, so the ball comes out of the strip as part of the wake.
 *
 * Two properties make that work, and neither is visible from the behaviour of any one function:
 *
 *   * the un-dock has to be asked for *before* the acknowledgement clip, or the clip is painted while
 *     the page still believes the ball is docked and `syncGif` drops it on the floor;
 *   * it must not be *awaited* first, because `unsnapDocked` frees the page's docked state synchronously
 *     — before its own first `await` — and waiting for the helper's slide instead would hold the
 *     acknowledgement back by the length of the animation, which is the one moment it is meant to be
 *     immediate.
 *
 * The second one is the subtle half and it is asserted on its own below, by calling `unsnapDocked` and
 * reading the page's state before letting its promise settle.
 */

const shell = readFileSync(fileURLToPath(new URL('../assets/shell.js', import.meta.url)), 'utf8')

/** A named `function name(...) { … }` cut out by brace matching, the way the other page tests do. */
function pageFunction(name: string): string {
  const found = new RegExp(`(?:^|[^\\w$])(?:async )?function ${name}\\(`).exec(shell)
  assert.notEqual(found, null, `${name} is missing from the page`)
  const head = found.index + (found[0].startsWith('async ') ? 'async '.length : 0)
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

/** The body of `applyWakeStatus`, where a detection becomes the things the user sees. */
function applyWakeStatus(): string {
  return pageFunction('applyWakeStatus')
}

describe('a wake brings the ball out of its strip', () => {
  it('asks for the un-dock before it plays the acknowledgement', () => {
    const body = applyWakeStatus()
    const undock = body.indexOf('wakeShowBall()')
    const clip = body.indexOf('playWakeFrame()')
    assert.notEqual(undock, -1, 'the wake no longer brings a docked ball out at all')
    assert.notEqual(clip, -1, 'the wake no longer plays its acknowledgement')
    // Order is the whole of it: `syncGif` leaves a docked element alone, so a clip asked for while the
    // page still believes the ball is behind the strip is a clip that is never painted.
    assert.ok(undock < clip, 'the acknowledgement is asked for before the ball is out of the strip')
  })

  it('does not wait for the slide before showing the clip', () => {
    const body = applyWakeStatus()
    assert.match(body, /void wakeShowBall\(\)/,
      'the un-dock is awaited, so the acknowledgement waits out the whole slide')
  })

  it('leaves the ball where it is when it is not docked', async () => {
    const seen = { undocks: 0 }
    const page = wakeHarness(undefined, seen)
    await page.run()
    assert.equal(seen.undocks, 0, 'a free ball was un-docked again, which would move it for no reason')
  })

  it('un-docks a docked ball', async () => {
    const seen = { undocks: 0 }
    const page = wakeHarness('right', seen)
    await page.run()
    assert.equal(seen.undocks, 1, 'the wake left the ball behind the strip')
  })

  it('clears the expand suppression it inherited, so the next hover still opens the panel', async () => {
    // `unsnapDocked` sets this to stop a hand that is already on the ball from opening the panel as the
    // ball arrives under it. Nothing clears it except a pointer leaving the UI, and a wake has no pointer
    // anywhere near it — so a flag left set here would still be set the next time the user really did
    // hover the ball, and that hover would do nothing at all.
    const seen = { undocks: 0 }
    const page = wakeHarness('right', seen)
    await page.run()
    assert.equal(page.suppressed(), false, 'the suppression outlives the wake and swallows the next hover')
  })
})

describe('the un-dock frees the page before it waits on the helper', () => {
  it('has already dropped the docked state when it returns to its caller', () => {
    // The property the ordering above rests on, asserted directly rather than inferred: `applyDocked` is
    // called synchronously, so a caller that does not await still gets a ball the page believes is free.
    const seen = { dockedCalls: [] as unknown[] }
    const factory = new Function('deps', `
      const { api, seen } = deps
      let docked = deps.DOCKED
      let suppressExpand = false
      let dragging = false
      let skipDockCommit = false
      function applyDocked(side) {
        seen.dockedCalls.push(side)
        docked = side === 'left' || side === 'right' ? side : undefined
      }
      function applyDockedFrom(result) { if (result != null) applyDocked(result.docked) }
      ${pageFunction('unsnapDocked')}
      return { run: unsnapDocked, read: () => ({ docked, suppressExpand }) }
    `)
    const page = factory({
      DOCKED: 'right',
      seen,
      api: { unsnap: async () => ({ docked: undefined }) },
    }) as { run: () => Promise<void>; read: () => { docked: unknown; suppressExpand: boolean } }

    const pending = page.run()
    assert.deepEqual(seen.dockedCalls, [undefined],
      'applyDocked is no longer called before the first await, so the ordering trick does not hold')
    assert.equal(page.read().docked, undefined, 'the page still believes the ball is behind the strip')
    return pending
  })
})

/**
 * `wakeShowBall` with the two module-level values it touches made local, and an `unsnapDocked` that
 * behaves the way the real one does in the one respect under test: it sets `suppressExpand` before it
 * does anything asynchronous.
 */
function wakeHarness(docked: string | undefined, seen: { undocks: number }) {
  const factory = new Function('deps', `
    const { seen } = deps
    let docked = deps.DOCKED
    let suppressExpand = false
    async function unsnapDocked() { seen.undocks += 1; suppressExpand = true }
    ${pageFunction('wakeShowBall')}
    return { run: wakeShowBall, suppressed: () => suppressExpand }
  `)
  return factory({ DOCKED: docked, seen }) as { run: () => Promise<void>; suppressed: () => boolean }
}
