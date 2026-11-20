/**
 * The ball's panel is a reply bubble: the conversation lives in the main window, and what is left
 * beside the ball is the last thing it said.
 *
 * Three things are asserted here, because each is invisible until it is wrong in front of the user:
 *
 *   * the card is small, and the numbers the main process builds the window from did not move —
 *     `--panel-width`/`--panel-height` are the contract `geometry.test.ts` already holds, and a
 *     bubble that quietly changed them would move the ball inside its own window;
 *   * the chat chrome is hidden, not deleted — and the question card is the one exception, because
 *     an agent's question has nowhere else to be answered;
 *   * every id the page looks up still exists in the markup. This is the failure that makes
 *     "comment out the dialog" dangerous: `shell.js` resolves ~60 ids at startup, and one missing
 *     node is a TypeError that takes the whole page — the ball included — down with it.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'assets', 'floating.css'), 'utf8')
const html = readFileSync(join(here, '..', 'assets', 'floating.html'), 'utf8')
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')

/** The bubble block at the end of the sheet, from its heading to the end of the file. */
const bubble = css.slice(css.indexOf('the panel is a reply bubble'))

/** A pixel-valued custom property, read the way `geometry.test.ts` reads them. */
function px(name: string): number {
  const found = new RegExp(`${name}:\\s*(\\d+)px`).exec(css)
  assert.notEqual(found, null, `${name} is declared in pixels`)
  return Number(found?.[1])
}

