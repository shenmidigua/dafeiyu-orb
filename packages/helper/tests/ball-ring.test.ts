/**
 * The ball wears no ring: not the browser's focus ring, not the pinned one.
 *
 * Both existed and both looked like a light border around the ball after a click, which is what the
 * user reported. They had different origins and only one of them was deliberate, which is why the
 * two causes are pinned separately rather than as a single "no border" assertion:
 *
 *   * **Chromium's focus ring.** `#ball` is a `<button>` and the stylesheet never said
 *     `outline: none` — the only two `outline` declarations in the file belong to other controls.
 *     A click focuses the button, so the ring appeared. This one was an oversight.
 *   * **`body.pinned`'s `box-shadow`.** Clicking the ball toggles `pinned`, and that rule added
 *     `0 0 0 6px var(--pin)`. On the dark theme `--pin` is `rgb(151, 157, 166)` — a light grey
 *     that reads as white against the transparent window. This one was intentional, but it was
 *     reporting a state ("pinned, panel held open") with the only visual the ball has, and the
 *     state is now said by the panel being open at all.
 *
 * `pinned` still does its real work — it holds the panel open and stops it auto-collapsing
 * (`shell.js` gates `collapse()` on it). Only the ring is gone, and the test that says so checks
 * the *rule*, not the behaviour, because a rule coming back is the failure that is easy to miss.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '../assets/floating.css'), 'utf8')
const shell = readFileSync(join(here, '../assets/shell.js'), 'utf8')
const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')

/**
 * Every CSS block whose selector list mentions `#ball`.
 *
 * Comments are stripped first, and they have to be: the file explains in prose that
 * `body.expand-* #ball` rules "used to" exist and that the pinned rule "used to" add a
 * `box-shadow`, and a naive scan reads both sentences as rules. The two tests below would then
 * pass on the strength of a comment describing the very thing they exist to forbid.
 */
function rulesTargeting(selector: string): string[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: (match[1] as string).trim(), body: match[2] as string }))
    .filter((rule) => new RegExp(`${selector}(?![\\w-])`).test(rule.selector))
    .map((rule) => `${rule.selector} {${rule.body}}`)
}

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarationsOf(selector: string): string {
  for (const rule of rulesTargeting(selector)) {
    if (rule.slice(0, rule.indexOf('{')).trim() === selector) {
      return rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
    }
  }
  return ''
}

describe('the ball has no focus ring', () => {
  it('is a button, which is where the ring came from', () => {
    // Not a fix, a premise. If the ball ever stops being a `<button>` the focus ring goes with it
    // and this test's remaining assertions stop meaning what they claim to.
    assert.match(html, /<button id="ball"/,
      'the ball is no longer a button, so the rest of this file is checking nothing')
  })

  it('turns the outline off on the ball itself', () => {
    assert.match(declarationsOf('#ball'), /outline:\s*none/,
      '#ball has no outline declaration, so a click paints Chromium\'s default focus ring')
  })

  it('has no :focus or :focus-visible rule that puts a ring back', () => {
    // `outline: none` in the base rule is overridable by a later `:focus-visible`, and Chromium's
    // own UA stylesheet is exactly that kind of later rule. Anything in this file is stronger.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const focusRules = [...bare.matchAll(/[^{}]*:focus[^{}]*\{[^{}]*\}/g)].map((match) => match[0])
    const onBall = focusRules.filter((rule) => /#ball(?![\w-])/.test(rule))
    for (const rule of onBall) {
      assert.doesNotMatch(rule, /outline/, `a focus rule on the ball puts a ring back: ${rule}`)
    }
  })

  it('keeps the rings on the controls the user actually tabs through', () => {
    // The fix is scoped to the ball on purpose. `#question-custom` is a real text field; removing
    // its focus indicator would trade a cosmetic complaint for an accessibility regression, and
    // "the ball needed outline: none" is not a reason to touch it.
    assert.match(css, /#question-custom:focus[^{}]*\{[^{}]*outline:\s*none/,
      'the custom question field lost its focus indicator')
  })
})

describe('the ball has no pinned ring', () => {
  it('resolves to no shadow at all', () => {
    // `none` rather than no rule at all: `body.wake-listening #ball` and this one are both
    // explicit, and a later rule adding a ring has to have something to be measured against.
    assert.match(declarationsOf('body.pinned #ball'), /box-shadow:\s*none/,
      'the pinned ball paints a shadow again')
  })

  it('has no other rule that shadows the ball', () => {
    // The pinned ring was the only one, and it was easy to miss because a second, similar-looking
    // ring on `#dock-tab` sits 40 lines below it. A scan is the only thing that tells them apart.
    const shadowed = rulesTargeting('#ball').filter((rule) => /box-shadow/.test(rule))
    for (const rule of shadowed) {
      const body = rule.slice(rule.indexOf('{') + 1, rule.lastIndexOf('}'))
      assert.match(body, /box-shadow:\s*none/, `a rule shadows the ball: ${rule.replace(/\s+/g, ' ')}`)
    }
  })

  it('has no border on the ball either', () => {
    assert.match(declarationsOf('#ball'), /border:\s*0/,
      'the ball grew a border, which is the other thing that reads as a light frame')
  })
})

describe('pinned still works without its ring', () => {
  it('is still what a click toggles', () => {
    assert.match(shell, /pinned = !pinned/,
      'the click no longer toggles pinned, so removing the ring would also have removed the state')
  })

  it('still holds the panel open', () => {
    // The reason the ring could go: the state is still observable, because the panel is open.
    // This is the assertion that stops "delete the ring" from quietly becoming "delete pinned".
    assert.match(shell, /if \(pinned\) await setExpanded\(true\)/,
      'pinning no longer opens the panel, so the state has no remaining way to be seen')
  })
})
