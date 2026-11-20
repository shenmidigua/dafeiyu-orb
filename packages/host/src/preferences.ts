/**
 * Profile files the ball and the settings page share.
 * Names match the desktop fork so an existing profile keeps its choices.
 */

import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isAvatarPresetId } from './avatar-presets.ts'

const PERMISSION_FILE = 'orb-permission.json'
const MODELS_FILE = 'orb-agent-models.json'
const MILLIFRACTION_FILE = 'millifraction-coordinates.json'
const SELECTION_FILE = 'selection-toolbar.json'
const BALL_FILE = 'ball-enabled.json'
const WAKE_FILE = 'orb-wake.json'
const SPEECH_FILE = 'orb-speech.json'
const REPLY_FILE = 'orb-reply.json'
const CHIME_FILE = 'orb-chime.json'
const AVATAR_FILE = 'orb-avatar'
const AVATAR_META_FILE = 'orb-avatar.json'

export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

export interface AgentModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

export interface AgentModels {
  readonly overlay: AgentModelSelection
  readonly background: AgentModelSelection
}

export type AvatarMime = 'image/gif' | 'image/png' | 'image/webp'

/**
 * Local wake-word settings, stored in `orb-wake.json` next to the other profile files.
 *
 * The models themselves are never copied: `assetDirectory` only points at an existing
 * `dsh-voice-dialog/assets` folder (see `./wake-assets.ts`).
 */
export interface WakeSettings {
  /** Detection is off until the ball's menu turns it on. */
  readonly enabled: boolean
  /** openWakeWord keyword name. Only `hey_jarvis` ships a model. */
  readonly keyword: string
  /** Classifier score above which a frame counts, clamped to 0.05–0.99. */
  readonly threshold: number
  /** Explicit asset folder, or `''` to auto-discover. */
  readonly assetDirectory: string
  /** Whether a detection opens the ball's panel so the user sees the wake. */
  readonly autoExpandOnWake: boolean
  /** What happens after a detection: the ball listens once and transcribes the utterance. */
  readonly dictation: DictationSettings
  /** Whether a reply read to its end reopens the microphone for another voice turn. */
  readonly continuous: ContinuousSettings
}

/**
 * Continuous conversation: wake the ball once, then talk turn after turn.
 *
 * It hangs off the wake word because the microphone does: a reply is read, its end is the cue,
 * and the same recorder opens again. Off is available for a user who wants one turn per wake
 * word; on is the default because that is the experience the ball is for.
 */
export interface ContinuousSettings {
  /** Whether the microphone comes back after a spoken reply. */
  readonly enabled: boolean
  /** How long a reopened microphone waits for speech before it returns to the wake word, seconds. */
  readonly noSpeechSeconds: number
}

/**
 * One utterance after the wake word, transcribed by the Host's own speech service
 * (`ctx.speechToText`, the local SenseVoice provider). The audio never leaves the machine.
 */
export interface DictationSettings {
  /** Whether the ball records after a detection. */
  readonly enabled: boolean
  /**
   * Silence that ends the recording, milliseconds — the "you finished speaking" pause.
   *
   * Owned by the settings page's slider, which shows it as seconds (1–10, default 2.2) and converts
   * once on the way out; the file and the recorder stay in milliseconds.
   */
  readonly silenceMs: number
  /** Hard cap on one utterance, seconds. */
  readonly maxSeconds: number
  /** `true` sends the transcript straight to the session, `false` only fills the draft. */
  readonly autoSend: boolean
  /**
   * Where a wake sends the turn.
   *
   * `main` presses the microphone in the main DSH window's composer — the same recorder the user
   * would click, which is what "wake the chat box" means. `panel` keeps the turn inside the ball's
   * black panel. A profile that never chose keeps `main`: the main window is where the user reads
   * and types, and the ball only has to hear the wake word.
   */
  readonly target: DictationTarget
}

/** The two places a wake-word turn can be recorded. */
export type DictationTarget = 'main' | 'panel'

