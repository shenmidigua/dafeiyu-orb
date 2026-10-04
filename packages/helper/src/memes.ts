/**
 * Meme bursts for the resting ball.
 * The helper owns this cosmetic layer: an idle ball shows a frozen avatar frame, so the
 * page asks for one random image at a time and plays it for a moment. Nothing here
 * touches the host, the session, or the stored avatar.
 */

import { readFile, readdir } from 'node:fs/promises'
import { basename, extname, isAbsolute, join } from 'node:path'

/** Image kinds a burst frame may be. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '.gif': 'image/gif',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

/** Largest frame the ball accepts: the bytes cross IPC as one base64 string. */
const MAX_FRAME_BYTES = 12_000_000
/** Folder listings are reused for a minute, so a burst never rescans a large pack. */
const LIST_TTL_MS = 60_000
/** The config file is re-read on this cadence: editing it needs no restart. */
const CONFIG_TTL_MS = 10_000
/** How deep a folder scan walks. Shipped packs nest one or two levels. */
const MAX_DEPTH = 4
/** Candidates tried before one burst frame gives up on unreadable files. */
const ATTEMPTS = 4
/** One pass of a GIF whose delays cannot be read, and the ceiling for the ones that can. */
const GIF_FALLBACK_MS = 1200
const GIF_MAX_MS = 8000

/** Timing of one burst. */
export interface MemeSchedule {
  /** Bursts are off unless the config file turns them on. */
  readonly enabled: boolean
  /** Idle time between bursts, milliseconds. */
  readonly gapMs: readonly [number, number]
  /** How long one frame stays on the ball, milliseconds. */
  readonly holdMs: readonly [number, number]
  /** Frames one burst plays. */
  readonly frames: readonly [number, number]
}

/** What a missing or unreadable config file means. */
export const MEME_DEFAULTS: MemeSchedule = {
  enabled: false,
  gapMs: [30_000, 90_000],
  holdMs: [500, 900],
  frames: [3, 6],
}

/** One named image the ball shows in a cosmetic state, such as the resting loop. */
export interface NamedFrame {
  /** On by default whenever the config names a file; `"enabled": false` keeps the still frame. */
  readonly enabled: boolean
  /** A file name inside a configured `dir`, a path below it, or an absolute path. */
  readonly file: string
}

/** The peek state: the loop plus an optional intro played once when the pointer arrives. */
export interface HoverFrame extends NamedFrame {
  /** A file name played once before {@link file}, or `''` for no intro. */
  readonly intro: string
}

/** What the ball shows while the pointer is on it. */
export interface HoverFrames {
  /** The loop. */
  readonly src: string
  /** The one-pass intro and how long it lasts. */
  readonly intro: { readonly src: string; readonly ms: number } | null
}

/** No named frame: that state keeps the frozen avatar. */
export const FRAME_DEFAULTS: NamedFrame = { enabled: false, file: '' }

/** No peek: the pointer leaves the avatar alone. */
export const HOVER_DEFAULTS: HoverFrame = { ...FRAME_DEFAULTS, intro: '' }

/** The yawn that opens the nap: one file played a few times before the timeline starts. */
interface YawnFrame extends NamedFrame {
  /** How many times the file plays before the first nap frame. */
  readonly times: number
}

/** No yawn: the nap goes straight to its first frame. */
export const YAWN_DEFAULTS: YawnFrame = { enabled: false, file: '', times: 2 }

/** The idle-escalation timeline: a nap that deepens while nobody touches the ball. */
export interface SleepPlan {
  /** On whenever the config names files; `"enabled": false` keeps the plain resting loop. */
  readonly enabled: boolean
  /** Idle time before the first frame, milliseconds. */
  readonly afterMs: number
  /** Idle time between the following frames, milliseconds. */
  readonly stepMs: number
  /** Played right before the first frame, so the ball dozes off instead of snapping to it. */
  readonly yawn: YawnFrame
  /** Files played in order; the last one holds until the user comes back. */
  readonly files: readonly string[]
}

/** No nap: the ball keeps looping its resting frame. */
export const SLEEP_DEFAULTS: SleepPlan = {
  enabled: false,
  afterMs: 300_000,
  stepMs: 300_000,
  yawn: YAWN_DEFAULTS,
  files: [],
}

