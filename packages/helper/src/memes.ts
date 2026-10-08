/**
 * Meme frames for the ball, read from `memes.json` and the pack folders it points at.
 *
 * This is the half that *resolves files*: a slot name in, a `data:` URL (and how long it is) out. Which slot
 * is wanted, and when, is the page's business — `shell.js` decides that, and its file header carries the
 * full trigger table in one place, including the order the conditions are tested in and therefore which one
 * wins when two are true at once. Read that table first; this file only says what each slot may name.
 *
 * The random bursts described by {@link MemeSchedule} are the one part of this file that is not a named
 * slot: they draw at random from every image in `dir`, which is why the top-level `enabled` in the config
 * switches *them* rather than the whole cosmetic layer.
 */

import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'

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
/**
 * Where each per-name tool lookup is recorded, in the orb's runtime folder.
 *
 * The page cannot be inspected from outside the app, and "the pack has no face for this tool" is
 * indistinguishable from "the page never asked" — both leave the ball on the shared face. One line per call is
 * cheap enough to leave on, and it is the only way to tell those two apart from here.
 */
const TOOL_LOG = 'tools.log'
/** Lines kept before the log is started over, so a long session cannot grow it without end. */
const TOOL_LOG_MAX_LINES = 500
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
  /**
   * Bursts are off unless the config file turns them on.
   *
   * The top-level `enabled` in `memes.json`, and *only* the bursts: every named slot — the resting loop, the
   * hover, the click reaction, the turn-end faces — is switched by its own `enabled` and keeps working while
   * this is off. That is worth saying plainly because the name reads like a master switch and is not one,
   * and because this is the switch that plays clips the pack never named: a burst draws at random from every
   * GIF in `dir`, which is how an animation the user never chose ends up on the ball.
   */
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

/**
 * The click reaction: a named frame plus how long the user's own pat is answered for.
 *
 * The default rule cuts a looping clip just before its own restart, which is right for a clip whose
 * animation *is* the message — the pose it ends on is never re-shown. It is wrong for the one clip the user
 * asked for with their own hand: `摸头.gif` is 640 ms, so the cut held it for 544, which reads as a flicker
 * rather than as the ball answering a pat. Saying `"holdMs": 1400` replaces the cut for this slot only.
 */
export interface ClickFrame extends NamedFrame {
  /** How long the face stays up in milliseconds, or `0` for the clip's own length. */
  readonly holdMs: number
}

/** The peek state: the loop plus an optional intro played once when the pointer arrives. */
export interface HoverFrame extends NamedFrame {
  /** A file name played once before {@link file}, or `''` for no intro. */
  readonly intro: string
}

/**
 * The docked arrival: a one-pass entrance plus an optional loop worn while the pointer rests.
 *
 * The opposite direction to {@link HoverFrame}: {@link file} is the entrance, played once the moment
 * the dwell fires, and {@link loop} is the resting face the ball wears for as long as the pointer
 * stays on the strip after that. A pack that names no loop plays the entrance and then goes back to
 * the docked idle — exactly the behaviour before the loop existed.
 *
 * {@link file} is what *both* edges play. The clips are mirrored pictures of each other — the ball is
 * flush against a screen edge and faces into the screen — so a pack can name an {@link left} entrance
 * for the left edge alone, and {@link leftLoop} the loop that goes with it. Naming neither leaves the
 * left edge playing the same clip as the right, which is what every profile written before this did.
 */
export interface DockArriveFrame extends NamedFrame {
  /** A file name looped once the entrance has finished, or `''` for no loop. */
  readonly loop: string
  /** The left edge's own entrance, or `''` to play {@link file} there too. */
  readonly left: string
  /** The left edge's own loop, or `''` to wear {@link loop} there too. */
  readonly leftLoop: string
}

/** What the ball shows while the pointer is on it. */
export interface HoverFrames {
  /** The loop. */
  readonly src: string
  /** The one-pass intro and how long it lasts. */
  readonly intro: { readonly src: string; readonly ms: number } | null
}

/** Which edge of the display the ball is docked to. */
export type DockSide = 'left' | 'right'

/** The docked arrival the strip plays: the entrance, and the loop worn after it finishes. */
export interface DockArriveFrames {
  /** The one-pass entrance and how long it lasts. */
  readonly file: TimedFrame | null
  /** The loop the ball rests on after the entrance, or `null` for none. */
  readonly loop: string | null
}

/**
 * The strip's arrival for one edge: the clip played, and the loop worn after it.
 *
 * The left edge gets its own answer because its picture is the other way round: the ball is drawn
 * flush against the edge and looking into the screen, so a clip drawn for the right edge faces out on
 * the left. Both edges are asked for at once rather than one per dock, and that is deliberate: the
 * hover that needs the answer is the one that can least afford another round trip, and a pack that
 * names no left clip costs one shared entrance in both fields.
 */