/**
 * The "you finished speaking" pause, in milliseconds.
 *
 * Stored in `orb-wake.json` as `dictation.silenceMs`, because that is the unit the recorder works in
 * and the file is shared with a hand edit. The settings page shows it as seconds, 1–10 with a step of
 * a tenth; these bounds are the file's own, loose enough for a hand-edited value and tight enough
 * that a typo cannot turn the recorder into one that never opens or one that never closes.
 */
export const MIN_SILENCE_MS = 300
export const MAX_SILENCE_MS = 10_000
export const DEFAULT_SILENCE_MS = 2_500
/**
 * How long a recorder may wait for the first word before it closes itself, milliseconds.
 *
 * Mirrors `DICTATION_NO_SPEECH_MS` in `packages/helper/assets/wake.js`, the limit the ball's own
 * recorder runs on. Every recorder this plugin starts uses this one number: the ball through the
 * shared profile, the main window's hand-off, and the composer's microphone button. It lives here
 * rather than in `orb.ts` so the route that hands the number to the page can import it without
 * pulling in the whole host.
 */
export const DICTATION_NO_SPEECH_MS = 6_000

/** What a missing or unreadable `orb-wake.json` means. */
export const WAKE_DEFAULTS: WakeSettings = {
  enabled: false,
  keyword: 'hey_jarvis',
  threshold: 0.5,
  assetDirectory: '',
  autoExpandOnWake: true,
  dictation: {
    enabled: true,
    silenceMs: DEFAULT_SILENCE_MS,
    maxSeconds: 15,
    autoSend: false,
    target: 'main',
  },
  continuous: {
    enabled: true,
    noSpeechSeconds: 6,
  },
}

/** What the ball shows: the shipped GIF, an uploaded image, or a built-in preset. */
export type AvatarSelection =
  | { kind: 'default' }
  | { kind: 'custom'; mime: AvatarMime }
  | { kind: 'preset'; id: string }

/**
 * Read-aloud settings, owned by the settings page.
 *
 * Split in two switches on purpose. `enabled` decides whether the play buttons exist at all, and
 * `autoPlay` decides whether a finished reply starts reading itself; a user who wants to listen on
 * demand says no to the second without losing the buttons.
 *
 * The endpoint travels with them because the TTS service is a separate program the user runs, and
 * moving it to another port should not need a rebuild.
 */
export interface SpeechSettings {
  /** Show the per-message play buttons. */
  readonly enabled: boolean
  /** Start reading each reply as soon as it finishes. */
  readonly autoPlay: boolean
  /** Base URL of the local TTS service. */
  readonly endpoint: string
}

/** What a missing or unreadable `orb-speech.json` means. Off, with the service's own default port. */
export const SPEECH_DEFAULTS: SpeechSettings = {
  enabled: false,
  autoPlay: false,
  endpoint: 'http://127.0.0.1:8765',
}

/** Only http(s) URLs, so a typo cannot turn the endpoint into a `file:` read. */
export function isSpeechEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Reply-style settings for the ball, stored in `orb-reply.json`.
 *
 * The ball is a voice loop: the user hears the answer and glances at the panel, so a long
 * structured reply — a table, ten links, a list of caveats — is worse than a wrong-length
 * sentence. The contract lives in the system prompt (see `./reply-style.ts`); these are the
 * two numbers the user may want to move.
 */
export interface ReplyStyleSettings {
  /** Whether the ball's agent gets the terse-reply contract at all. On unless turned off. */
  readonly enabled: boolean
  /** Hard cap on the spoken body, in characters. */
  readonly maxReplyChars: number
}

/**
 * What a missing or unreadable `orb-reply.json` means: minimal replies on, eighty characters.
 *
 * On by default on purpose — the file exists to turn the behaviour OFF for a user who types at
 * the ball instead of talking to it, not to opt in to something a voice user has to discover.
 */
export const REPLY_DEFAULTS: ReplyStyleSettings = {
  enabled: true,
  maxReplyChars: 80,
}

/** The cap is a length hint, not a formatting rule: below twenty the answer carries no fact. */
export const MIN_REPLY_CHARS = 20

/** Above two thousand the contract stops being minimal and the prompt line just reads odd. */
export const MAX_REPLY_CHARS = 2_000