/** What the page needs to schedule the yawn. The image itself is read only once it is due. */
export interface YawnPlan {
  /** One pass of the file, milliseconds. */
  readonly ms: number
  readonly times: number
}

/** What the page needs to drive the nap; frames are fetched one at a time. */
export interface SleepPlanInfo {
  readonly afterMs: number
  readonly stepMs: number
  readonly count: number
  /** The pre-roll before frame 0, or `null` while it is off or no file resolves. */
  readonly yawn: YawnPlan | null
}

/** A frame the ball plays for as long as its own animation lasts. */
export interface TimedFrame {
  readonly src: string
  readonly ms: number
}

/** A short scripted idle skit: one frame repeated a few times with another dropped in the middle. */
export interface SkitPlan {
  /** Idle time between skits, milliseconds. */
  readonly gapMs: readonly [number, number]
  /** The repeated frame and how many times one skit plays it. */
  readonly file: TimedFrame
  readonly times: readonly [number, number]
  /** One extra frame played in the middle of the repeats, or `null`. */
  readonly interject: TimedFrame | null
}

/** One named file of a skit, plus the cadence, repetition range, and its middle frame. */
interface SkitFrame extends NamedFrame {
  readonly gapMs: readonly [number, number]
  readonly times: readonly [number, number]
  readonly interject: string
}

/** No skit. */
export const SKIT_DEFAULTS: SkitFrame = {
  enabled: false,
  file: '',
  gapMs: [120_000, 300_000],
  times: [3, 5],
  interject: '',
}

/** The helper half of the ball's cosmetic frames: the resting loop, hover, typing, replying, and the bursts. */
export interface MemePicker {
  /** Timing the ball page schedules bursts with. */
  schedule(): Promise<MemeSchedule>
  /** A `data:` URL of the resting loop, or `null` while none is configured or readable. */
  idle(): Promise<string | null>
  /** The peek frames: the loop and its one-pass intro, or `null` while none is configured. */
  hover(): Promise<HoverFrames | null>
  /**
   * A `data:` URL the ball wears while it is taking dictation.
   *
   * It is a loop rather than a one-shot because it has to last exactly as long as the microphone
   * is open plus however long the host takes to answer — a length nobody knows in advance.
   */
  voice(): Promise<string | null>
  /**
   * A `data:` URL the ball wears while it is reading an answer aloud.
   *
   * A loop for the same reason {@link voice} is one: the length of a spoken reply is not known
   * when it starts, so the frame has to hold until the audio stops rather than for a fixed time.
   */
  speak(): Promise<string | null>
  /** A `data:` URL the ball shows while its own composer is being typed into. */
  typing(): Promise<string | null>
  /** A `data:` URL the ball shows while the agent streams a text answer. */
  reply(): Promise<string | null>
  /** A `data:` URL the ball shows while the agent is reasoning about the request. */
  thinking(): Promise<string | null>
  /** A `data:` URL the ball shows while a tool call is running. */
  tool(): Promise<string | null>
  /** The click reaction, played once with the length of its own animation. */
  click(): Promise<TimedFrame | null>
  /** The finished-task frame, played once with the length of its own animation. */
  done(): Promise<TimedFrame | null>
  /** The wake-word frame, played once as soon as the keyword fires. */
  wake(): Promise<TimedFrame | null>
  /** A `data:` URL the ball wears while it is being dragged around the screen. */
  drag(): Promise<string | null>
  /** The release reaction, played once the pointer lets go: the drop, not the carry. */
  drop(): Promise<TimedFrame | null>
  /** The nap timeline, or `null` while it is off or no file resolves. */
  sleep(): Promise<SleepPlanInfo | null>
  /** One nap frame by index, read when the page reaches that step. */
  sleepFrame(index: number): Promise<string | null>
  /** The yawn pre-roll as a `data:` URL, read when the nap actually reaches it. */
  yawn(): Promise<string | null>
  /** The idle skit, or `null` while it is off or no file resolves. */
  skit(): Promise<SkitPlan | null>
  /** A `data:` URL of one random image, or `null` while bursts are off or the packs are empty. */
  next(): Promise<string | null>
}

