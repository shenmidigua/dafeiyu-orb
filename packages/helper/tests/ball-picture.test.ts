/**
 * The one state the ball's picture must never be left in, and how it is expressed.
 *
 * The ball is one `<img>` that is handed a new source constantly, and the docked peek needs a state that
 * means "the ball is out here with nothing on it" for the moment between the strip's hover and the arrival
 * clip landing. There are two ways to say that, and they are not the same thing to the engine:
 *
 *   * `removeAttribute('src')` — the element has no source at all, and Chromium paints its broken-image
 *     placeholder: a white-edged rectangle with a small picture glyph in its top-left corner. That box is
 *     what appeared on every hover of the docked strip.
 *   * `src = <a transparent pixel>` — the element has a picture, and the picture is nothing.
 *
 * Both were rendered in Chromium through the real `floating.css` in the real docked-peek state, and
 * captured: the first gives the box, the second gives nothing at all. Both also report `complete: true`
 * and the same `getBoundingClientRect()`, so no reading of the element's state distinguishes them — only
 * the painted result does, which is why this file pins the *expression* rather than a symptom.
 *
 * An earlier attempt at this lived on the other side of the problem: `armBallPicture` shadowed `src` and
 * `removeAttribute` on the element and toggled a `ball-drawn` class, with a stylesheet rule hiding the
 * picture while the class was absent. It is gone, and this file asserts it stays gone — it hid the ball
 * rather than giving it something to draw, which meant a swap that did not fire `load` left the ball
 * invisible for good, and it never addressed why the box appeared in the first place.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')

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

describe('the empty ball is a picture, not an absence', () => {
  it('empties the peeked ball by handing it a blank frame', () => {
    const peek = pageFunction('openDockPeek')
    assert.match(
      peek,
      /gif\.src = BLANK_FRAME/,
      'the peek no longer hands the ball a blank frame, so it has nothing to draw',
    )
  })

  it('never takes the source off the element, which is what paints the broken-image box', () => {
    const peek = pageFunction('openDockPeek')
    assert.doesNotMatch(
      peek,
      /removeAttribute\(\s*'src'\s*\)/,
      'the peek removes the source again, which is the broken-image box the user reported',
    )
  })

  it('keeps the blank frame a real, transparent, single-pixel GIF', () => {
    const found = /const BLANK_FRAME = '(data:image\/gif;base64,[^']+)'/.exec(shell)
    assert.notEqual(found, null, 'BLANK_FRAME is missing from the page')
    const bytes = Buffer.from(found[1].slice(found[1].indexOf(',') + 1), 'base64')
    // A real GIF, because the whole point is that the engine has something it can draw: a malformed
    // payload would be a source that fails, which is the box again by another route.
    assert.equal(bytes.subarray(0, 6).toString('latin1'), 'GIF89a', 'the blank frame is not a GIF')
    // 1x1, little-endian, at the offsets the format puts the logical screen size at.
    assert.equal(bytes.readUInt16LE(6), 1, 'the blank frame is not one pixel wide')
    assert.equal(bytes.readUInt16LE(8), 1, 'the blank frame is not one pixel tall')
  })
})

describe('the workaround it replaces is gone', () => {
  it('has no element shadowing left in the page', () => {
    assert.doesNotMatch(shell, /armBallPicture/, 'the class-toggling workaround is back')
    assert.doesNotMatch(shell, /ball-drawn/, 'the class the stylesheet hid the ball with is back')
  })

  it('leaves no stylesheet rule that hides the ball instead of drawing it', () => {
    // The gate that used to be here was `body.docked:not(.ball-drawn) #ball-gif { visibility: hidden }`.
    // Read as a rule rather than as a word: the comment recording why it went mentions the class by name.
    assert.doesNotMatch(
      css,
      /#ball-gif\s*\{[^}]*visibility:\s*hidden/,
      'a rule hides the ball picture again, which takes the strip\u2019s animation with it',
    )
  })
})
