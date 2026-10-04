/**
 * Wake-word wiring for the floating ball.
 *
 * The engine itself runs in the ball's renderer (`assets/wake.js`), because that is
 * where AudioWorklet and `onnxruntime-web` live. This module is the main-process half:
 * it reads the launch environment the host seeds, and it exposes the model directory
 * to the page over a private protocol so the ball can fetch ~20 MB of wasm and ONNX
 * without a loopback token ever reaching the document.
 *
 * Nothing here copies a model: the host passes the absolute path of an existing
 * `dsh-voice-dialog/assets` folder in `DSH_ORB_WAKE_ASSETS`.
 *
 * @module wake
 */

import { protocol } from 'electron'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'

/** Custom scheme the ball page loads wake assets from. */
export const WAKE_SCHEME = 'dsh-wake'

/** URL prefix the page uses, without the scheme. */
export const WAKE_ORIGIN = `${WAKE_SCHEME}://assets/`

/** Model files the engine loads, in order. Only openWakeWord's `hey_jarvis` ships. */
export const WAKE_MODELS: Readonly<Record<string, string>> = Object.freeze({
  melspectrogram: 'melspectrogram.onnx',
  embedding: 'embedding_model.onnx',
  vad: 'silero_vad.onnx',
  keywords: 'hey_jarvis_v0.1.onnx',
})

/** Keyword the shipped assets carry. */
export const WAKE_DEFAULT_KEYWORD = 'hey_jarvis'

/**
 * Model file for one keyword.
 *
 * The shipped keyword has a versioned file name; anything else is assumed to follow
 * the `<keyword>.onnx` convention, matching the host's own rule.
 * @param keyword - the configured keyword.
 * @returns the file name inside the asset directory.
 */
export function keywordFile(keyword: string): string {
  return keyword === WAKE_DEFAULT_KEYWORD ? WAKE_MODELS.keywords ?? '' : `${keyword}.onnx`
}

/** The ONNX Runtime build the page injects, plus the loader/binary pair it loads. */
export const WAKE_RUNTIME = Object.freeze({
  script: 'ort/ort.wasm.min.js',
  loader: 'ort/ort-wasm-simd-threaded.mjs',
  wasm: 'ort/ort-wasm-simd-threaded.wasm',
})

/** Content types, keyed by extension. `application/wasm` is load-bearing. */
const MIME: Readonly<Record<string, string>> = Object.freeze({
  '.onnx': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
})

/** Tuning the engine reads before it starts. */
export interface WakeConfig {
  /** Absolute model directory, or `''` when the host found none. */
  readonly assetDirectory: string
  /** openWakeWord keyword name. */
  readonly keyword: string
  /** Classifier score above which a frame counts as a detection. */
  readonly threshold: number
  /** Whether a detection opens the panel so the user sees it. */
  readonly autoExpandOnWake: boolean
  /** What the ball does after a detection: record one utterance and transcribe it. */
  readonly dictation: DictationConfig
}

/** One utterance after the wake word, transcribed by the Host's speech service. */
export interface DictationConfig {
  /** Whether the ball records after a detection. */
  readonly enabled: boolean
  /** Silence that ends the recording, milliseconds. */
  readonly silenceMs: number
  /** Hard cap on one utterance, seconds. */
  readonly maxSeconds: number
  /** `true` sends the transcript straight away, `false` only fills the ball's draft. */
  readonly autoSend: boolean
}

/** What a helper started by an older host, or without assets, uses. */
export const WAKE_DEFAULTS: WakeConfig = Object.freeze({
  assetDirectory: '',
  keyword: 'hey_jarvis',
  threshold: 0.5,
  autoExpandOnWake: true,
  dictation: Object.freeze({ enabled: true, silenceMs: 1200, maxSeconds: 15, autoSend: false }),
})

/** Environment variable holding the model directory. */
const ASSETS_ENV = 'DSH_ORB_WAKE_ASSETS'

/** Environment variable holding the tuning JSON. */
const CONFIG_ENV = 'DSH_ORB_WAKE'

/**
 * Read the wake configuration out of the launch environment.
 * @param env - the helper's environment.
 * @returns validated settings; missing or malformed values fall back to the defaults.
 */