interface MemeConfig extends MemeSchedule {
  readonly dirs: readonly string[]
  readonly idle: NamedFrame
  readonly hover: HoverFrame
  readonly voice: NamedFrame
  readonly speak: NamedFrame
  readonly typing: NamedFrame
  readonly reply: NamedFrame
  readonly thinking: NamedFrame
  readonly tool: NamedFrame
  readonly click: NamedFrame
  readonly done: NamedFrame
  readonly wake: NamedFrame
  readonly drag: NamedFrame
  readonly drop: NamedFrame
  readonly sleep: SleepPlan
  readonly skit: SkitFrame
}

/**
 * Read the config from `configPath` on demand:
 * `{ "enabled": true, "dir": "D:/packs/fish", "gapMs": [20000, 60000], "holdMs": [600, 1000],
 *    "frames": [3, 6], "idle": { "file": "idle.gif" }, "hover": { "file": "peek.gif", "intro": "in.gif" },
 *    "typing": { "file": "typing.gif" }, "reply": { "file": "answer.gif" },
 *    "voice": { "file": "nod.gif" }, "speak": { "file": "talk.gif" },
 *    "thinking": { "file": "reasoning.gif" }, "tool": { "file": "tool.gif" },
 *    "click": { "file": "pat.gif" }, "done": { "file": "bell.gif" }, "wake": { "file": "bang.gif" },
 *    "drag": { "file": "scared.gif" }, "drop": { "file": "land.gif" },
 *    "sleep": { "afterMs": 300000, "stepMs": 300000, "yawn": { "file": "yawn.gif", "times": 2 },
 *               "files": ["nap1.gif", "nap2.gif"] },
 *    "skit": { "gapMs": [120000, 300000], "file": "skit.gif", "times": [3, 5], "interject": "mid.gif" } }`
 * `dir` takes one folder or a list. `random` is injectable so tests stay deterministic.
 */