/**
 * The hourly chime, stored in `orb-chime.json`.
 *
 * The ball speaking on its own is the one thing it does without being asked, so it is also the one
 * that has to be switchable off from where the user hears it. `enabled` is the ball's menu;
 * `quietFrom`/`quietTo` are the hours it stays silent, a wrap-around window (`22 → 6`). The wording
 * itself lives in `packages/helper/assets/chime.js`, because the page owns the voice and the timer.
 */
export interface ChimeSettings {
  /** Whether the ball speaks the time on the hour. */
  readonly enabled: boolean
  /** First silent hour, 0–24. Equal to `quietTo` means silence nowhere. */
  readonly quietFrom: number
  /** Hour silence ends, 0–24, exclusive. */
  readonly quietTo: number
}

/**
 * What a missing `orb-chime.json` means: on, with night silent.
 *
 * On because the ball is already something the user opted into and a chime nobody heard cannot be
 * judged; night silent because a 4 AM chime is the fastest way to get the whole feature switched
 * off. Same numbers as `CHIME_DEFAULTS` in the helper's `assets/chime.js`.
 */
export const CHIME_DEFAULTS: ChimeSettings = {
  enabled: true,
  quietFrom: 0,
  quietTo: 7,
}

/** The hour band the quiet window is clamped to; 24 is midnight-the-end, never an hour that strikes. */
export const CHIME_HOUR_MAX = 24

const DEFAULT_MODEL: AgentModelSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024

/**
 * Active official profile directory.
 * Desktop and `dsh web` both provide `profileContext.dir`. The process directory is the fallback.
 */
export function profileDirectory(ctx: { get(name: string): unknown }): string {
  const profile = ctx.get('profileContext')
  if (typeof profile === 'object' && profile !== null && 'dir' in profile) {
    const dir = (profile as { dir?: unknown }).dir
    if (typeof dir === 'string' && dir !== '') return dir
  }
  return process.cwd()
}

export function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === 'string' && (PERMISSION_PRESETS as readonly string[]).includes(value)
}

export function isAgentModelSelection(value: unknown): value is AgentModelSelection {
  return parseSelection(value) !== undefined
}

/** In-memory view of the profile files. Writes update the cache and the disk together. */
export class ProfileStore {
  private permissionValue: PermissionPreset
  private permissionFallbackValue: boolean
  private modelValue: AgentModels
  private millifractionValue: boolean
  private selectionValue: boolean
  private selectionLanguage: 'zh' | 'en'
  private ballValue: boolean
  private wakeValue: WakeSettings
  private speechValue: SpeechSettings

  constructor(readonly dir: string) {
    const permission = readPermission(dir)
    this.permissionValue = permission.preset
    this.permissionFallbackValue = permission.fallback
    this.modelValue = readModels(dir)
    this.millifractionValue = readMillifraction(dir)
    const selection = readSelection(dir)
    this.selectionValue = selection.enabled
    this.selectionLanguage = selection.language
    this.ballValue = readBall(dir)
    this.wakeValue = readWake(dir)
    this.speechValue = readSpeech(dir)
  }

  permission(): PermissionPreset {
    return this.permissionValue
  }

  /** True when the permission file exists but cannot be used. Missing means full access. */
  permissionFallback(): boolean {
    return this.permissionFallbackValue
  }

  setPermission(preset: PermissionPreset): void {
    this.permissionValue = preset
    this.permissionFallbackValue = false
    writeJson(join(this.dir, PERMISSION_FILE), { preset })
  }

  models(): AgentModels {
    return this.modelValue
  }

  setOverlay(selection: AgentModelSelection): void {
    this.modelValue = { overlay: selection, background: this.modelValue.background }
    this.writeModels()
  }

  setBackground(selection: AgentModelSelection): void {
    this.modelValue = { overlay: this.modelValue.overlay, background: selection }
    this.writeModels()
  }

  millifractionEnabled(): boolean {
    return this.millifractionValue
  }

  setMillifractionEnabled(enabled: boolean): void {
    this.millifractionValue = enabled
    writeJson(join(this.dir, MILLIFRACTION_FILE), { enabled })
  }

  /** Pixel on macOS, millifraction on Windows, unless the profile file says otherwise. */
  coordinateMode(): 'millifraction' | 'pixel' {
    return this.millifractionValue ? 'millifraction' : 'pixel'
  }