export interface DockArriveEdges {
  readonly left: DockArriveFrames | null
  readonly right: DockArriveFrames | null
}

/** No named frame: that state keeps the frozen avatar. */
export const FRAME_DEFAULTS: NamedFrame = { enabled: false, file: '' }

/** No click reaction, and no hold asked for. */
export const CLICK_DEFAULTS: ClickFrame = { ...FRAME_DEFAULTS, holdMs: 0 }

/** No peek: the pointer leaves the avatar alone. */
export const HOVER_DEFAULTS: HoverFrame = { ...FRAME_DEFAULTS, intro: '' }

/** No docked arrival: the strip plays nothing on a hover. */
export const DOCK_ARRIVE_DEFAULTS: DockArriveFrame = { ...FRAME_DEFAULTS, loop: '', left: '', leftLoop: '' }

/**
 * The carry state: the loop worn while the ball is held, plus an optional one-pass
 * intro played the moment it is picked up. Same shape as {@link HoverFrame}, so the
 * pickup reads as a gesture — the lift, then the hang — rather than a state swap.
 */
export interface DragFrame extends NamedFrame {
  /** A file name played once before {@link file}, or `''` for no intro. */
  readonly intro: string
}

/** What the ball shows while it is being carried. */
export interface DragFrames {
  /** The loop worn for as long as the carry lasts. */
  readonly src: string
  /** The one-pass pickup and how long it lasts. */
  readonly intro: { readonly src: string; readonly ms: number } | null
}

/** No carry: picking the ball up leaves the avatar alone. */
export const DRAG_DEFAULTS: DragFrame = { ...FRAME_DEFAULTS, intro: '' }

/**
 * The arrival: the greeting the ball turns up with, as the clips it plays in order.
 *
 * A list rather than one file, because turning up is not always one clip: the ball can arrive and
 * then wave, and the pack says so by naming both. Every entry is played once, in order, each for one
 * pass of its own animation. An empty list is the silent startup a profile written before this slot
 * existed keeps.
 */
export interface ArrivePlan {
  readonly enabled: boolean
  /** Files played once each, in order. A name that resolves to nothing is skipped. */
  readonly files: readonly string[]
}

/** No greeting. */
export const ARRIVE_DEFAULTS: ArrivePlan = { enabled: false, files: [] }

/**
 * The poor frame: the face the ball rests in when the account is nearly out of money.
 *
 * It replaces {@link NamedFrame} `idle` rather than sitting beside it, because it is the same state —
 * the ball is not doing anything — seen under a condition. The condition is the balance the host
 * pushes (see `balance()` below): a number, or nothing at all when it could not be read, which keeps
 * the ordinary loop rather than reading a failed lookup as an empty wallet.
 */
export interface PoorPlan extends NamedFrame {
  /** The spendable balance, in CNY, below which this frame is worn instead of `idle`. */
  readonly below: number
}

/** What the ball needs to make that choice: the frame, and the line it is compared against. */
export interface PoorFrame {
  readonly src: string
  readonly below: number
}

/**
 * The line an absent `below` falls back to, in CNY.
 *
 * Five yuan: low enough that the poor face only shows up when the account is genuinely nearly out,
 * which is the whole of what it is for. A pack that wants its own number says so in the slot.
 */
export const POOR_DEFAULTS: PoorPlan = { ...FRAME_DEFAULTS, below: 5 }

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
  /**
   * A hold the pack asked for, in milliseconds, or absent for the clip's own length.
   *
   * Optional rather than zero-filled on purpose: absent is what every frame meant before a pack could ask for
   * a hold, so a pack that never sets one travels exactly as it always did.
   */
  readonly holdMs?: number
}

/**
 * One item of a skit's pool: either a single clip, or a scripted run of clips played once each.
 *
 * A sequence is a *group* rather than a longer pool: the pack that draws "简单模式 then 困难模式" means
 * both, in that order, once — a joke with a setup and a punchline, not the same clip four times. It is
 * therefore finished when its last clip is, and none of the single clip's machinery (the repeats, the
 * interjection) applies to it.
 */
export type SkitItem =
  | { readonly kind: 'single'; readonly frame: TimedFrame }
  | { readonly kind: 'sequence'; readonly frames: readonly TimedFrame[] }

/**
 * A short scripted idle skit: what the ball plays when it is left alone.
 *
 * An item of the pool is drawn per skit, and what happens next depends on which kind it is: a single
 * clip repeats a few times with an interjection dropped in the middle, a sequence plays its clips once
 * each and stops. Which item is drawn is the page's to decide — see {@link SkitPlan} below.
 */