export function createMemePicker(configPath: string, random: () => number = Math.random): MemePicker {
  let config: MemeConfig | undefined
  let configReadAt = 0
  let listing: { readonly dirs: readonly string[]; readonly files: readonly string[]; readonly at: number } | undefined

  let sleepPaths: readonly string[] = []
  let sleepPathsKey = ''

  let yawnFound: { readonly path: string; readonly ms: number } | null = null
  let yawnKey = ''

  async function loadConfig(): Promise<MemeConfig> {
    const now = Date.now()
    if (config !== undefined && now - configReadAt < CONFIG_TTL_MS) return config
    configReadAt = now
    config = await readConfig(configPath)
    if (listing !== undefined && !sameDirs(listing.dirs, config.dirs)) listing = undefined
    return config
  }

  async function files(dirs: readonly string[]): Promise<readonly string[]> {
    const now = Date.now()
    if (listing !== undefined && sameDirs(listing.dirs, dirs) && now - listing.at < LIST_TTL_MS) return listing.files
    const found: string[] = []
    for (const dir of dirs) await collect(dir, 0, found)
    listing = { dirs, files: found, at: now }
    return found
  }

  /** Resolve a named frame to a file on disk: an absolute path, a path below `dirs[0]`, or a bare name anywhere in the packs. */
  async function locate(frame: NamedFrame, dirs: readonly string[]): Promise<string | null> {
    if (!frame.enabled || frame.file === '') return null
    if (isAbsolute(frame.file)) return frame.file
    const base = dirs[0]
    if (base === undefined) return null
    const direct = join(base, frame.file)
    if (await readBytes(direct) !== null) return direct
    // Shipped packs nest a folder deep, so a bare file name is matched anywhere in the pack.
    const wanted = basename(frame.file)
    return (await files(dirs)).find((path) => basename(path) === wanted) ?? null
  }

  async function named(frame: NamedFrame, dirs: readonly string[]): Promise<string | null> {
    const path = await locate(frame, dirs)
    return path === null ? null : readFrame(path)
  }

  /** A named file as a `data:` URL plus one pass of its own animation. */
  async function timedFrame(file: string, dirs: readonly string[]): Promise<TimedFrame | null> {
    const path = await locate({ enabled: true, file }, dirs)
    const body = path === null ? null : await readBytes(path)
    if (path === null || body === null) return null
    const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/gif'
    return { src: `data:${mime};base64,${body.toString('base64')}`, ms: gifDurationMs(body) }
  }

  /** The nap files that actually resolve, in config order. Re-resolved when the config changes. */
  async function sleepFiles(current: MemeConfig): Promise<readonly string[]> {
    const key = `${current.sleep.files.join('|')}::${current.dirs.join('|')}`
    if (key === sleepPathsKey) return sleepPaths
    const found: string[] = []
    for (const file of current.sleep.files) {
      const path = await locate({ enabled: true, file }, current.dirs)
      if (path !== null) found.push(path)
    }
    sleepPaths = found
    sleepPathsKey = key
    return found
  }

  /**
   * The yawn file and the length of one pass.
   *
   * Reading it costs a full pack walk when the name is not directly below `dirs[0]`, and the
   * file is far larger than the other frames, so both the path and the duration are remembered:
   * `sleep()` needs the duration to schedule, `yawn()` needs the path to read the image, and
   * together they would otherwise resolve the same file twice per page.
   */
  async function resolveYawn(current: MemeConfig): Promise<{ path: string; ms: number } | null> {
    const yawn = current.sleep.yawn
    const key = `${yawn.enabled}|${yawn.file}::${current.dirs.join('|')}`
    if (key === yawnKey) return yawnFound
    yawnKey = key
    yawnFound = null
    if (!yawn.enabled) return null
    const path = await locate({ enabled: true, file: yawn.file }, current.dirs)
    if (path === null) return null
    const body = await readBytes(path)
    if (body === null) return null
    yawnFound = { path, ms: gifDurationMs(body) }
    return yawnFound
  }

  return {
    async schedule() {
      const current = await loadConfig()
      return { enabled: current.enabled, gapMs: current.gapMs, holdMs: current.holdMs, frames: current.frames }
    },
    async idle() {
      const current = await loadConfig()
      return named(current.idle, current.dirs)
    },
    async hover() {
      const current = await loadConfig()
      const src = await named(current.hover, current.dirs)
      if (src === null) return null
      if (current.hover.intro === '') return { src, intro: null }
      return { src, intro: await timedFrame(current.hover.intro, current.dirs) }
    },
    async voice() {
      const current = await loadConfig()
      return named(current.voice, current.dirs)
    },
    async speak() {
      const current = await loadConfig()
      return named(current.speak, current.dirs)
    },
    async typing() {
      const current = await loadConfig()
      return named(current.typing, current.dirs)
    },
    async reply() {
      const current = await loadConfig()
      return named(current.reply, current.dirs)
    },
    async thinking() {
      const current = await loadConfig()
      return named(current.thinking, current.dirs)
    },
    async tool() {
      const current = await loadConfig()
      return named(current.tool, current.dirs)
    },
    async click() {
      const current = await loadConfig()
      if (!current.click.enabled) return null
      return timedFrame(current.click.file, current.dirs)
    },
    async done() {
      const current = await loadConfig()
      if (!current.done.enabled) return null
      return timedFrame(current.done.file, current.dirs)
    },
    async wake() {
      const current = await loadConfig()
      if (!current.wake.enabled) return null
      return timedFrame(current.wake.file, current.dirs)
    },
    async drag() {
      const current = await loadConfig()
      return named(current.drag, current.dirs)
    },
    async drop() {
      const current = await loadConfig()
      if (!current.drop.enabled) return null
      return timedFrame(current.drop.file, current.dirs)
    },
    async sleep() {
      const current = await loadConfig()
      if (!current.sleep.enabled) return null
      const files = await sleepFiles(current)
      if (files.length === 0) return null
      const yawn = await resolveYawn(current)
      return {
        afterMs: current.sleep.afterMs,
        stepMs: current.sleep.stepMs,
        count: files.length,
        yawn: yawn === null ? null : { ms: yawn.ms, times: current.sleep.yawn.times },
      }
    },
    async sleepFrame(index) {
      const current = await loadConfig()
      if (!current.sleep.enabled || !Number.isInteger(index) || index < 0) return null
      const path = (await sleepFiles(current))[index]
      return path === undefined ? null : readFrame(path)
    },
    async yawn() {
      const current = await loadConfig()
      if (!current.sleep.enabled) return null
      const found = await resolveYawn(current)
      return found === null ? null : readFrame(found.path)
    },
    async skit() {
      const current = await loadConfig()
      if (!current.skit.enabled) return null
      const file = await timedFrame(current.skit.file, current.dirs)
      if (file === null) return null
      const interject = current.skit.interject === ''
        ? null
        : await timedFrame(current.skit.interject, current.dirs)
      return { gapMs: current.skit.gapMs, file, times: current.skit.times, interject }
    },
    async next() {
      const current = await loadConfig()
      if (!current.enabled || current.dirs.length === 0) return null
      const candidates = await files(current.dirs)
      if (candidates.length === 0) return null
      for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
        const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length))
        const frame = await readFrame(candidates[index])
        if (frame !== null) return frame
      }
      return null
    },
  }
}