  selectionEnabled(): boolean {
    return this.selectionValue
  }

  translateLanguage(): 'zh' | 'en' {
    return this.selectionLanguage
  }

  setTranslateLanguage(language: 'zh' | 'en'): void {
    this.selectionLanguage = language
    writeJson(join(this.dir, SELECTION_FILE), {
      enabled: this.selectionValue,
      translateTargetLanguage: language,
    })
  }

  setSelectionEnabled(enabled: boolean): void {
    this.selectionValue = enabled
    writeJson(join(this.dir, SELECTION_FILE), {
      enabled,
      translateTargetLanguage: this.selectionLanguage,
    })
  }

  /** Missing file means the ball is on. `autoStart: false` is a separate patch switch. */
  ballEnabled(): boolean {
    return this.ballValue
  }

  setBallEnabled(enabled: boolean): void {
    this.ballValue = enabled
    writeJson(join(this.dir, BALL_FILE), { enabled })
  }

  /** Wake-word settings. Missing file means off with the shipped defaults. */
  wake(): WakeSettings {
    return this.wakeValue
  }

  /**
   * The ball's menu flips only this flag; every other field stays as configured.
   *
   * The file is re-read first, because it is not this process's alone. The user edits
   * `orb-wake.json` by hand, the settings page holds its own copy (it owns the silence slider; the
   * other dictation fields still have no UI), and the whole file is rewritten on every save — so
   * writing the snapshot taken at construction would quietly revert whatever landed on disk in the
   * meantime. Only `enabled` is this call's to change; everything else comes from the file as it
   * stands, revalidated by the same `readWake` that produced the original, so a hand-edited
   * out-of-range value is clamped rather than trusted.
   */
  setWakeEnabled(enabled: boolean): void {
    this.wakeValue = { ...readWake(this.dir), enabled }
    writeWake(this.dir, this.wakeValue)
  }

  /**
   * Move the "you finished speaking" pause, from the settings page's slider.
   *
   * Same shape as {@link setWakeEnabled}, and for the same reason: the file is re-read before the
   * write, because the ball's menu flips `enabled` on its own and a text editor can change anything
   * in it, and only this one field is this call's to change. The value is clamped to the band
   * `readWake` uses, so a slider dragged to either end cannot store something the reader would then
   * silently replace.
   *
   * The milliseconds stay milliseconds: the page converts its seconds once, at the edge, so there is
   * exactly one place where the unit can be got wrong.
   * @param silenceMs - the pause in milliseconds, from `0.3` to `10` seconds worth.
   */
  setDictationSilence(silenceMs: number): void {
    const current = readWake(this.dir)
    const next: WakeSettings = {
      ...current,
      dictation: {
        ...current.dictation,
        silenceMs: readBounded(silenceMs, current.dictation.silenceMs, MIN_SILENCE_MS, MAX_SILENCE_MS),
      },
    }
    this.wakeValue = next
    writeWake(this.dir, next)
  }

  /** Read-aloud settings. Missing file means off, pointing at the service's default port. */
  speech(): SpeechSettings {
    return this.speechValue
  }

  setSpeech(settings: SpeechSettings): void {
    this.speechValue = settings
    writeJson(join(this.dir, SPEECH_FILE), {
      enabled: settings.enabled,
      autoPlay: settings.autoPlay,
      endpoint: settings.endpoint,
    })
  }

  /**
   * The terse-reply settings.
   *
   * Read from disk on every call rather than from the construction snapshot: the ball's own menu
   * rewrites this file and a text editor can too, and a user who flips the switch should hear the
   * difference on the next answer instead of after a restart. One small read per prompt assembly is
   * nothing next to a model call.
   */
  reply(): ReplyStyleSettings {
    return readReply(this.dir)
  }