describe('a reply bubble, not a chat box', () => {
  it('shrinks the card without moving the ball', () => {
    assert.equal(px('--bubble-width'), 320)
    // Height is the content's now: two ends, no single number (196 was the old fixed card).
    assert.equal(px('--bubble-min-height'), 76)
    assert.equal(px('--bubble-max-height'), 420)
    // The two geometry numbers are deliberately untouched: `BALL_ROW` is derived from the panel's
    // height, so shrinking the *contract* would move the ball inside the window it was built around.
    assert.equal(px('--panel-width'), 420)
    assert.equal(px('--panel-height'), 520)
    assert.match(bubble, /#panel \{[^}]*width: var\(--bubble-width\)/)
    assert.match(bubble, /#panel \{[^}]*height: auto;/)
    assert.match(bubble, /#panel \{[^}]*min-height: var\(--bubble-min-height\);/)
    assert.match(bubble, /#panel \{[^}]*max-height: var\(--bubble-max-height\);/)
    assert.equal(/--bubble-height/.test(bubble), false, 'the fixed bubble height is gone, not shadowed')
  })

  it('keeps the card one gap away from the ball in both directions it can open', () => {
    // The base rules place a 420px card; a 320px one left on those numbers would sit 100px away from
    // the ball with a strip of nothing between them.
    assert.match(bubble, /body\.expand-left #panel \{[^}]*--ball-column\) - var\(--panel-gap\) - var\(--bubble-width\)/)
    // `expand-up` used to compute a top edge from the fixed height; with a content-sized card the
    // bottom edge is the anchor and the window's own geometry puts it `BALL_ROW` above its edge.
    assert.match(bubble, /body\.expand-up #panel \{[^}]*top: auto;\n {2}bottom: var\(--ball-row\);/)
    // `expand-right` starts at the ball's column and the window is a panel's width wider than the
    // card, so it needs no rule of its own.
    assert.equal(/body\.expand-right #panel \{[^}]*--bubble/.test(bubble), false)
  })

  it('hides the chat chrome instead of deleting it', () => {
    // Deleted markup would be a startup TypeError — see the id test below. Hidden markup keeps the
    // wiring alive and makes the change one block to delete.
    for (const id of ['#history', '#new-conversation', '#permission', '#history-list', '#tcc-gate', '#selection-chip', '#composer']) {
      assert.match(bubble, new RegExp(`\\n${id},|\\n${id} \\{`), `${id} is named in the bubble block`)
    }
    assert.match(bubble, /#panel::after \{\n {2}display: none;/)
  })

  it('hides the prose transcript under the chat bubbles', () => {
    // The bubbles are the same words, re-arranged into two columns; the transcript stays in the
    // page because `stage()` and the question card's layout still use it — it is just not painted.
    assert.match(bubble, /#transcript {\n {2}display: none;\n}/)
    assert.match(bubble, /body\.expand-down #transcript,\nbody\.expand-up #transcript \{\n {2}padding-top: 0;\n {2}padding-bottom: 0;\n\}/)
  })

  it('brings the full card back for a pending question, and only for that', () => {
    // `body.asking` is set by shell.js exactly while a question waits; the options list, the custom
    // field and the cancel button do not fit in a 320px bubble, and that card is the only place to
    // answer — so this is the one card whose height stays fixed instead of following its text.
    assert.match(bubble, /body\.asking #panel \{\n {2}--bubble-width: 420px;\n {2}height: var\(--bubble-asking-height\);\n {2}max-height: none;/)
    assert.equal(px('--bubble-asking-height'), 520)
    assert.equal(/(body\.running|body\.docked|body\.wake-recording) #panel \{/.test(bubble), false)
  })

  it('sizes the card to its messages, and stops at the ceiling, not at the window edge', () => {
    // The base `#transcript` is `flex: 1` — a zero basis grown to fill a fixed card. The log inside
    // an auto-height card has to ask for the content's height instead (`0 1 auto`), and once the
    // card hits `--bubble-max-height` it is the log that scrolls.
    assert.match(bubble, /#bubble-log {\n {2}display: flex;\n {2}flex-direction: column;\n {2}gap: 8px;\n {2}flex: 0 1 auto;\n {2}min-height: 0;\n {2}overflow-y: auto;/)
    // 420px has to fit inside the window in both opening directions: BALL_ROW (244) above the ball's
    // bottom edge and the same below the ball's top edge, both with the 12px chrome inset.
    assert.ok(px('--bubble-max-height') <= 520 - 12, 'the tallest card still fits the window')
    assert.ok(px('--bubble-min-height') < px('--bubble-max-height'))
    // A taller card is a bigger region for the click-through window to capture, and it grows after
    // the rect was reported: the observer is what keeps the hit-test honest.
    assert.match(shell, /new ResizeObserver\(\(\) => syncHitTest\(\)\)/)
  })

  it('opens the bubble on the latest words, not the oldest', () => {
    // `scrollTop` starts at 0; with 190px of card over a restored conversation that is the first
    // message ever exchanged, which is the one thing "show me the latest reply" must not do.
    assert.match(shell, /panel\.hidden = false\n {6}\/\/[\s\S]{0,700}?transcript\.scrollTop = transcript\.scrollHeight/)
    // The visible list is the log now, and every message follows its own end as it is added.
    assert.match(shell, /function followBubbleLog\(\) \{\n {4}bubbleLog\.scrollTop = bubbleLog\.scrollHeight\n {2}\}/)
  })
})

describe('the markup the page still resolves', () => {
  it('carries every id shell.js looks up', () => {
    const ids = new Set<string>()
    for (const match of shell.matchAll(/querySelector\('#([a-z0-9-]+)'\)/g)) ids.add(match[1] ?? '')
    for (const match of shell.matchAll(/getElementById\('([a-z0-9-]+)'\)/g)) ids.add(match[1] ?? '')
    ids.delete('')
    assert.ok(ids.size > 40, `the page resolves its chrome by id (${String(ids.size)} found)`)
    const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html))
    assert.deepEqual(missing, [], 'a missing id is a TypeError on startup, not a hidden panel')
  })

  it("keeps the panel's own children where the page expects them", () => {
    // The bubble is a styling decision; the section, the ball and the composer all stay in place so
    // the page can keep running unchanged.
    for (const id of ['panel', 'transcript', 'question', 'composer', 'ball', 'dock-tab', 'stop']) {
      assert.match(html, new RegExp(`id="${id}"`))
    }
    assert.match(html, /reply bubble since 2026-11-20/)
  })
})