export interface SkitPlan {
  /** Idle time between skits, milliseconds. */
  readonly gapMs: readonly [number, number]
  /**
   * The pool a skit is drawn from, as the items that actually resolve.
   *
   * A list the way {@link ArrivePlan} is one, and for the same reason: a pack that names three gags
   * means all three, so the slot names a pool and the page picks from it — the helper cannot, because
   * it hands the plan over once and the page then plays a skit every few minutes, and because only
   * the page knows which item it played last.
   */
  readonly files: readonly SkitItem[]
  /** One item to play now, kept so a page written before `files` existed plays one. */
  readonly item: SkitItem
  readonly times: readonly [number, number]
  /** For a single clip, one extra frame played in the middle of the repeats, or `null`. */
  readonly interject: TimedFrame | null
}

/** One item of a skit as the config spells it: a file name, or a run of file names played in order. */
type SkitEntry = string | readonly string[]

/** One named file of a skit, plus the cadence and everything a draw needs. */
interface SkitFrame extends NamedFrame {
  readonly gapMs: readonly [number, number]
  readonly times: readonly [number, number]
  /** Pool items the skit is drawn from, in config order. Each is one clip or one scripted run. */
  readonly files: readonly SkitEntry[]
  /** One frame played in the middle of a single clip's repeats, or `''`. */
  readonly interject: string
  /** Interjection candidates; one is chosen per skit. Empty keeps {@link interject} alone. */
  readonly interjects: readonly string[]
}

/** No skit. */
export const SKIT_DEFAULTS: SkitFrame = {
  enabled: false,
  file: '',
  gapMs: [120_000, 300_000],
  times: [3, 5],
  files: [],
  interject: '',
  interjects: [],
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
  /**
   * The face for one named tool, or `null` when the pack draws that call the same as every other.
   *
   * The name is the one in the transcript's tool card, which is also what the page passes back: it is the
   * only thing either side knows a call by. `null` is the ordinary answer — a pack that lists three tools
   * wants the other twenty to keep sharing {@link tool} — and the page reads it as "wear the shared face".
   */
  toolNamed(name: string): Promise<string | null>
  /** The click reaction, played once with the length of its own animation. */
  click(): Promise<TimedFrame | null>
  /**
   * The arrival, played once as the page opens: the greeting the ball turns up with, in order.
   *
   * One-shots like the click reaction rather than loops like {@link idle}, because each says
   * something true exactly once — the ball has just appeared, and then says hello. The helper starts
   * the ball's page when the orb is switched on, so this is the sequence a DSH launch opens with as
   * well as every later enable, and a profile that names no file keeps the old silent startup.
   */
  arrive(): Promise<readonly TimedFrame[] | null>
  /**
   * The docked arrival: the clip the strip plays when the pointer rests on it, once — per edge.
   *
   * A slot of its own rather than a reuse of {@link arrive}, which is the greeting the ball turns up
   * with as the page opens. The two are different events — one is the ball announcing itself, this
   * one is a hand coming to rest on the strip the docked ball left behind — and they play on
   * different surfaces: this clip is worn by the strip, while the ball stays hidden for the whole of
   * it. A pack that draws both has already said so by naming both.
   *
   * Both edges answer together, and the left one falls back to the right's clip when the pack names
   * none for it: see {@link DockArriveEdges}. A pack that names no clip at all answers `null`.
   */
  dockArrive(): Promise<DockArriveEdges | null>
  /**
   * The resting face for a nearly empty account: the frame, and the balance line to compare with.
   *
   * A loop like {@link idle}, because it *is* the resting loop under a condition rather than a cue of
   * its own. The page asks the host for the account's spendable balance and picks between the two
   * every time it repaints, so a balance that falls below the line changes the face the ball is
   * already wearing.
   */
  poor(): Promise<PoorFrame | null>
  /** The finished-task frame, played once with the length of its own animation. */
  done(): Promise<TimedFrame | null>
  /** A `data:` URL the ball shows once, when a session closes before its turn finished. */
  interrupted(): Promise<TimedFrame | null>
  /** A `data:` URL the ball shows once, when the agent is waiting on a tool approval. */
  approval(): Promise<TimedFrame | null>
  /** A `data:` URL the ball shows once, when a turn stopped at the output limit. */
  maxtokens(): Promise<TimedFrame | null>
  /** A `data:` URL the ball shows once, when the user has just sent it a message. */
  nod(): Promise<TimedFrame | null>
  /**
   * The failure face: played once when a run ends because it failed.
   *
   * A one-shot like {@link done}, and the *other* half of the same edge: a turn that ran to its own end
   * rings the bell, a turn that threw wears this instead. The two never both play, because they are the
   * same event read two ways — which is also why the page stops ringing the bell when this face is
   * configured. It replaces {@link done} rather than sitting beside it.
   */
  fail(): Promise<TimedFrame | null>
  /**
   * The question face: played once the moment the agent stops the turn to ask something.
   *
   * A one-shot like {@link done} rather than a loop like {@link tool}, because what it marks is a
   * moment — the agent has asked and is waiting on an answer — and not a state the ball stays in for
   * as long as some condition holds. It is a slot of its own rather than a reuse of {@link wake}
   * because the two are different events: an exclamation mark answers the user's own voice, a
   * question mark is the agent asking one, and a pack that draws both has already said so.
   */
  ask(): Promise<TimedFrame | null>
  /** The wake-word frame, played once as soon as the keyword fires. */
  wake(): Promise<TimedFrame | null>
  /** The carry: the hang loop plus the one-pass pickup, or `null` while it is off. */
  drag(): Promise<DragFrames | null>
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
  /**
   * One face per tool name, for the tools a pack wants to draw apart from the rest.
   *
   * `tool` is what every call wears; this is what a named call wears instead. Keys are the tool names the
   * transcript uses — `pwsh`, `edit`, `read` — read straight out of the tool cards, so the mapping is config
   * rather than code: renaming a tool is a line in `memes.json`, not a release. A name that is not listed
   * falls back to `tool`, which is what every call did before this existed.
   */
  readonly tools: Readonly<Record<string, NamedFrame>>
  readonly click: ClickFrame
  readonly arrive: ArrivePlan
  /** The docked arrival: what the strip plays when the pointer rests on it. */
  readonly dockArrive: DockArriveFrame
  readonly poor: PoorPlan
  readonly done: NamedFrame
  /** The acknowledgement: what the ball wears the moment the user hands the agent something to do. */
  readonly nod: NamedFrame
  /** The failure face: what the ball wears when a run ends because it failed. */
  readonly fail: NamedFrame
  /** The cut-short face: the session closed before the turn finished. Rare, and worth its own picture. */
  readonly interrupted: NamedFrame
  /** The waiting-for-you face: the agent is parked on a tool approval it cannot give itself. */
  readonly approval: NamedFrame
  /** The ran-out-of-room face: the turn stopped because it hit the model's output limit. */
  readonly maxtokens: NamedFrame
  /** The question face: what the ball wears when the agent asks the user something. */
  readonly ask: NamedFrame
  readonly wake: NamedFrame
  readonly drag: DragFrame
  readonly drop: NamedFrame
  readonly sleep: SleepPlan
  readonly skit: SkitFrame
}