async function readConfig(path: string): Promise<MemeConfig> {
  const fallback: MemeConfig = {
    ...MEME_DEFAULTS,
    dirs: [],
    idle: FRAME_DEFAULTS,
    hover: HOVER_DEFAULTS,
    voice: FRAME_DEFAULTS,
    speak: FRAME_DEFAULTS,
    typing: FRAME_DEFAULTS,
    reply: FRAME_DEFAULTS,
    thinking: FRAME_DEFAULTS,
    tool: FRAME_DEFAULTS,
    click: FRAME_DEFAULTS,
    done: FRAME_DEFAULTS,
    wake: FRAME_DEFAULTS,
    drag: FRAME_DEFAULTS,
    drop: FRAME_DEFAULTS,
    sleep: SLEEP_DEFAULTS,
    skit: SKIT_DEFAULTS,
  }
  let raw: unknown
  try {
    const text = await readFile(path, 'utf8')
    // A Windows editor may leave a UTF-8 BOM, which JSON.parse rejects.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return fallback
  }
  if (typeof raw !== 'object' || raw === null) return fallback
  const record = raw as Record<string, unknown>
  return {
    enabled: record.enabled === true,
    dirs: readDirs(record.dir),
    gapMs: readRange(record.gapMs, MEME_DEFAULTS.gapMs, 1_000, 3_600_000),
    holdMs: readRange(record.holdMs, MEME_DEFAULTS.holdMs, 120, 60_000),
    frames: readRange(record.frames, MEME_DEFAULTS.frames, 1, 20),
    idle: readNamed(record.idle),
    hover: readHover(record.hover),
    voice: readNamed(record.voice),
    speak: readNamed(record.speak),
    typing: readNamed(record.typing),
    reply: readNamed(record.reply),
    thinking: readNamed(record.thinking),
    tool: readNamed(record.tool),
    click: readNamed(record.click),
    done: readNamed(record.done),
    wake: readNamed(record.wake),
    drag: readNamed(record.drag),
    drop: readNamed(record.drop),
    sleep: readSleep(record.sleep),
    skit: readSkit(record.skit),
  }
}

/** The idle skit: one repeated file, a repetition range, and the frame dropped in the middle. */
function readSkit(value: unknown): SkitFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const interject = typeof record.interject === 'string' ? record.interject.trim() : ''
  return {
    ...frame,
    gapMs: readRange(record.gapMs, SKIT_DEFAULTS.gapMs, 5_000, 3_600_000),
    times: readRange(record.times, SKIT_DEFAULTS.times, 1, 12),
    interject: frame.enabled ? interject : '',
  }
}

/** The yawn that opens the nap: a named file plus how many times it plays. */
function readYawn(value: unknown): YawnFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const times = typeof record.times === 'number' && Number.isFinite(record.times)
    ? Math.min(Math.max(Math.round(record.times), 1), 12)
    : YAWN_DEFAULTS.times
  return { ...frame, times }
}

/** The nap timeline: a yawn pre-roll, a file list, and the two idle durations that walk it. */
function readSleep(value: unknown): SleepPlan {
  if (typeof value !== 'object' || value === null) return SLEEP_DEFAULTS
  const record = value as Record<string, unknown>
  const files = Array.isArray(record.files)
    ? record.files.filter((file): file is string => typeof file === 'string' && file.trim() !== '').map((file) => file.trim())
    : []
  return {
    enabled: record.enabled !== false && files.length > 0,
    afterMs: readMs(record.afterMs, SLEEP_DEFAULTS.afterMs, 1_000, 86_400_000),
    stepMs: readMs(record.stepMs, SLEEP_DEFAULTS.stepMs, 1_000, 86_400_000),
    yawn: readYawn(record.yawn),
    files,
  }
}

