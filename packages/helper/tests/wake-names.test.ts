import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WAKE_SPOKEN_NAMES } from '../src/wake-names.ts'

/**
 * The wake word as it is *spoken*, which lives in two places.
 *
 * `src/wake.ts` owns the map for the helper process; `assets/shell.js` carries its own copy because
 * the page is a separate runtime that cannot import TypeScript. Two copies of a name that must agree
 * is exactly the shape of bug this codebase keeps finding late — the hint, the menu row and the model
 * all have to be talking about the same word, and when they disagree nothing throws; the user is
 * simply told to say something that will not wake the orb.
 *
 * The failure is worth a test of its own because the previous hint said 「大肥鱼」 while the model was
 * being retrained on 「大肥鱼大肥鱼」: correct-looking, entirely wrong, and no assertion anywhere
 * noticed.
 */

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')

/** The page's copy of the map, read out of the source rather than re-typed here. */
function pageNames(): Record<string, string> {
  const match = /const KEYWORD_NAMES = \{([^}]*)\}/.exec(shell)
  assert.ok(match, 'shell.js no longer declares `const KEYWORD_NAMES = { ... }` — the hint names the '
    + 'wake word from that map, so this test has to find it to be worth anything')
  // The literal is our own source and contains only quoted strings; evaluating it is how the map is
  // read exactly as written, rather than through a transcribed copy that could itself be wrong.
  return new Function(`return {${match[1]}}`)() as Record<string, string>
}

describe('the wake word as the user is told to say it', () => {
  it('is the same name in the page as in the helper', () => {
    assert.deepEqual(pageNames(), { ...WAKE_SPOKEN_NAMES },
      'shell.js and src/wake.ts disagree about what the wake word is called')
  })

  it('names 大肥鱼 twice, because the model only fires on the doubled phrase', () => {
    // The regression this guards: the hint going back to 「大肥鱼」. The model was trained to reject
    // that phrase, so a user following the hint would find the orb deaf.
    const spoken = pageNames().dafeiyu
    assert.ok(spoken, 'dafeiyu has no spoken form, so the hint would show the raw file stem')
    assert.equal(spoken.split('大肥鱼').length - 1, 2,
      `the hint says ${JSON.stringify(spoken)}; the trained wake word is the phrase said twice`)
  })

  it('leaves unknown keywords as their stem rather than guessing a word', () => {
    // A self-trained keyword has no spoken form, and inventing one would be worse than showing the
    // stem: the user can at least recognise their own keyword's name.
    assert.equal({ ...WAKE_SPOKEN_NAMES }['xiao_ming' as string], undefined)
    assert.equal({ ...WAKE_SPOKEN_NAMES }.hey_jarvis, 'Hey Jarvis')
  })

  it('keeps the hint template using the name it is handed', () => {
    // `applyWakeStatus` reads the keyword the engine reported and substitutes it into this message.
    // If the substitution were dropped the hint would go back to naming one fixed word.
    const match = /wakeListening: '([^']*)'/.exec(shell)
    assert.ok(match, 'the status hint template moved; this test has to follow it')
    assert.ok(match[1].includes('{word}'),
      `the hint template ${JSON.stringify(match[1])} does not place the wake word`)
  })
})