export function readWakeConfig(env: NodeJS.ProcessEnv = process.env): WakeConfig {
  const directory = typeof env[ASSETS_ENV] === 'string' ? env[ASSETS_ENV].trim() : ''
  const parsed = parseConfig(env[CONFIG_ENV])
  return {
    assetDirectory: directory === '' ? '' : resolve(directory),
    keyword: readKeyword(parsed?.keyword),
    threshold: readThreshold(parsed?.threshold),
    autoExpandOnWake: parsed?.autoExpandOnWake === false ? false : WAKE_DEFAULTS.autoExpandOnWake,
    dictation: readDictation(parsed?.dictation),
  }
}

/** The dictation block, field by field; anything malformed keeps the shipped default. */
function readDictation(value: unknown): DictationConfig {
  const defaults = WAKE_DEFAULTS.dictation
  const block = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    enabled: typeof block.enabled === 'boolean' ? block.enabled : defaults.enabled,
    silenceMs: readBounded(block.silenceMs, defaults.silenceMs, 300, 10_000),
    maxSeconds: readBounded(block.maxSeconds, defaults.maxSeconds, 2, 120),
    autoSend: typeof block.autoSend === 'boolean' ? block.autoSend : defaults.autoSend,
  }
}

function readBounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** Whether the config names a directory at all; the page decides if it is usable. */
export function wakeAvailable(config: WakeConfig): boolean {
  return config.assetDirectory !== ''
}

/**
 * Register the scheme the ball loads assets from.
 *
 * Must run before `app.whenReady()` resolves, because a scheme's privileges cannot be
 * changed afterwards. `standard` makes it a fetchable origin; `supportFetchAPI` and
 * `corsEnabled` are what let the page pull the wasm and the models.
 */
export function registerWakeScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WAKE_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ])
}

/**
 * Serve the model directory on the wake scheme.
 * @param config - the launch configuration naming the directory.
 * @returns a disposer that unregisters the handler.
 */
export function serveWakeAssets(config: WakeConfig): () => void {
  const root = config.assetDirectory
  const files = allowedFiles(config.keyword)
  protocol.handle(WAKE_SCHEME, async (request) => {
    if (root === '') return new Response(null, { status: 404 })
    const target = wakeAssetPath(root, new URL(request.url).pathname, files)
    if (target === undefined) return new Response(null, { status: 404 })
    let info
    try {
      info = await stat(target)
    } catch {
      return new Response(null, { status: 404 })
    }
    if (!info.isFile()) return new Response(null, { status: 404 })
    return new Response(Readable.toWeb(createReadStream(target)) as unknown as ReadableStream, {
      status: 200,
      headers: {
        'content-type': MIME[extensionOf(target)] ?? 'application/octet-stream',
        'content-length': String(info.size),
        // Content-addressed by filename; a long private cache keeps the ~20 MB off
        // the wire every time the ball's page reloads.
        'cache-control': 'private, max-age=604800',
      },
    })
  })
  return () => {
    protocol.unhandle(WAKE_SCHEME)
  }
}

/**
 * Map one request path onto the asset directory.
 *
 * Only the shipped files are reachable, and the resolved path has to stay inside the
 * root — `..` cannot escape because the name whitelist rejects it first.
 * @param root - the absolute asset directory.
 * @param pathname - the request pathname, with the leading slash.
 * @param files - the whitelist for the configured keyword.
 * @returns the absolute file path, or undefined for anything unexpected.
 */
export function wakeAssetPath(
  root: string,
  pathname: string,
  files: readonly string[] = allowedFiles(WAKE_DEFAULT_KEYWORD),
): string | undefined {
  // The whitelist is written with forward slashes; a Windows client may send either.
  const name = decodeURIComponent(pathname).replace(/^\/+/, '').split('\\').join('/')
  if (name === '' || name.includes('..')) return undefined
  if (!files.includes(name)) return undefined
  const target = resolve(join(root, name))
  if (!target.startsWith(resolve(root) + sep)) return undefined
  return target
}

function allowedFiles(keyword: string): readonly string[] {
  return [
    ...Object.values(WAKE_MODELS).filter((file) => file !== WAKE_MODELS.keywords),
    keywordFile(keyword),
    WAKE_RUNTIME.script,
    WAKE_RUNTIME.loader,
    WAKE_RUNTIME.wasm,
  ]
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.')
  return dot === -1 ? '' : file.slice(dot).toLowerCase()
}

function parseConfig(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw !== 'string' || raw === '' || raw.length > 2000) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function readKeyword(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 80) return WAKE_DEFAULTS.keyword
  return /^[a-z0-9_]+$/i.test(value) ? value : WAKE_DEFAULTS.keyword
}

function readThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WAKE_DEFAULTS.threshold
  return Math.min(0.99, Math.max(0.05, value))
}
