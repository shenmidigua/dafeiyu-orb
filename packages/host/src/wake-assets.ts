/**
 * Wake-word models, referenced by path rather than copied.
 *
 * The floating ball runs openWakeWord's pipeline (`onnxruntime-web`, wasm) inside
 * its own renderer. Neither the 5.2 MB of ONNX models nor the 14 MB of WebAssembly
 * can be shipped inside the orb bundle without doubling its size, so the host keeps
 * pointing at the `dsh-voice-dialog` asset directory on disk and serves it over the
 * loopback web server, exactly like the avatar route: the ball authenticates with
 * the helper socket token.
 *
 * Nothing here writes, moves, or copies a model file.
 *
 * @module wake-assets
 */

import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** Model files the ball's engine downloads, in the order it loads them. */
export const WAKE_MODELS = [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
] as const

/** The one keyword model that ships with the reference assets. */
export const WAKE_DEFAULT_KEYWORD = 'hey_jarvis'

/** The ONNX Runtime browser build the page injects plus the wasm pair it loads. */
export const WAKE_RUNTIME = [
  'ort/ort.wasm.min.js',
  'ort/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm',
] as const

/** The reference plugin's file name for the shipped keyword. */
const KEYWORD_FILES: Readonly<Record<string, string>> = Object.freeze({
  [WAKE_DEFAULT_KEYWORD]: 'hey_jarvis_v0.1.onnx',
})

/**
 * Model file for one openWakeWord keyword.
 *
 * The shipped keyword has a versioned file name; anything else is assumed to follow
 * the `<keyword>.onnx` convention so a user can drop in another model without a
 * code change. Whether that file exists is what {@link readWakeDirectory} decides.
 * @param keyword - the configured keyword name.
 * @returns the file name inside the asset directory.
 */
export function keywordFile(keyword: string): string {
  return KEYWORD_FILES[keyword] ?? `${keyword}.onnx`
}

/** The keyword model file, plus the runtime pair, that this directory must contain. */
function requiredFiles(keyword: string): readonly string[] {
  return [...WAKE_MODELS, keywordFile(keyword), ...WAKE_RUNTIME]
}

/** Every file the route is allowed to answer with, for one keyword. */
export function wakeFiles(keyword: string): readonly string[] {
  return requiredFiles(keyword)
}

/** File names for the keyword the engine will actually ask for. */
export function wakeFileAllowed(keyword: string, relative: string): boolean {
  // The whitelist is written with forward slashes; a Windows client may send either.
  const cleaned = relative.replace(/^\/+/, '').split('\\').join('/')
  return cleaned !== '' && requiredFiles(keyword).includes(cleaned)
}

/** Folder the models are expected to live in, inside the reference checkout. */
const REFERENCE_DIRECTORY = join('dsh-voice-dialog', 'assets')

/** Candidate roots, in priority order, for a `dsh-voice-dialog/assets` folder. */
function wakeCandidates(): readonly string[] {
  const fromEnv = process.env.DSH_ORB_WAKE_ASSETS?.trim()
  const candidates: string[] = []
  if (fromEnv !== undefined && fromEnv !== '') candidates.push(resolve(fromEnv))
  candidates.push(join(process.cwd(), REFERENCE_DIRECTORY))
  // This module is bundled to `dist/host/index.js` inside the installed package, so
  // walking up four levels lands on the checkout root that also holds the plugin.
  candidates.push(resolve(import.meta.dirname, '..', '..', '..', '..', REFERENCE_DIRECTORY))
  return candidates
}

/**
 * The first candidate directory that actually contains the whole model set.
 * A missing directory simply means wake is unavailable; it is never an error.
 * @param keyword - the configured keyword, whose model file is part of the set.
 * @returns the absolute asset directory, or undefined when nothing usable exists.
 */
export function discoverWakeAssets(keyword: string = WAKE_DEFAULT_KEYWORD): string | undefined {
  for (const candidate of wakeCandidates()) {
    const directory = readWakeDirectory(candidate, keyword)
    if (directory !== undefined) return directory
  }
  return undefined
}

/**
 * Validate one explicit directory against the model set.
 * @param directory - a path from the profile config or an environment override.
 * @param keyword - the configured keyword, whose model file is part of the set.
 * @returns the resolved absolute path, or undefined when a required file is missing.
 */
export function readWakeDirectory(directory: string, keyword: string = WAKE_DEFAULT_KEYWORD): string | undefined {
  if (directory === '') return undefined
  const root = resolve(directory)
  for (const file of requiredFiles(keyword)) {
    const target = join(root, file)
    try {
      if (!statSync(target).isFile()) return undefined
    } catch {
      return undefined
    }
  }
  return root
}

/**
 * Resolve one request path against the asset root.
 *
 * @param root - the validated asset root.
 * @param relative - the decoded path below the asset route.
 * @param keyword - the configured keyword, whose model file is also servable.
 * @returns the absolute file path when the request names a shipped asset, else undefined.
 */
export function resolveWakeAsset(
  root: string,
  relative: string,
  keyword: string = WAKE_DEFAULT_KEYWORD,
): string | undefined {
  // The whitelist is the real guard: `..`, absolute paths, and unknown names all miss it.
  if (!wakeFileAllowed(keyword, relative)) return undefined
  const cleaned = relative.replace(/^\/+/, '').split('\\').join('/')
  const target = resolve(root, cleaned)
  if (!target.startsWith(root + sep)) return undefined
  return target
}

/**
 * Content type for one served asset.
 *
 * `application/wasm` is load-bearing: `WebAssembly.instantiateStreaming` refuses a
 * response whose content type is anything else, and ONNX Runtime takes that path.
 * @param relative - the asset path, as accepted by {@link resolveWakeAsset}.
 * @returns the response content type.
 */
export function wakeAssetMime(relative: string): string {
  if (relative.endsWith('.wasm')) return 'application/wasm'
  if (relative.endsWith('.mjs')) return 'text/javascript; charset=utf-8'
  if (relative.endsWith('.js')) return 'text/javascript; charset=utf-8'
  return 'application/octet-stream'
}

/** Whether a directory exists at all, used only for diagnostics. */
export function wakeDirectoryExists(directory: string): boolean {
  return existsSync(directory)
}