  /**
   * Write the reply switch from the ball's menu.
   *
   * Same shape as {@link setWakeEnabled}: the file is re-read first, because it is not this
   * process's alone (a user may edit it by hand at any time) and the whole file is rewritten on
   * every save — writing the construction snapshot would quietly revert whatever landed on disk in
   * the meantime. Only the fields given are this call's to change; the rest comes from the file as
   * it stands, revalidated by the same `readReply` that produced the read side.
   * @param next - the fields to change. Omitted fields keep their current value.
   */
  setReply(next: Partial<ReplyStyleSettings>): void {
    const current = readReply(this.dir)
    const merged: ReplyStyleSettings = {
      enabled: next.enabled ?? current.enabled,
      maxReplyChars: next.maxReplyChars ?? current.maxReplyChars,
    }
    writeJson(join(this.dir, REPLY_FILE), {
      enabled: merged.enabled,
      maxReplyChars: merged.maxReplyChars,
    })
  }

  /**
   * Hourly-chime settings, read from disk on every call.
   *
   * Same reason as {@link reply}: the ball's menu rewrites the file while this process runs, and a
   * hand edit should apply to the next hour without a restart.
   */
  chime(): ChimeSettings {
    return readChime(this.dir)
  }

  /**
   * Change the chime settings, re-reading the file first.
   *
   * The menu flips only `enabled`, and the whole file is rewritten on every save — so writing a
   * snapshot taken at construction would quietly revert a hand-edited quiet window. Only the given
   * fields change; the rest comes from the file as it stands, revalidated by {@link readChime}.
   */
  setChime(next: Partial<ChimeSettings>): void {
    const current = readChime(this.dir)
    const merged: ChimeSettings = {
      enabled: next.enabled ?? current.enabled,
      quietFrom: next.quietFrom ?? current.quietFrom,
      quietTo: next.quietTo ?? current.quietTo,
    }
    writeJson(join(this.dir, CHIME_FILE), {
      enabled: merged.enabled,
      quietFrom: merged.quietFrom,
      quietTo: merged.quietTo,
    })
  }

  /** Bumped by every avatar change: the ball refetches on it, the settings preview re-renders on it. */
  avatarVersion(): number {
    for (const name of [AVATAR_META_FILE, AVATAR_FILE]) {
      try {
        return statSync(join(this.dir, name)).mtimeMs
      } catch {
        // Try the next file; no avatar at all means version 0.
      }
    }
    return 0
  }

  /**
   * Avatar the profile currently shows, checked against what is on disk.
   * An unknown preset id or a half-written upload falls back to the shipped GIF.
   */
  avatarSelection(): AvatarSelection {
    const preset = record(readJson(join(this.dir, AVATAR_META_FILE)))?.preset
    if (isAvatarPresetId(preset)) return { kind: 'preset', id: preset }
    const custom = this.readAvatar()
    if (custom !== undefined) return { kind: 'custom', mime: custom.mime }
    return { kind: 'default' }
  }

  readAvatar(): { bytes: Buffer; mime: AvatarMime } | undefined {
    let bytes: Buffer
    try {
      bytes = readFileSync(join(this.dir, AVATAR_FILE))
    } catch {
      return undefined
    }
    const sniffed = sniffAvatarMime(bytes)
    if (sniffed === undefined) return undefined
    const declared = readAvatarMime(this.dir)
    if (declared !== undefined && declared !== sniffed) return undefined
    return { bytes, mime: declared ?? sniffed }
  }

  /** One avatar per profile: an uploaded image drops the preset pick and the other way round. */
  writeAvatar(bytes: Uint8Array, mime: AvatarMime): void {
    writeBytes(join(this.dir, AVATAR_FILE), bytes)
    writeJson(join(this.dir, AVATAR_META_FILE), { kind: 'custom', mime })
  }

  selectAvatarPreset(id: string): void {
    writeJson(join(this.dir, AVATAR_META_FILE), { kind: 'preset', preset: id })
    removeIfPresent(join(this.dir, AVATAR_FILE))
  }

  restoreAvatar(): void {
    for (const name of [AVATAR_FILE, AVATAR_META_FILE]) {
      removeIfPresent(join(this.dir, name))
    }
  }

  private writeModels(): void {
    writeJson(join(this.dir, MODELS_FILE), {
      overlay: serializeSelection(this.modelValue.overlay),
      background: serializeSelection(this.modelValue.background),
    })
  }
}