/**
 * Read the config from `configPath` on demand:
 * `{ "enabled": true, "dir": "D:/packs/fish", "gapMs": [20000, 60000], "holdMs": [600, 1000],
 *    "frames": [3, 6], "idle": { "file": "idle.gif" }, "poor": { "below": 60, "file": "broke.gif" },
 *    "hover": { "file": "peek.gif", "intro": "in.gif" },
 *    "typing": { "file": "typing.gif" }, "reply": { "file": "answer.gif" },
 *    "voice": { "file": "nod.gif" }, "speak": { "file": "talk.gif" },
 *    "thinking": { "file": "reasoning.gif" }, "tool": { "file": "tool.gif" },
 *    "click": { "file": "pat.gif" }, "arrive": { "files": ["hello.gif", "wave.gif"] },
 *    "dockArrive": { "file": "arrive-flip.gif", "loop": "arrive-loop.gif",
 *                    "left": "arrive.gif", "leftLoop": "arrive-left-loop.gif" },
 *    "done": { "file": "bell.gif" }, "fail": { "file": "cry.gif" }, "wake": { "file": "bang.gif" },
 *    "ask": { "file": "question.gif" },
 *    "drag": { "file": "hang.gif", "intro": "lift.gif" }, "drop": { "file": "land.gif" },
 *    "sleep": { "afterMs": 300000, "stepMs": 300000, "yawn": { "file": "yawn.gif", "times": 2 },
 *               "files": ["nap1.gif", "nap2.gif"] },
 *    "skit": { "gapMs": [120000, 300000], "files": ["skit.gif", "dance.gif"], "times": [3, 5],
 *              "interject": "mid.gif" } }`
 * `dir` takes one folder or a list. `random` is injectable so tests stay deterministic.
 *
 * A slot whose value is a list of files (`arrive.files`, and `skit.files` with its `interjects`)
 * keeps every name that resolves: a pack that lost one clip loses that clip and nothing else.
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

  /** A named file as a `data:` URL plus one pass of its own animation, and the hold a pack asked for. */
  async function timedFrame(file: string, dirs: readonly string[], holdMs = 0): Promise<TimedFrame | null> {
    const path = await locate({ enabled: true, file }, dirs)
    const body = path === null ? null : await readBytes(path)
    if (path === null || body === null) return null
    const mime = MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'image/gif'
    // The hold rides along only when the pack asked for one: `0` is "the clip's own length", which is what
    // every frame means when the field is absent. Nothing else changes shape, so a pack that never sets
    // `holdMs` travels exactly as it always did.
    return {
      src: `data:${mime};base64,${body.toString('base64')}`,
      ms: gifDurationMs(body),
      ...(holdMs > 0 ? { holdMs } : {}),
    }
  }

  /**
   * The skit items that actually resolve: the pool, plus the interjections a single clip may use.
   *
   * The pool comes back whole, because the page is the half that rotates it: it plays a skit every few
   * minutes and is the only one that knows which item it played last, so a pool it cannot see is a
   * rotation it cannot run. The interjections are resolved here too (they cost a read each, and a
   * scripted run never uses one) but they travel as a pool the page draws from per skit — the run of
   * "maybe an interruption" is the page's decision and has to be made when the skit plays, not once
   * when the page loads. Read fresh on every {@link MemePicker.skit} rather than remembered: that call
   * happens once per page, so a cache would buy nothing and would pin the old pool for the life of the
   * page after somebody edited the config. The clip lengths come with the frames because they are what
   * the page schedules with.
   */
  async function skitPools(current: MemeConfig): Promise<{
    readonly items: readonly SkitItem[]
    readonly interjects: readonly TimedFrame[]
  }> {
    // The old single file leads: a page that only understands a single clip (or a config written
    // before this slot took a list) then plays exactly what it played before.
    const pool: readonly SkitEntry[] = current.skit.files.length === 0 ? [current.skit.file] : current.skit.files
    const items: SkitItem[] = []
    for (const entry of pool) {
      if (typeof entry === 'string') {
        const frame = await timedFrame(entry, current.dirs)
        if (frame !== null) items.push({ kind: 'single', frame })
        continue
      }
      // A run: every clip that resolves is played, in config order. One that is gone costs only itself
      // — the same reading as `arrive.files` — and a run left with nothing in it is not an item.
      const frames: TimedFrame[] = []
      for (const file of entry) {
        const frame = await timedFrame(file, current.dirs)
        if (frame !== null) frames.push(frame)
      }
      if (frames.length > 0) items.push({ kind: 'sequence', frames })
    }
    // The interjections: the singular name first, then the slot's own list, deduplicated. The singular
    // name is added rather than replaced, so a slot that grew an `interjects` list never drops the
    // interjection it already had, and one written before the list existed keeps working unchanged.
    const candidates: string[] = []
    for (const file of [current.skit.interject, ...current.skit.interjects]) {
      if (file !== '' && !candidates.includes(file)) candidates.push(file)
    }
    const interjects: TimedFrame[] = []
    for (const file of candidates) {
      const frame = await timedFrame(file, current.dirs)
      if (frame !== null) interjects.push(frame)
    }
    return { items, interjects }
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
    async toolNamed(name) {
      const current = await loadConfig()
      const frame = current.tools[name]
      // Not `named(current.tool)` as a fallback: the answer for an unlisted tool is "nothing special", and the
      // page already has the shared face in hand. Reading the shared file again here would send the same bytes
      // over IPC and make a listed tool indistinguishable from an unlisted one to a caller that only sees a URL.
      // Page-side diagnostics cannot be read from outside the app, and a lookup that answers "nothing special"
      // looks exactly like one that never happened — which is the question this answers. Always on, bounded by
      // the fact that it is one line per tool call, and truncated so a long session cannot grow it without end.
      noteToolLookup(configPath, name, frame !== undefined)
      return frame === undefined ? null : named(frame, current.dirs)
    },
    async click() {
      const current = await loadConfig()
      if (!current.click.enabled) return null
      return timedFrame(current.click.file, current.dirs, current.click.holdMs)
    },
    async arrive() {
      const current = await loadConfig()
      if (!current.arrive.enabled) return null
      // In order, and one unreadable name does not cost the rest of the greeting: a pack that lost
      // the wave file still arrives.
      const frames: TimedFrame[] = []
      for (const file of current.arrive.files) {
        const frame = await timedFrame(file, current.dirs)
        if (frame !== null) frames.push(frame)
      }
      return frames.length === 0 ? null : frames
    },
    /**
     * The docked arrival.
     *
     * Nothing here is special-cased for a missing file, which is the whole of the fallback: a slot
     * that names nothing, names a file that is not on disk, or is missing from a profile written
     * before the slot existed all answer `null`, and the page then plays nothing on a hover. The
     * strip keeps its drag out of the dock either way — that path never touches this.
     *
     * The entrance is a {@link TimedFrame} because it plays once; the loop is a plain `src` because it
     * runs until the pointer leaves. A slot that names no loop still answers for the entrance alone,
     * so the page plays it and then drops back to the docked idle, exactly as it did before.
     */
    async dockArrive() {
      const current = await loadConfig()
      if (!current.dockArrive.enabled) return null
      const file = await timedFrame(current.dockArrive.file, current.dirs)
      if (file === null) return null
      // The shared loop, when the pack names one. Resolved before either edge so both can refer to it.
      const loop = current.dockArrive.loop === ''
        ? null
        : await named({ enabled: true, file: current.dockArrive.loop }, current.dirs)
      const right: DockArriveFrames = { file, loop }
      // The left edge's own picture, when the pack names one. A left clip that is named but cannot be
      // read falls back to the shared one rather than taking the strip's greeting away: the clip is a
      // gift, and a missing file is not a reason for the strip to stop answering.
      if (current.dockArrive.left === '') return { left: right, right }
      const leftFile = await timedFrame(current.dockArrive.left, current.dirs)
      if (leftFile === null) return { left: right, right }
      const leftLoopName = current.dockArrive.leftLoop === '' ? current.dockArrive.loop : current.dockArrive.leftLoop
      const leftLoop = leftLoopName === ''
        ? null
        : await named({ enabled: true, file: leftLoopName }, current.dirs)
      return { left: { file: leftFile, loop: leftLoop }, right }
    },
    async poor() {
      const current = await loadConfig()
      if (!current.poor.enabled) return null
      const src = await named(current.poor, current.dirs)
      return src === null ? null : { src, below: current.poor.below }
    },
    async done() {
      const current = await loadConfig()
      if (!current.done.enabled) return null
      return timedFrame(current.done.file, current.dirs)
    },
    /**
     * The failure face.
     *
     * A pack that names no file answers `null` and the ball shows nothing new on a failed run — the
     * shipped default is off, because the file this face wants lives in somebody's meme pack and not
     * in this package. A name that does not resolve behaves the same way, which is the fail-safe the
     * whole slot mechanism already has.
     */
    async nod() {
      const current = await loadConfig()
      if (!current.nod.enabled) return null
      return timedFrame(current.nod.file, current.dirs)
    },
    /** The cut-short face, or `null` while it is off or unreadable. */
    async interrupted() {
      const current = await loadConfig()
      if (!current.interrupted.enabled) return null
      return timedFrame(current.interrupted.file, current.dirs)
    },
    /** The waiting-for-approval face, or `null` while it is off or unreadable. */
    async approval() {
      const current = await loadConfig()
      if (!current.approval.enabled) return null
      return timedFrame(current.approval.file, current.dirs)
    },
    /** The out-of-room face, or `null` while it is off or unreadable. */
    async maxtokens() {
      const current = await loadConfig()
      if (!current.maxtokens.enabled) return null
      return timedFrame(current.maxtokens.file, current.dirs)
    },
    async fail() {
      const current = await loadConfig()
      if (!current.fail.enabled) return null
      return timedFrame(current.fail.file, current.dirs)
    },
    /**
     * The question face.
     *
     * Nothing here is special-cased for a missing file: `timedFrame` resolves the name through the
     * pack, so an unreadable or absent question GIF answers `null` and the ball simply keeps the
     * face it had. A pack that never names the slot is the same answer, which is what makes this
     * one more named frame rather than a feature that can fail.
     */
    async ask() {
      const current = await loadConfig()
      if (!current.ask.enabled) return null
      return timedFrame(current.ask.file, current.dirs)
    },
    async wake() {
      const current = await loadConfig()
      if (!current.wake.enabled) return null
      return timedFrame(current.wake.file, current.dirs)
    },
    async drag() {
      const current = await loadConfig()
      const src = await named(current.drag, current.dirs)
      if (src === null) return null
      if (current.drag.intro === '') return { src, intro: null }
      return { src, intro: await timedFrame(current.drag.intro, current.dirs) }
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
    /**
     * The idle skit: the pool of items it is drawn from, one of them played, and the mid-clip frame.
     *
     * The whole pool travels with the drawn item, because the rotation is the page's: only the page
     * knows when a skit actually played, and therefore which item it must not repeat. One interjection
     * is drawn here — it is the helper's own random and the page only ever needs one of them — and an
     * interjection that *is* the clip it interrupts is dropped rather than handed over, so a single
     * clip is never played twice in a row. The rest is deliberately forgiving: a pool whose files are
     * all gone, or a config that names none, answers `null` and the ball simply keeps resting.
     */
    async skit() {
      const current = await loadConfig()
      if (!current.skit.enabled) return null
      const pools = await skitPools(current)
      const item = pickFrom(pools.items, random)
      if (item === null) return null
      // A scripted run is finished by its own last clip, so nothing is drawn to break it up: the
      // interjection belongs to the repeated single clip it interrupts and would only lengthen a run
      // that already has a beginning and an end.
      const interject = item.kind === 'single' ? pickFrom(pools.interjects, random) : null
      const lead = item.kind === 'single' ? item.frame : item.frames[0] as TimedFrame
      return {
        gapMs: current.skit.gapMs,
        files: pools.items,
        item,
        times: current.skit.times,
        // An interjection that is the clip being repeated would play that clip twice in a row, so it
        // is dropped rather than handed to a page that would have to notice.
        interject: interject !== null && interject.src === lead.src ? null : interject,
      }
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
    tools: {},
    click: CLICK_DEFAULTS,
    arrive: ARRIVE_DEFAULTS,
    dockArrive: DOCK_ARRIVE_DEFAULTS,
    poor: POOR_DEFAULTS,
    done: FRAME_DEFAULTS,
    nod: FRAME_DEFAULTS,
    interrupted: FRAME_DEFAULTS,
    approval: FRAME_DEFAULTS,
    maxtokens: FRAME_DEFAULTS,
    fail: FRAME_DEFAULTS,
    ask: FRAME_DEFAULTS,
    wake: FRAME_DEFAULTS,
    drag: DRAG_DEFAULTS,
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
    // Inside the slot it belongs to, not beside it: `tool` names the shared face and its `tools` names the
    // per-name ones, and reading the mapping from *next to* `tool` — which is what this did at first — made
    // every tool fall back to the shared face while the config looked perfectly correct. The sibling form is
    // still accepted because it costs one `??`, and a key in the wrong place should not be a silent failure.
    tools: readToolFaces(readToolFacesValue(record)),
    click: readClick(record.click),
    arrive: readArrive(record.arrive),
    dockArrive: readDockArrive(record.dockArrive),
    poor: readPoor(record.poor),
    done: readNamed(record.done),
    nod: readNamed(record.nod),
    interrupted: readNamed(record.interrupted),
    approval: readNamed(record.approval),
    maxtokens: readNamed(record.maxtokens),
    fail: readNamed(record.fail),
    ask: readNamed(record.ask),
    wake: readNamed(record.wake),
    drag: readDrag(record.drag),
    drop: readNamed(record.drop),
    sleep: readSleep(record.sleep),
    skit: readSkit(record.skit),
  }
}

/**
 * The idle skit: the items it is drawn from, a repetition range, and the frame dropped in the middle.
 *
 * `file` and `interject` are read exactly as they always were — a config that names one of each is
 * untouched by this slot having grown a list — and `files` / `interjects` are the same slot naming
 * several. A list is added to the singular name rather than replacing it, so a pack may spell the
 * same slot both ways and still get every clip it named: `file` is the whole pool when no list is
 * given, and the first of the pool when one is.
 *
 * An item of `files` is a name or a run of names, which is how a slot spells "these two, in this
 * order, once" beside the single clips it can also draw:
 *
 * `"files": ["饮料.gif", ["简单.gif", "困难.gif"], "跳舞.gif"]`
 */
function readSkit(value: unknown): SkitFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const files = readSkitEntries(record.files)
  const interjects = readNames(record.interjects)
  const interject = typeof record.interject === 'string' ? record.interject.trim() : ''
  // A slot that names a list turns itself on the way one that names a file does — the whole slot is
  // off only when it names nothing, or says so. `readNamed` cannot see the lists, so it is asked here.
  const enabled = record.enabled !== false && (frame.file !== '' || files.length > 0 || interjects.length > 0)
  return {
    enabled,
    // The lead of the pool: a slot that names one file is a pool of one, and the picker and the page
    // then both have a pool to draw from.
    file: files.length === 0 ? frame.file : readSkitLead(files),
    gapMs: readRange(record.gapMs, SKIT_DEFAULTS.gapMs, 5_000, 3_600_000),
    times: readRange(record.times, SKIT_DEFAULTS.times, 1, 12),
    files: enabled ? files : [],
    interject: enabled ? interject : '',
    interjects: enabled ? interjects : [],
  }
}

