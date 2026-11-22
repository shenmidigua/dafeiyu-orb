/**
 * The two wake engines the ball can run, and which phrases belong to each.
 *
 * Plain data plus one import of the phrase names, so the menu, the availability checks and
 * `tests/wake-engines.test.ts` can all read it without loading `electron` or the toolchain.
 *
 * They are genuinely different engines with different strengths, which is why the choice is exposed
 * rather than being made here:
 *
 * - `openwake` — openWakeWord: a small per-word classifier over mel + embedding features, trained on
 *   this machine, all wasm in the page. It needs one `<keyword>.onnx` per phrase.
 * - `sherpa` — sherpa-onnx keyword spotting: one transducer decoder shared by every phrase, with the
 *   phrase written as tokens in a keyword file. Nothing per-word is trained.
 */

import { WAKE_KEYWORD_OPTIONS } from './wake-names.ts'

/** Engine identifiers, as stored in `orb-wake.json`. */
export type WakeEngineId = 'openwake' | 'sherpa'

/** Engine the profile falls back to. */
export const WAKE_ENGINE_DEFAULT: WakeEngineId = 'sherpa'

/**
 * Engines in the order the menu offers them.
 *
 * `openwake` is retired: every phrase it knows is one the decoder engine already listens for, and the
 * classifier needs a per-word model that has to be trained, so nothing is left for it to do. It stays
 * in this file as an id — {@link ENGINE_KEYWORDS.openwake}, the model directory, and the whole branch
 * in `assets/wake.js` are untouched — but it is no longer offered, and a profile still carrying it in
 * `orb-wake.json` falls back to the decoder through {@link isWakeEngine}. Putting `'openwake'` back in
 * this list and flipping {@link WAKE_ENGINE_DEFAULT} is the whole of the way back.
 */
export const WAKE_ENGINES: readonly WakeEngineId[] = Object.freeze(['sherpa'])

/**
 * Phrases each engine can listen for, in menu order.
 *
 * `sherpa` has no `hey_jarvis`: the shipped checkpoint is Chinese (wenetspeech) and its keyword files
 * were generated from pinyin tokens, so an English phrase would have to be built from tokens the
 * model does not have. Offering the row and failing to fire is worse than not offering it.
 */
export const ENGINE_KEYWORDS: Readonly<Record<WakeEngineId, readonly string[]>> = Object.freeze({
  // The classifier engine's list is the one `wake-names.ts` already owns: it is the menu order that
  // shipped with the trained models, and repeating it here would be a second place to forget.
  openwake: WAKE_KEYWORD_OPTIONS,
  sherpa: Object.freeze(['xiaodi', 'xiaohui', 'dacheng', 'dafeiyu', 'laode', 'heilaode']),
})

/** Whether a value from a config file names a known engine. */
export function isWakeEngine(value: unknown): value is WakeEngineId {
  return typeof value === 'string' && (WAKE_ENGINES as readonly string[]).includes(value)
}