/** One millisecond duration, clamped to a sane band. */
function readMs(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

/** The peek entry: a named frame plus the optional one-pass intro naming another file. */
function readHover(value: unknown): HoverFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const intro = typeof record.intro === 'string' ? record.intro.trim() : ''
  return { ...frame, intro: frame.enabled ? intro : '' }
}

/** A named frame. Naming a file turns it on unless the entry is explicitly disabled. */
function readNamed(value: unknown): NamedFrame {
  if (typeof value !== 'object' || value === null) return FRAME_DEFAULTS
  const record = value as Record<string, unknown>
  const file = typeof record.file === 'string' ? record.file.trim() : ''
  return { enabled: record.enabled !== false && file !== '', file }
}

/** One folder or a list of them, trimmed, without repeats. */
function readDirs(value: unknown): readonly string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : []
  const dirs: string[] = []
  for (const entry of list) {
    if (typeof entry !== 'string') continue
    const dir = entry.trim()
    if (dir !== '' && !dirs.includes(dir)) dirs.push(dir)
  }
  return dirs
}

/** A `[low, high]` pair, ordered and clamped; anything else keeps the default. */
function readRange(value: unknown, fallback: readonly [number, number], min: number, max: number): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2) return fallback
  const [first, second] = value as readonly unknown[]
  if (typeof first !== 'number' || typeof second !== 'number') return fallback
  if (!Number.isFinite(first) || !Number.isFinite(second)) return fallback
  return [
    Math.min(Math.max(Math.round(Math.min(first, second)), min), max),
    Math.min(Math.max(Math.round(Math.max(first, second)), min), max),
  ]
}

function sameDirs(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((dir, index) => dir === right[index])
}

async function collect(dir: string, depth: number, files: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collect(path, depth + 1, files)
      continue
    }
    if (entry.isFile() && MIME_BY_EXTENSION[extname(entry.name).toLowerCase()] !== undefined) files.push(path)
  }
}

async function readBytes(path: string): Promise<Buffer | null> {
  if (MIME_BY_EXTENSION[extname(path).toLowerCase()] === undefined) return null
  try {
    const body = await readFile(path)
    if (body.length === 0 || body.length > MAX_FRAME_BYTES) return null
    return body
  } catch {
    return null
  }
}

async function readFrame(path: string): Promise<string | null> {
  const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()]
  const body = await readBytes(path)
  if (mime === undefined || body === null) return null
  return `data:${mime};base64,${body.toString('base64')}`
}

/**
 * How long one pass of a GIF takes, from its frame delays (each a 2-byte count of 1/100 s
 * before an image block). Anything unreadable falls back to {@link GIF_FALLBACK_MS}.
 */
export function gifDurationMs(body: Buffer, fallback = GIF_FALLBACK_MS): number {
  if (body.length < 14 || body.toString('latin1', 0, 3) !== 'GIF') return fallback
  const packed = body[10] ?? 0
  let offset = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0)
  let total = 0
  let frames = 0
  while (offset < body.length) {
    const block = body[offset]
    if (block === 0x3b) break
    if (block === 0x21) {
      const label = body[offset + 1]
      if (label === 0xf9 && body[offset + 2] === 0x04) {
        total += ((body[offset + 5] ?? 0) << 8) | (body[offset + 4] ?? 0)
        frames += 1
        offset += 8
        continue
      }
      offset += 2
      offset = skipSubBlocks(body, offset)
      continue
    }
    if (block === 0x2c) {
      const local = body[offset + 9] ?? 0
      offset += 10 + ((local & 0x80) !== 0 ? 3 * 2 ** ((local & 0x07) + 1) : 0)
      offset += 1
      offset = skipSubBlocks(body, offset)
      continue
    }
    // An unknown block means the layout is not what this parser expects.
    return fallback
  }
  if (frames === 0 || total <= 0) return fallback
  return Math.min(Math.max(total * 10, 200), GIF_MAX_MS)
}

/** Walk one data sub-block chain and return the offset after its terminator. */
function skipSubBlocks(body: Buffer, from: number): number {
  let offset = from
  while (offset < body.length) {
    const size = body[offset] ?? 0
    offset += 1
    if (size === 0) return offset
    offset += size
  }
  return offset
}
