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
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { isWakeEngine, WAKE_ENGINE_DEFAULT, type WakeEngineId } from './wake-engines.ts'

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

// The spoken name of a keyword lives in `wake-names.ts`, next to no imports, so that it can be tested
// without loading `electron`. Import it from there rather than from this module.

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
  '.wav': 'audio/wav',
})

/**
 * Folder inside the helper's own assets that ships the spoken wake confirmation.
 *
 * A different root from the models: those are passed in by the host from `dsh-voice-dialog`, while
 * these clips are part of this plugin. The page reaches them on the same `dsh-wake://assets/`
 * origin, so a packaged install resolves them without a `file://` URL and without touching the
 * model directory.
 */
export const WAKE_VOICE_DIRECTORY = 'voices'

/**
 * One WAV inside the wake confirmation folder, and nothing else.
 *
 * Letters rather than ASCII on purpose: the takes are named for what they say (`德拉曼-3-我在请您吩咐.wav`), because a person opening the folder is the one who has to tell them apart, and a voice id plus a number tells them nothing. Everything a filesystem chokes on — separators, wildcards, quotes — stays out, and `..` is rejected before this test by `wakeVoicePath`.
 */
const VOICE_FILE = /^voices\/[\p{L}\p{N}._-]+\.wav$/u

/**
 * The three files sherpa-onnx's keyword spotter needs, under `assets/kws`.
 *
 * Named here rather than inside `wake-sherpa.ts` so the availability check and the loader cannot
 * disagree about what "the models are there" means: a package missing one of these loads nothing,
 * and the menu should grey the engine out instead of letting a click fail.
 */
const KWS_MODEL_FILES: readonly string[] = Object.freeze([
  'encoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  'decoder-epoch-12-avg-2-chunk-16-left-64.onnx',
  'joiner-epoch-12-avg-2-chunk-16-left-64.onnx',
  'tokens.txt',
])

/** Tuning the engine reads before it starts. */
export interface WakeConfig {
  /** Which engine listens: the openWakeWord classifiers, or the sherpa-onnx decoder. */
  readonly engine: WakeEngineId
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
  /** Whether a reply read to its end reopens the microphone for another turn. */
  readonly continuous: ContinuousConfig
}

/** Continuous conversation, fed by the ends of spoken replies. */
export interface ContinuousConfig {
  /** Whether the microphone comes back after a spoken reply. */
  readonly enabled: boolean
  /** How long a reopened microphone waits for speech before it returns to the wake word, seconds. */
  readonly noSpeechSeconds: number
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
  /**
   * Where the turn is recorded: the main window's composer microphone (`main`), or the ball's own
   * black panel (`panel`). The page routes on it; nothing else in this process changes.
   */
  readonly target: 'main' | 'panel'
}

/** What a helper started by an older host, or without assets, uses. */
export const WAKE_DEFAULTS: WakeConfig = Object.freeze({
  engine: WAKE_ENGINE_DEFAULT,
  assetDirectory: '',
  keyword: 'hey_jarvis',
  threshold: 0.5,
  autoExpandOnWake: true,
  dictation: Object.freeze({ enabled: true, silenceMs: 2200, maxSeconds: 15, autoSend: false, target: 'main' }),
  continuous: Object.freeze({ enabled: true, noSpeechSeconds: 6 }),
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
    engine: isWakeEngine(parsed?.engine) ? parsed.engine : WAKE_DEFAULTS.engine,
    assetDirectory: directory === '' ? '' : resolve(directory),
    keyword: readKeyword(parsed?.keyword),
    threshold: readThreshold(parsed?.threshold),
    autoExpandOnWake: parsed?.autoExpandOnWake === false ? false : WAKE_DEFAULTS.autoExpandOnWake,
    dictation: readDictation(parsed?.dictation),
    continuous: readContinuous(parsed?.continuous),
  }
}

/** The continuous block, field by field; anything malformed keeps the shipped default. */
function readContinuous(value: unknown): ContinuousConfig {
  const defaults = WAKE_DEFAULTS.continuous
  const block = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  return {
    enabled: typeof block.enabled === 'boolean' ? block.enabled : defaults.enabled,
    noSpeechSeconds: readBounded(block.noSpeechSeconds, defaults.noSpeechSeconds, 2, 30),
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
    target: block.target === 'panel' ? 'panel' : defaults.target,
  }
}

function readBounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * Whether this helper can honour the configured engine at all.
 *
 * The two engines look for different things: openWakeWord needs the host-seeded model directory and
 * that directory's files are served to the page, while sherpa-onnx reads models that ship **inside
 * this package** (`assets/kws`) and needs no external folder. A profile pointed at the decoder but
 * with no `dsh-voice-dialog` assets is therefore still usable — and that is the case this split
 * exists for.
 * @param config - the launch configuration.
 * @param assets - this helper's own asset folder, which holds `kws`.
 */
export function wakeAvailable(config: WakeConfig, assets = ''): boolean {
  if (config.engine === 'sherpa') {
    if (assets === '') return false
    const folder = join(assets, 'kws')
    return [...KWS_MODEL_FILES, `keywords-${config.keyword}.txt`]
      .every((name) => existsSync(join(folder, name)))
  }
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
 * Serve the model directory on the wake scheme, plus the helper's own spoken wake clips.
 *
 * The two roots are separate on purpose: models are an external folder the host seeds, while the
 * confirmation WAVs ship inside this package. The page asks for both through one origin.
 * @param config - the launch configuration naming the model directory.
 * @param voiceRoot - the helper's own asset folder, which contains the voice clips, or `''`.
 * @returns a disposer that unregisters the handler.
 */
export function serveWakeAssets(config: WakeConfig, voiceRoot = ''): () => void {
  const root = config.assetDirectory
  const files = allowedFiles(config.keyword)
  protocol.handle(WAKE_SCHEME, async (request) => {
    const pathname = new URL(request.url).pathname
    // Models first, then the built-in clips: one request path can only match one of the two, and
    // the model whitelist is the narrow one that has to keep winning for its own files.
    const target = wakeAssetPath(root, pathname, files) ?? wakeVoicePath(voiceRoot, pathname)
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
  if (root === '') return undefined
  // The whitelist is written with forward slashes; a Windows client may send either.
  const name = decodeURIComponent(pathname).replace(/^\/+/, '').split('\\').join('/')
  if (name === '' || name.includes('..')) return undefined
  if (!files.includes(name)) return undefined
  const target = resolve(join(root, name))
  if (!target.startsWith(resolve(root) + sep)) return undefined
  return target
}

/**
 * Map one request path onto the helper's own voice folder.
 *
 * Deliberately a narrower rule than the model whitelist: only `voices/<name>.wav`, so the model
 * directory's paths and the package's other assets are not reachable through this branch.
 * @param root - the helper's asset directory, which contains `voices`.
 * @param pathname - the request pathname, with the leading slash.
 * @returns the absolute file path, or undefined for anything else.
 */
export function wakeVoicePath(root: string, pathname: string): string | undefined {
  if (root === '') return undefined
  const name = decodeURIComponent(pathname).replace(/^\/+/, '').split('\\').join('/')
  if (name.includes('..') || !VOICE_FILE.test(name)) return undefined
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