/** The pool of a skit, in config order. An entry that names nothing is dropped rather than kept empty. */
function readSkitEntries(value: unknown): readonly SkitEntry[] {
  if (!Array.isArray(value)) return []
  const entries: SkitEntry[] = []
  for (const entry of value) {
    if (typeof entry === 'string') {
      const file = entry.trim()
      if (file !== '') entries.push(file)
      continue
    }
    // A run of clips, played once each in the order written.
    const run = readNames(entry)
    if (run.length > 0) entries.push(run)
  }
  return entries
}

/** The first file name of a pool, whichever spelling its first item uses. */
function readSkitLead(entries: readonly SkitEntry[]): string {
  const first = entries[0]
  if (first === undefined) return ''
  return typeof first === 'string' ? first : first[0] as string
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
  const files = readNames(record.files)
  return {
    enabled: record.enabled !== false && files.length > 0,
    afterMs: readMs(record.afterMs, SLEEP_DEFAULTS.afterMs, 1_000, 86_400_000),
    stepMs: readMs(record.stepMs, SLEEP_DEFAULTS.stepMs, 1_000, 86_400_000),
    yawn: readYawn(record.yawn),
    files,
  }
}

/** The arrival: the files named, in order. A slot that names none is off. */
function readArrive(value: unknown): ArrivePlan {
  if (typeof value !== 'object' || value === null) return ARRIVE_DEFAULTS
  const record = value as Record<string, unknown>
  const files = readNames(record.files)
  return { enabled: record.enabled !== false && files.length > 0, files }
}

