/**
 * How a keyword is written when the interface has to *name it to a person*.
 *
 * The keyword itself is a file stem, so reading it aloud would be useless. `hey_jarvis` is spelled the
 * way it sounds; `dafeiyu` is not, and the phrase it stands for is the word said **twice**, which is
 * the whole reason this model exists — telling the user to say it once sends them at a wake word that
 * no longer fires.
 *
 * Kept in a module of its own, with no imports, so a test can read it without dragging in `electron`
 * and the whole toolchain: the map has to be checkable cheaply, or it drifts. `assets/shell.js` keeps
 * its own copy because the page is a separate runtime that cannot import TypeScript, and
 * `tests/wake-names.test.ts` pins the two together.
 */

/** Spoken form of every keyword the interface knows how to name. */
export const WAKE_SPOKEN_NAMES: Readonly<Record<string, string>> = Object.freeze({
  hey_jarvis: 'Hey Jarvis',
  dafeiyu: '大肥鱼大肥鱼',
})

/**
 * The wake word as the user should say it.
 * @param keyword - the configured keyword, a file stem.
 * @returns the spoken form, or the stem when no spoken form is known — a wrong word is worse than an
 * odd one, so nothing is guessed.
 */
export function spokenName(keyword: string): string {
  return WAKE_SPOKEN_NAMES[keyword] ?? keyword
}