export function sniffAvatarMime(bytes: Uint8Array): AvatarMime | undefined {
  if (bytes.length >= 6
    && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return 'image/gif'
  }
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp'
  }
  return undefined
}

export function defaultMillifraction(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32'
}

function readPermission(dir: string): { preset: PermissionPreset; fallback: boolean } {
  let raw: string
  try {
    raw = readFileSync(join(dir, PERMISSION_FILE), 'utf8')
  } catch (error) {
    if (isEnoent(error)) return { preset: 'danger-full-access', fallback: false }
    return { preset: 'workspace-write', fallback: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return { preset: 'workspace-write', fallback: true }
  }
  const preset = record(parsed)?.preset
  if (isPermissionPreset(preset)) return { preset, fallback: false }
  return { preset: 'workspace-write', fallback: true }
}

function readModels(dir: string): AgentModels {
  const value = record(readJson(join(dir, MODELS_FILE)))
  return {
    overlay: parseSelection(value?.overlay) ?? DEFAULT_MODEL,
    background: parseSelection(value?.background) ?? DEFAULT_MODEL,
  }
}

function readMillifraction(dir: string): boolean {
  const enabled = record(readJson(join(dir, MILLIFRACTION_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : defaultMillifraction()
}

function readSelection(dir: string): { enabled: boolean; language: 'zh' | 'en' } {
  const value = record(readJson(join(dir, SELECTION_FILE)))
  const language = value?.translateTargetLanguage === 'en' ? 'en' : 'zh'
  // The selection toolbar is disabled everywhere (buggy). The stored flag is
  // ignored so profiles that enabled it before also stay off; only the
  // language preference is still honored.
  return { enabled: false, language }
}

function readBall(dir: string): boolean {
  const enabled = record(readJson(join(dir, BALL_FILE)))?.enabled
  return typeof enabled === 'boolean' ? enabled : true
}

/** Wake settings, with every field independently validated against the defaults. */
function readWake(dir: string): WakeSettings {
  const value = record(readJson(join(dir, WAKE_FILE)))
  return {
    enabled: value?.enabled === true,
    keyword: readWakeKeyword(value?.keyword),
    threshold: readWakeThreshold(value?.threshold),
    assetDirectory: typeof value?.assetDirectory === 'string' && value.assetDirectory.length <= 1000
      ? value.assetDirectory
      : WAKE_DEFAULTS.assetDirectory,
    autoExpandOnWake: typeof value?.autoExpandOnWake === 'boolean'
      ? value.autoExpandOnWake
      : WAKE_DEFAULTS.autoExpandOnWake,
    dictation: readDictation(value?.dictation),
    continuous: readContinuous(value?.continuous),
  }
}

/** The continuous block: on unless explicitly turned off, with the quiet window clamped. */
function readContinuous(value: unknown): ContinuousSettings {
  const defaults = WAKE_DEFAULTS.continuous
  const block = record(value)
  return {
    enabled: typeof block?.enabled === 'boolean' ? block.enabled : defaults.enabled,
    noSpeechSeconds: readBounded(block?.noSpeechSeconds, defaults.noSpeechSeconds, 2, 30),
  }
}

/** The dictation block, field by field, clamped to what the speech service accepts. */
function readDictation(value: unknown): DictationSettings {
  const defaults = WAKE_DEFAULTS.dictation
  const block = record(value)
  return {
    enabled: typeof block?.enabled === 'boolean' ? block.enabled : defaults.enabled,
    silenceMs: readBounded(block?.silenceMs, defaults.silenceMs, MIN_SILENCE_MS, MAX_SILENCE_MS),
    maxSeconds: readBounded(block?.maxSeconds, defaults.maxSeconds, 2, 120),
    autoSend: typeof block?.autoSend === 'boolean' ? block.autoSend : defaults.autoSend,
    // Anything but the two known words keeps the default, so a hand-edited file cannot point the
    // wake at a target that does not exist.
    target: block?.target === 'panel' ? 'panel' : defaults.target,
  }
}

function readBounded(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function readWakeKeyword(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.length > 80) return WAKE_DEFAULTS.keyword
  return /^[a-z0-9_]+$/i.test(value) ? value : WAKE_DEFAULTS.keyword
}

/** The same usable band the voice plugin clamps to. */
function readWakeThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WAKE_DEFAULTS.threshold
  return Math.min(0.99, Math.max(0.05, value))
}

/** Speech settings, each field falling back to the default on its own. */
function readSpeech(dir: string): SpeechSettings {
  const value = record(readJson(join(dir, SPEECH_FILE)))
  return {
    // `=== true` rather than a default of `true`: a profile that never opened the settings page has
    // no TTS service behind it, so the safe answer is off.
    enabled: value?.enabled === true,
    autoPlay: value?.autoPlay === true,
    endpoint: isSpeechEndpoint(value?.endpoint) ? value.endpoint : SPEECH_DEFAULTS.endpoint,
  }
}

/**
 * Reply-style settings, each field falling back to the default on its own.
 *
 * Missing file means on: the terse contract is the shipped behaviour, and only an explicit
 * `"enabled": false` turns it off.
 */
function readReply(dir: string): ReplyStyleSettings {
  const value = record(readJson(join(dir, REPLY_FILE)))
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : REPLY_DEFAULTS.enabled,
    maxReplyChars: readBounded(value?.maxReplyChars, REPLY_DEFAULTS.maxReplyChars, MIN_REPLY_CHARS, MAX_REPLY_CHARS),
  }
}

/**
 * Chime settings, each field falling back on its own.
 *
 * Missing file means on with night silent, so a profile that has never opened the menu still gets
 * the feature the ball was installed for. The hour band is clamped rather than trusted: a hand-edited
 * `31` would otherwise be a window that silences nothing while looking like it silences everything.
 */
function readChime(dir: string): ChimeSettings {
  const value = record(readJson(join(dir, CHIME_FILE)))
  return {
    enabled: typeof value?.enabled === 'boolean' ? value.enabled : CHIME_DEFAULTS.enabled,
    quietFrom: readBounded(value?.quietFrom, CHIME_DEFAULTS.quietFrom, 0, CHIME_HOUR_MAX),
    quietTo: readBounded(value?.quietTo, CHIME_DEFAULTS.quietTo, 0, CHIME_HOUR_MAX),
  }
}

function writeWake(dir: string, settings: WakeSettings): void {
  writeJson(join(dir, WAKE_FILE), {
    enabled: settings.enabled,
    keyword: settings.keyword,
    threshold: settings.threshold,
    assetDirectory: settings.assetDirectory,
    autoExpandOnWake: settings.autoExpandOnWake,
    dictation: {
      enabled: settings.dictation.enabled,
      silenceMs: settings.dictation.silenceMs,
      maxSeconds: settings.dictation.maxSeconds,
      autoSend: settings.dictation.autoSend,
      target: settings.dictation.target,
    },
    continuous: {
      enabled: settings.continuous.enabled,
      noSpeechSeconds: settings.continuous.noSpeechSeconds,
    },
  })
}

function readAvatarMime(dir: string): AvatarMime | undefined {
  const mime = record(readJson(join(dir, AVATAR_META_FILE)))?.mime
  if (mime === 'image/gif' || mime === 'image/png' || mime === 'image/webp') return mime
  return undefined
}

function parseSelection(value: unknown): AgentModelSelection | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  if (typeof item.provider !== 'string' || item.provider === '' || item.provider.length > 200) return undefined
  if (typeof item.model !== 'string' || item.model === '' || item.model.length > 200) return undefined
  if (item.reasoningEffort !== undefined && (typeof item.reasoningEffort !== 'string' || item.reasoningEffort === '' || item.reasoningEffort.length > 80)) {
    return undefined
  }
  return {
    provider: item.provider,
    model: item.model,
    ...typeof item.reasoningEffort === 'string' ? { reasoningEffort: item.reasoningEffort } : {},
  }
}

function serializeSelection(selection: AgentModelSelection): AgentModelSelection {
  return {
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function writeJson(file: string, value: unknown): void {
  writeBytes(file, Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`))
}

function writeBytes(file: string, bytes: Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, file)
}

function removeIfPresent(file: string): void {
  try {
    unlinkSync(file)
  } catch (error) {
    if (!isEnoent(error)) throw error
  }
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT'
}