/** A list of file names, trimmed, without the entries that are blank or not strings at all. */
function readNames(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((file): file is string => typeof file === 'string' && file.trim() !== '').map((file) => file.trim())
    : []
}

/**
 * The poor frame: a named file plus the balance that turns it on.
 *
 * An absent line takes the default, so a pack that names the file and forgets the amount still does
 * something sensible. A line that is *there* but unusable — negative, `NaN`, a string — becomes zero
 * instead, which no balance can be below: a broken amount must not be what turns a face on.
 */
function readPoor(value: unknown): PoorPlan {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const raw = record.below
  const below = raw === undefined || raw === null
    ? POOR_DEFAULTS.below
    : typeof raw === 'number' && Number.isFinite(raw) && raw >= 0
      ? Math.round(raw * 100) / 100
      : 0
  return { ...frame, below }
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

/** The carry entry: a named frame plus the optional one-pass pickup naming another file. */
function readDrag(value: unknown): DragFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const intro = typeof record.intro === 'string' ? record.intro.trim() : ''
  return { ...frame, intro: frame.enabled ? intro : '' }
}

/** The docked arrival: a named entrance plus the optional loop worn after it finishes, per edge. */
function readDockArrive(value: unknown): DockArriveFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const text = (key: string): string => (typeof record[key] === 'string' ? (record[key] as string).trim() : '')
  const loop = text('loop')
  const left = text('left')
  const leftLoop = text('leftLoop')
  // A disabled slot has no clips at all, so none of the three names survives it.
  if (!frame.enabled) return { ...frame, loop: '', left: '', leftLoop: '' }
  return { ...frame, loop, left, leftLoop }
}

/** A named frame. Naming a file turns it on unless the entry is explicitly disabled. */
function readNamed(value: unknown): NamedFrame {
  if (typeof value !== 'object' || value === null) return FRAME_DEFAULTS
  const record = value as Record<string, unknown>
  const file = typeof record.file === 'string' ? record.file.trim() : ''
  return { enabled: record.enabled !== false && file !== '', file }
}

/** Where the per-tool mapping lives, accepting both the slot-nested and the flat spelling. */
function readToolFacesValue(record: Record<string, unknown>): unknown {
  const tool = record.tool
  if (typeof tool === 'object' && tool !== null && !Array.isArray(tool)) {
    const nested = (tool as Record<string, unknown>).tools
    if (nested !== undefined) return nested
  }
  return record.tools
}

/**
 * Record one per-name tool lookup, and whether the pack had a face for it.
 *
 * Written beside the config it was decided from — the orb's own runtime folder, and the one place both halves
 * already agree on. It answers the question the page cannot answer for itself: whether the ball asked about a
 * tool's own face at all. A lookup that finds the pack listed nothing for a name and a lookup that never
 * happened both leave the shared face on screen, so without this the difference is invisible exactly when it
 * matters. Bounded, because this is one line per tool call rather than per token.
 */
function noteToolLookup(configPath: string, name: string, listed: boolean): void {
  try {
    const path = join(dirname(configPath), TOOL_LOG)
    const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean) : []
    const kept = existing.length >= TOOL_LOG_MAX_LINES ? existing.slice(-(TOOL_LOG_MAX_LINES - 1)) : existing
    kept.push(`${new Date().toISOString()} asked=${JSON.stringify(name)} own-face=${listed}`)
    writeFileSync(path, `${kept.join('\n')}\n`)
  } catch {
    // A readout that cannot be written is not a reason to change what the ball wears.
  }
}

/** One face per tool name, for the tools the pack draws apart from the rest. */
function readToolFaces(value: unknown): Readonly<Record<string, NamedFrame>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const faces: Record<string, NamedFrame> = {}

  for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
    const tool = name.trim()
    if (tool === '') continue
    // Each entry is either a bare file name — the common case, and the one that reads best in a config — or a
    // `{ "file": … }` object, which is what every other slot looks like and what a pack will reach for. Both
    // are accepted rather than one, because the difference is a brace and the mistake would be silent.
    const frame = readNamed(typeof entry === 'string' ? { file: entry } : entry)
    if (frame.enabled) faces[tool] = frame
  }
  return faces
}

/** {@link readNamed} for the click reaction, which also carries the hold the pack asked for. */
function readClick(value: unknown): ClickFrame {
  const frame = readNamed(value)
  const record = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  // Read only when it is a positive number: a typo, or a negative, is not a reason to hold a face for no time
  // at all, and the clip's own cut-before-its-loop-point length is the answer there.
  const hold = typeof record.holdMs === 'number' && Number.isFinite(record.holdMs) && record.holdMs > 0
    ? Math.min(Math.round(record.holdMs), 60_000)
    : 0
  return { ...frame, holdMs: hold }
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

/**
 * One of `list`, drawn with `random`, or `null` for an empty one.
 *
 * The index is clamped rather than trusted: `random` is injectable, and a test (or a caller) that
 * hands back 1 has to get the last entry instead of `undefined`.
 */
function pickFrom<T>(list: readonly T[], random: () => number): T | null {
  if (list.length === 0) return null
  const index = Math.min(list.length - 1, Math.floor(random() * list.length))
  return list[index] as T
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
