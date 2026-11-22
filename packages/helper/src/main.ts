/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAvatarChoice, type AvatarChoice } from './avatar.ts'
import { collectChromeWindowIds, type NativeHandleWindow } from './chrome-windows.ts'
import { FloatingPlacement, initialBallOrigin, initialWindowBounds } from './geometry.ts'
import { createMemePicker, type MemePicker } from './memes.ts'
import { contextMenuTemplate, type SpeechVoiceOption, type WakeEngineOption, type WakeKeywordOption } from './menu.ts'
import { attachOverlays, denyWindowPermissions } from './overlays.ts'
import { type MenuCatalog, type MenuSelection } from './model-menu.ts'
import {
  keywordFile,
  readWakeConfig,
  registerWakeScheme,
  serveWakeAssets,
  wakeAvailable,
  WAKE_SCHEME,
  type DictationConfig,
  type WakeConfig,
} from './wake.ts'
import { ENGINE_KEYWORDS, WAKE_ENGINES, type WakeEngineId } from './wake-engines.ts'
import { spokenName } from './wake-names.ts'
import { SherpaKws } from './wake-sherpa.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''
const webPort = process.env.DSH_ORB_WEB_PORT ?? ''
/**
 * The helper's own asset folder.
 *
 * `main.js` runs from `lib/`, so this resolves to the sibling `assets/` in the workspace and to
 * `dist/helper/assets/` in an installed package 鈥?the same base `loadFile` below uses. The spoken
 * wake clips live in `assets/voices` and are served from here, not from the host's model folder.
 */
const assetsRoot = fileURLToPath(new URL('../assets', import.meta.url))

/**
 * Wake-word settings the host seeded at launch.
 *
 * Reassigned, not mutated in place: the host publishes the dictation block on every `chrome`
 * message, because the settings page's silence slider can move it while the ball is up, and a value
 * read only at launch would need a relaunch that drops the panel.
 */
let wake: WakeConfig = readWakeConfig()

// The ball's page loads its ONNX models and the wasm runtime over a private scheme.
// Privileges have to be declared before the app is ready.
registerWakeScheme()

// The wake confirmation is a media element now, and Chromium refuses to start one with sound until
// the page has seen a user gesture. A profile that resumes listening at launch has seen none 鈥?the
// wake word itself is not a gesture 鈥?so the helper opts its own window out of that gate. Every
// sound this process makes is one the user asked the ball to make, and the switch is process-wide,
// which is the same page the reply reader plays in.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

/** Theme preference as stored by the official ui-theme settings section. */
type ThemeSource = 'light' | 'dark' | 'system'

interface Appearance {
  theme?: ThemeSource
  locale?: string
}

interface ChromeState {
  overlay: MenuSelection
  background: MenuSelection
  millifractionEnabled: boolean
  reply: ReplySettings
  wakeEnabled: boolean
  /**
   * The recorder's tuning, when the message carried one.
   *
   * `undefined` means the host is older than this field or the message was malformed, and the launch
   * value has to stand 鈥?as opposed to an empty object, which would reset the pause to something the
   * user never chose.
   */
  dictation?: DictationConfig
  openMain: boolean
  catalog: MenuCatalog
  speech: SpeechSettings
  chime: ChimeSettings
}

/**
 * Hourly-chime settings pushed in every `chrome` message.
 *
 * The file behind them is `orb-chime.json` on the host; the menu flips `enabled`, and the quiet
 * window is a hand edit. The defaults here must match `CHIME_DEFAULTS` in `assets/chime.js` and
 * `CHIME_DEFAULTS` in the host's `preferences.ts`: the page starts on those before the first
 * message lands, and a mismatch would chime once where the profile said silence.
 */
interface ChimeSettings {
  enabled: boolean
  quietFrom: number
  quietTo: number
}

/**
 * Terse-reply switch mirrored from the profile, plus the cap it enforces.
 *
 * The host owns the file (`orb-reply.json`); the helper only draws the row and names the cap, so a
 * missing field means "keep what the last `chrome` message said" rather than an invented number.
 */
interface ReplySettings {
  enabled: boolean
  maxReplyChars: number
}

/**
 * Read-aloud settings owned by the settings page and pushed in every `chrome` message.
 *
 * The defaults are off: a profile that has never opened the settings page has no TTS service
 * behind it, and a play button that always fails is worse than no button. The endpoint travels
 * with the switch so moving the service to another port needs no rebuild.
 *
 * `voice` rides along for the same reason: the service routes on it per request, so the menu can
 * change the timbre without restarting anything.
 */
interface SpeechSettings {
  enabled: boolean
  autoPlay: boolean
  endpoint: string
  voice: string
}

/**
 * The voices the menu offers, in the order it offers them.
 *
 * Two families, and the order is deliberate: the hosted pair first because that is what this
 * machine has been reading with, then the Edge voices — one per useful timbre rather than all
 * eight, since a menu is a choice, not an inventory. Every row was synthesised successfully
 * through `/speak` before it was listed.
 */
const SPEECH_VOICES: readonly SpeechVoiceOption[] = [
  { voice: 'stella', zh: 'stella（默认女声）', en: 'stella (default female)' },
  { voice: 'tide', zh: 'tide（低沉男声）', en: 'tide (low male)' },
  { voice: 'zh-CN-XiaoxiaoNeural', zh: '晓晓（温柔女声）', en: 'Xiaoxiao (warm female)' },
  { voice: 'zh-CN-XiaoyiNeural', zh: '晓伊（活泼女声）', en: 'Xiaoyi (bright female)' },
  { voice: 'zh-CN-YunxiNeural', zh: '云希（年轻男声）', en: 'Yunxi (young male)' },
  { voice: 'zh-CN-YunjianNeural', zh: '云健（浑厚男声）', en: 'Yunjian (deep male)' },
  { voice: 'zh-CN-YunyangNeural', zh: '云扬（播报男声）', en: 'Yunyang (anchor male)' },
  { voice: 'zh-CN-liaoning-XiaobeiNeural', zh: '晓北（东北话）', en: 'Xiaobei (Northeastern)' },
]

/**
 * Cloned voices, listed in a file rather than in the table above.
 *
 * A cloned voice is created on a console, never in this repository: its id, its name, and which of
 * them exist all change without this package changing. So the profile keeps the list — one JSON
 * object of `{ "speaker": "S_...", "zh": "...", "en": "..." }` rows at
 * `~/.dsh/profiles/desktop/orb-voices.json` — and the menu is assembled from it on every open. Edit
 * the file and reopen the menu; there is nothing to rebuild.
 *
 * Rows missing an `S_`-style id are dropped rather than offered: a menu entry that reads a voice
 * named `undefined` is worse than the entry not being there.
 */
function clonedVoices(): readonly SpeechVoiceOption[] {
  const path = join(homedir(), '.dsh', 'profiles', 'desktop', 'orb-voices.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No file is the ordinary case: an orb that has never cloned a voice has nothing here.
    return []
  }
  const rows = (parsed as { voices?: unknown }).voices
  if (!Array.isArray(rows)) return []
  const voices: SpeechVoiceOption[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const record = row as { speaker?: unknown, zh?: unknown, en?: unknown }
    const speaker = typeof record.speaker === 'string' ? record.speaker.trim() : ''
    if (!/^(S_|icl_|custom_speaker_id|[A-Za-z0-9_]+_bigtts)/.test(speaker)) continue
    const zh = typeof record.zh === 'string' && record.zh.trim() !== '' ? record.zh.trim() : speaker
    const en = typeof record.en === 'string' && record.en.trim() !== '' ? record.en.trim() : speaker
    // The label is the name the voice was given, verbatim: a cloned voice is a person to whoever
    // speaks with it — "德拉曼" — and a prefix in front of that name reads as a different voice.
    voices.push({ voice: `volc-${speaker}`, zh, en })
  }
  return voices
}

const defaultSelection: MenuSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
}

let chrome: ChromeState = {
  overlay: defaultSelection,
  background: defaultSelection,
  millifractionEnabled: false,
  // Matches `REPLY_DEFAULTS` on the host: a profile with no `orb-reply.json` is minimal replies on,
  // eighty characters, so the row is checked before the first `chrome` message lands.
  reply: { enabled: true, maxReplyChars: 80 },
  wakeEnabled: false,
  openMain: false,
  catalog: { groups: [] },
  speech: { enabled: false, autoPlay: false, endpoint: 'http://127.0.0.1:8765', voice: 'stella' },
  chime: { enabled: true, quietFrom: 0, quietTo: 7 },
}
/**
 * Whether the profile wants wake-word detection on, and whether this helper can honour
 * it. The switch is persisted by the host and seeded at launch with the other
 * preferences; the ball's menu changes it, and the engine's own state is what the ball
 * draws.
 */
let wakeWanted = readWakeEnabled()
/** True when the launch environment named a usable model directory. */
let wakeReady = false
let avatarToken = 0
// Raw preferences as stored; `theme` resolves through nativeTheme, an absent
// locale falls back to the system languages.
let appearance: Appearance = readAppearanceEnv()
/**
 * The last balance the host reported, in CNY, or `null` when it could not be read. `undefined` means
 * the host has said nothing yet 鈥?the page treats both as "not known" and keeps its ordinary resting
 * loop, which is the only safe reading of a number nobody has.
 */
let balance: { cny: number | null; at?: number } | undefined

process.title = 'dsh-orb-helper'

if (!socketAddress || !token) {
  console.error('dsh-orb helper: socket environment is missing')
  process.exit(1)
}

if (process.platform === 'darwin') app.setActivationPolicy?.('accessory')

let win: BrowserWindow | undefined
let tccWait: ((status: unknown) => void) | undefined
let overlays: {
  appearance(payload: { dark: boolean; locale: 'zh' | 'en' }): void
  deliver(message: unknown): boolean
  chromeWindows(): readonly (NativeHandleWindow | undefined)[]
} | undefined
let placement: FloatingPlacement | undefined
/**
 * Whether the window is currently capturing the mouse, which is the inverse of whether it is
 * click-through. Starts false to match the transparent-to-clicks window built at startup, and is
 * owned by the pointer poll 鈥?see {@link setHitTest}.
 */
let hitTestOver = false
/**
 * The screen rectangles that capture the mouse: the ball, the open panel, the stop cap and the
 * docked tab, as last laid out by the page. Empty until the page reports, which means the window
 * is click-through until then 鈥?the safe direction, since a ball that cannot be clicked is a
 * smaller problem than a window that eats every click on the desktop.
 */
let hitTestRegions: Array<{ x: number; y: number; width: number; height: number; round?: boolean }> = []
/** The last reported geometry, so the trace is one line per change rather than one per press. */
let lastHitTestShape = ''
let hitTestTimer: ReturnType<typeof setInterval> | undefined
let live: Socket | undefined
let quitting = false
let buffer = ''

app.on('before-quit', () => {
  quitting = true
  if (hitTestTimer !== undefined) clearInterval(hitTestTimer)
  hitTestTimer = undefined
  live?.destroy()
})
app.on('window-all-closed', () => {
  app.quit()
})

void app.whenReady().then(async () => {
  if (process.platform === 'darwin') app.dock?.hide()
  wakeReady = wakeAvailable(wake, assetsRoot)
  // One line per launch saying what the wake subsystem thinks it has. A phrase that is in the menu
  // but never starts is otherwise indistinguishable from a microphone that never opened, and those
  // two have completely different causes.
  noteWakeTrace(
    `wake: launch ready=${wakeReady} engine=${wake.engine} keyword=${wake.keyword} `
    + `wanted=${wakeWanted} assets=${assetsRoot} `
    + `keywordFile=${existsSync(kws.keywordFile(wake.keyword))}`,
  )
  serveWakeAssets(wake, assetsRoot)
  win = openWindow()
  try {
    overlays = await attachOverlays({ ball: () => win, write })
  } catch (error) {
    console.error(`dsh-orb helper: overlays did not open: ${error instanceof Error ? error.message : String(error)}`)
  }
  // The overlays install a deny-all permission handler on the shared session, so the
  // ball's microphone policy is (re)installed here to be the one that survives.
  if (!win.isDestroyed()) allowBallMicrophone(win)
  placement = new FloatingPlacement(win, (point) => {
    const display = screen.getDisplayNearestPoint({ x: Math.round(point.x), y: Math.round(point.y) })
    return { bounds: display.bounds, workArea: display.workArea }
  }, () => screen.getAllDisplays().map((display) => display.bounds), initialBallOrigin(screen.getPrimaryDisplay().workArea))
  win.webContents.on('did-finish-load', () => {
    if (win && !win.isVisible()) win.showInactive()
    // The page may have loaded after the last appearance change.
    pushAppearance()
    // Same for the balance: the host reads it on its own cadence, so the page that has just loaded
    // can easily be older than the reading.
    pushBalance()
    // And for the chime: a page that reloads resets to the shipped defaults, and the switch the
    // profile actually holds has to be the one it runs on.
    if (win && !win.isDestroyed()) win.webContents.send('orb:chime', chrome.chime)
    // A profile that already had wake on resumes listening as soon as the page is up.
    if (wakeWanted && wakeReady) void enableWake()
  })
  // OS scheme flips ride through while the theme preference is `system`.
  nativeTheme.on('updated', () => { pushAppearance() })
  applyAppearance()
  startHitTestPoll()
  await win.loadFile(fileURLToPath(new URL('../assets/floating.html', import.meta.url)))
  connect(0)
})

// 鈹€鈹€ wake word 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// Two engines, one at a time, chosen by the menu and stored in `orb-wake.json`:
//
// - `openwake`: the page scores openWakeWord's classifier chain itself (`assets/wake.js`); nothing
//   here touches audio.
// - `sherpa`: the keyword spotter is a native addon, so it lives in this process and the page only
//   forwards the frames its microphone already produces (`orb:wake-feed`). One IPC call per 80 ms
//   frame 鈥?2.5 KB of float samples 鈥?and back comes one message per detection.

/**
 * The decoder engine, created once.
 *
 * The detection is pushed to the page rather than handled here: the confirmation clip, the chime, the
 * ball's visible state and the recorder all belong to the page, which already owns them for the
 * other engine. This process only answers "was the phrase said".
 */
const kws = new SherpaKws(assetsRoot, (keyword, detail) => {
  // One line per detection, because this engine's decisions are invisible from outside: the page
  // shows a chime, and nothing else says which phrase the decoder matched or when it started. The
  // same line is what "did it fire on the real microphone" gets counted from.
  noteWakeTrace(`wake: keyword spotter heard "${keyword}" at ${detail.startTime.toFixed(2)}s`)
  if (win === undefined || win.isDestroyed()) return
  win.webContents.send('orb:wake', {
    type: 'keyword',
    keyword,
    score: detail.score,
    startTime: detail.startTime,
  })
})

/** Frames are 2560 bytes; anything far larger is not the ball's worklet but a mistake. */
const MAX_WAKE_FRAME_BYTES = 64 * 1024

ipcMain.handle('orb:wake-config', (event) => {
  if (!fromBall(event)) return wakePayload(false)
  const enabled = wakeWanted && wakeReady
  // The page starts its microphone on the strength of this answer, so what it was told is worth a
  // line: `ready=false` there means "no models", not "no microphone", and only one of those is fixed
  // by changing the keyword back.
  noteWakeTrace(`wake: config asked, answering enabled=${enabled} ready=${wakeReady}`)
  return wakePayload(enabled)
})

ipcMain.handle('orb:wake-enable', async (event) => {
  if (!fromBall(event)) return false
  return enableWake()
})

ipcMain.handle('orb:wake-disable', async (event) => {
  if (!fromBall(event)) return false
  return disableWake()
})

ipcMain.handle('orb:wake-enabled', async (event, enabled) => {
  if (!fromBall(event)) return false
  return enabled === false ? disableWake() : enableWake()
})

/**
 * One microphone frame for the decoder engine, sent by the page.
 *
 * Sent fire-and-forget rather than invoked: the page produces a frame every 80 ms and must not wait
 * on this process to score it, or a slow frame would back up the audio the recorder needs.
 *
 * The spotter starts on the first frame instead of in `enableWake()`. That keeps the "is it running"
 * question in one place 鈥?the page has already opened the microphone and is already feeding 鈥?and it
 * means a profile left on the decoder engine after its models went missing still shows a plain
 * listening state, with the failure arriving as one console line and one status message.
 * @param event - the IPC event, checked to come from the ball.
 * @param samples - 16 kHz mono float samples, one worklet frame.
 */
ipcMain.on('orb:wake-feed', (event, samples) => {
  if (!fromBall(event) || wake.engine !== 'sherpa' || !wakeWanted) return
  const frame = samples instanceof Float32Array ? samples : undefined
  if (frame === undefined || frame.byteLength > MAX_WAKE_FRAME_BYTES) return
  if (!kws.running()) {
    const detail = kws.start(wake.keyword)
    if (detail !== '') {
      noteWakeTrace(`wake: keyword spotter did not start: ${detail}`)
      if (win !== undefined && !win.isDestroyed()) {
        win.webContents.send('orb:wake', { type: 'engine-error', detail })
      }
      return
    }
    // Once per start, and the only positive evidence that the native addon loaded: `start()` returns
    // a message on failure and silence on success, which is indistinguishable in a log from a
    // spotter that was never asked to start.
    noteWakeTrace(`wake: keyword spotter listening for "${wake.keyword}"`)
  }
  kws.feed(frame)
})

/**
 * The page dropped its audio buffers, so drop the decoder's state with them.
 *
 * The page resets at every edge where audio must not be re-heard: the moment the ball speaks, and the
 * end of an utterance. Leaving a matched prefix in the decoder across one of those made a phrase that
 * had already been recognised fire again on audio that was only ever played back.
 */
ipcMain.on('orb:wake-reset', (event) => {
  if (!fromBall(event) || wake.engine !== 'sherpa') return
  kws.reset()
})

/**
 * Live engine state, for the ball's status line and for the host's own log.
 * @param event - the IPC event, checked to come from the ball.
 * @param status - `{ state, detail, keyword, threshold, frames, peak }` as reported.
 */
ipcMain.handle('orb:wake-report', (event, status) => {
  if (!fromBall(event)) return false
  const record = status !== null && typeof status === 'object' ? status as Record<string, unknown> : {}
  const state = typeof record.state === 'string' ? record.state : ''
  // The page's own verdict, mirrored into the trace: its failure detail only reached this process's
  // stderr, which nothing writes down, so "the microphone never opened" had no cause in the log.
  noteWakeTrace(`wake: page says state=${state === '' ? '?' : state} detail=${typeof record.detail === 'string' ? record.detail : ''}`)
  if (state === 'error' && typeof record.detail === 'string' && record.detail !== '') {
    console.error(`dsh-orb helper: wake word stopped: ${record.detail}`)
  }
  return true
})

// 鈹€鈹€ read-aloud service 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// The TTS model takes ~33 s to load and holds ~5 GB of VRAM, so the service has to be resident
// rather than started per request 鈥?and starting it is not something the page can do, because the
// page is a `file://` document whose CSP only lets it talk to the local port once something is
// listening there. So the launch belongs to this process, and it happens on demand: the first
// play that finds nothing answering starts the service and waits for it.
//
// `DSH_ORB_TTS_LAUNCH` overrides the command line; an empty value disables launching entirely, so
// a profile that expects to start the service itself is not fought by the ball.

/**
 * How long a freshly launched service may take to answer before the wait is treated as a failure.
 *
 * Sized for a local model load — the retired IndexTTS engine needed ~33 s warm and minutes on a
 * cold, contended GPU (see the note on `speechLaunch`). The Edge proxy the default launcher points
 * at answers in about a second, so nothing normal comes near this ceiling; it exists for the case
 * where someone points `DSH_ORB_TTS_LAUNCH` at a heavyweight engine again.
 */
const SPEECH_START_TIMEOUT_MS = 180_000
/** Health probes are local and cheap; anything slower than this is not our service answering. */
const SPEECH_PROBE_TIMEOUT_MS = 1_500
/** Gap between health probes while the engine starts. */
const SPEECH_PROBE_INTERVAL_MS = 2_000

/**
 * The launcher this process runs when nothing is listening on the speech endpoint.
 *
 * The path is historical: the local IndexTTS model used to live in `D:\tools\indextts` and this
 * file was its entry point. The model was removed from disk on 2026-11-21 — 4.94 GB of VRAM for
 * minutes per sentence on an 8 GB laptop GPU — and what is left there is a `.cmd` that only
 * forwards to the Edge proxy in `D:\tools\edgetts`. The path was kept, not moved, so an existing
 * profile's `DSH_ORB_TTS_LAUNCH`, the licence-free default below, and the habit of typing it all
 * still resolve.
 *
 * Reasoning about a future local engine belongs here rather than in a code change: point the
 * environment variable at the new launcher and nothing in this process needs to know.
 */
const speechLaunch = (process.env.DSH_ORB_TTS_LAUNCH
  ?? 'D:\\tools\\indextts\\start_server.cmd').trim()

/**
 * The command interpreter to run the launcher with.
 *
 * Absolute, because a bare `cmd.exe` depends on PATH 鈥?and this process's PATH does not reliably
 * carry System32, so `spawn` failed with ENOENT. Node reports that through an `error` event rather
 * than by throwing, which is why the launch looked like it had begun and then simply never finished.
 */
const SHELL = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'

interface SpeechEnsureResult {
  ok: boolean
  /** Machine-readable reason when `ok` is false: `disabled`, `launch-failed` or `timeout`. */
  reason?: string
}

/** One in-flight launch shared by every caller, so a burst of clicks starts one service, not five. */
let speechLaunching: Promise<SpeechEnsureResult> | null = null

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Whether the read-aloud service answers its health endpoint.
 *
 * Deliberately a real HTTP request rather than a port check: a port can be held by something that
 * is not our service, and then every synthesis would fail in a way that looks like the ball's bug.
 */
function probeSpeech(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let url: URL
    try {
      url = new URL('/health', endpoint)
    } catch {
      done(false)
      return
    }
    const req = httpRequest({
      hostname: url.hostname,
      port: url.port === '' ? 80 : Number(url.port),
      path: url.pathname,
      method: 'GET',
      timeout: SPEECH_PROBE_TIMEOUT_MS,
    }, (res) => {
      res.resume()
      done((res.statusCode ?? 0) === 200)
    })
    req.on('timeout', () => {
      req.destroy()
      done(false)
    })
    req.on('error', () => done(false))
    req.end()
  })
}

/** Start the service and wait until it answers, or until {@link SPEECH_START_TIMEOUT_MS} runs out. */
async function launchSpeech(endpoint: string): Promise<SpeechEnsureResult> {
  console.error(`dsh-orb helper: no speech service on ${endpoint}, starting ${speechLaunch}`)

  // Waiting for the `spawn` event rather than trusting the call: a missing interpreter does not
  // throw, it arrives as an `error` event, and a launch that never happened has to be reported as
  // such rather than as a service that was slow to come up.
  const started = await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (value: boolean) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      // `cmd.exe` so the configured value can be a command line rather than a single executable 鈥?      // and deliberately **not** `detached`. Detaching was tried first and it is what put a black
      // console window on screen.
      //
      // A detached process is created without a console. `cmd.exe` is a console program, so it runs
      // console-less and the `python.exe` inside it allocates a console of its own 鈥?and a console a
      // process allocates for itself is not covered by the hide request that travelled with
      // `CreateProcess`. Measured here by starting the same `cmd.exe -> python.exe` pair once per
      // flag set (`dsh_orb/window_flags_probe.py`):
      //
      //   DETACHED_PROCESS                  1 visible ConsoleWindowClass window   鈫?the black box
      //   STARTF_USESHOWWINDOW + SW_HIDE    0 windows, 0 conhost processes        鈫?what we want
      //   CREATE_NO_WINDOW                  0 windows, 1 conhost, none visible
      //   CREATE_NEW_CONSOLE + SW_HIDE      0 windows, 1 conhost, none visible
      //
      // `windowsHide: true` without `detached` is the second row: no extra launcher, no extra
      // process, nothing to see. Dropping `detached` costs nothing either 鈥?Windows does not kill a
      // child when its parent exits, and libuv never set CREATE_BREAKAWAY_FROM_JOB, so a detached
      // child was always going to be in the same job as this one anyway.
      const child = spawn(SHELL, ['/d', '/s', '/c', speechLaunch], {
        cwd: dirname(speechLaunch),
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', (error) => {
        console.error(`dsh-orb helper: could not start the speech service: ${String(error)}`)
        done(false)
      })
      child.on('spawn', () => done(true))
      child.unref()
    } catch (error) {
      console.error(`dsh-orb helper: could not start the speech service: ${String(error)}`)
      done(false)
    }
  })
  if (!started) return { ok: false, reason: 'launch-failed' }

  const deadline = Date.now() + SPEECH_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await delay(SPEECH_PROBE_INTERVAL_MS)
    if (await probeSpeech(endpoint)) {
      console.error('dsh-orb helper: speech service is up')
      return { ok: true }
    }
  }
  console.error('dsh-orb helper: speech service did not answer in time')
  return { ok: false, reason: 'timeout' }
}

/**
 * Make sure the read-aloud service is running, starting it if it is not.
 *
 * Called by the page when a synthesis request cannot connect. Concurrent callers share one launch.
 */
async function ensureSpeechService(): Promise<SpeechEnsureResult> {
  const endpoint = chrome.speech.endpoint
  if (await probeSpeech(endpoint)) return { ok: true }
  if (speechLaunching !== null) return speechLaunching
  if (speechLaunch === '') return { ok: false, reason: 'disabled' }
  speechLaunching = launchSpeech(endpoint).finally(() => { speechLaunching = null })
  return speechLaunching
}

ipcMain.handle('orb:speech-ensure', async (event) => {
  if (!fromBall(event)) return { ok: false, reason: 'denied' }
  return ensureSpeechService()
})

/**
 * Hand one recorded utterance to the host for transcription.
 *
 * The page already owns the microphone for the wake engine, so it records there and sends
 * a complete 16 kHz mono PCM16 WAV as base64. The host answers with `transcript` or
 * `transcript-error`, which {@link deliver} forwards to the page.
 */
ipcMain.handle('orb:dictate', (event, payload) => {
  if (!fromBall(event)) return null
  const record = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const audio = typeof record.audioBase64 === 'string' ? record.audioBase64 : ''
  if (audio === '' || audio.length > 8_000_000) return null
  const id = `dictation-${randomUUID()}`
  write({
    type: 'transcribe',
    id,
    audioBase64: audio,
    ...(typeof record.language === 'string' && record.language !== '' ? { language: record.language } : {}),
  })
  return id
})

/**
 * The regions of the window that should capture the mouse, reported by the page whenever its
 * layout changes.
 *
 * The page is the only thing that knows where its elements ended up, and that is genuinely a
 * question for it 鈥?but it is asked for geometry, not for a verdict on the pointer. The verdict is
 * made here, from the pointer's actual position, because a click-through window delivers no mouse
 * events to the renderer and so the page could never reach one. See {@link setHitTest}.
 */
ipcMain.on('orb:hit-test', (event, regions) => {
  if (!fromBall(event)) return
  hitTestRegions = Array.isArray(regions)
    ? regions.filter(isRect).map((region) => ({
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
      ...(region.round === true ? { round: true } : {}),
    }))
    : []
  // One line per change of geometry. A region that captures clicks over nothing has no other
  // trace: the click simply dies, and "which rectangle, inside which window" is the whole
  // diagnosis. Written only when the set changes, because the page reports on every press.
  const shape = hitTestRegions
    .map((region) => `${region.round === true ? 'o' : ''}${Math.round(region.width)}x${Math.round(region.height)}@${Math.round(region.x)},${Math.round(region.y)}`)
    .join(' ')
  if (shape !== lastHitTestShape) {
    lastHitTestShape = shape
    const bounds = win !== undefined && !win.isDestroyed() ? win.getContentBounds() : undefined
    noteWakeTrace(`overlay: capture ${hitTestRegions.length} [${shape}] in ${bounds === undefined ? '?' : `${bounds.width}x${bounds.height}`}`)
  }
  // The pointer may already be over the new regions 鈥?a panel opening under it, say 鈥?and the poll
  // only runs every 30ms, so re-decide now rather than leaving a frame where a click would fall
  // through a panel that is already there.
  if (win && !win.isDestroyed()) setHitTest(win, overCapturedRegion(win, screen.getCursorScreenPoint()))
})

/**
 * One line from the page into the helper's log.
 *
 * The page's console never reaches `stream.log`, and the failures worth reading from outside are
 * the ones with no visual symptom at all: a drag whose release never arrived, which leaves the
 * overlay capturing the whole window over empty desktop.
 */
ipcMain.on('orb:note', (event, line) => {
  if (!fromBall(event) || typeof line !== 'string' || line === '') return
  noteWakeTrace(line.slice(0, 400))
})

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number; round?: boolean } {
  if (value === null || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
}

/**
 * The corner the ball is in right now, for the page to wear before it draws anything.
 * Answers a question and changes nothing 鈥?see {@link FloatingPlacement.currentDirection}.
 */
ipcMain.handle('orb:direction', (event) => {
  if (!fromBall(event) || !placement) return { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined }
  return placement.currentDirection()
})

ipcMain.handle('orb:expand', (event, expanded) => {
  if (!fromBall(event) || !placement || typeof expanded !== 'boolean') {
    return { expanded: false, horizontal: 'left', vertical: 'up', docked: undefined }
  }
  return placement.setExpanded(expanded)
})

ipcMain.handle('orb:move', (event, request) => {
  if (!fromBall(event) || !placement || !isMove(request)) return { docked: undefined }
  return placement.move(request.x, request.y, request.canDock)
})

ipcMain.handle('orb:clamp', async (event, canDock) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.clamp(canDock !== false)
})

ipcMain.handle('orb:unsnap', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.unsnap()
})

ipcMain.handle('orb:unsnap-smooth', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.unsnapSmooth()
})

// The strip's hover. Kept apart from `orb:unsnap-smooth` on purpose: undocking is the user taking
// the ball back, and a peek is the ball showing itself while the *dock stays put* 鈥?the same
// `DockState` shape, a different promise about the strip that is still behind it.
ipcMain.handle('orb:dock-peek', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.peek()
})

ipcMain.handle('orb:dock-unpeek', async (event) => {
  if (!fromBall(event) || !placement) return { docked: undefined }
  return placement.unpeek()
})

ipcMain.on('orb:prompt', (event, text) => {
  if (!fromBall(event)) return
  write({ type: 'prompt', text })
})

ipcMain.on('orb:question-answer', (event, payload) => {
  if (!fromBall(event)) return
  if (typeof payload !== 'object' || payload === null) return
  const record = payload as { id?: unknown; answers?: unknown }
  write({ type: 'question-answer', id: record.id, answers: record.answers })
})

ipcMain.on('orb:question-cancel', (event, id) => {
  if (!fromBall(event)) return
  write({ type: 'question-cancel', id })
})

ipcMain.on('orb:history', (event) => {
  if (!fromBall(event)) return
  write({ type: 'history' })
})

ipcMain.on('orb:open', (event, sessionId) => {
  if (!fromBall(event)) return
  if (typeof sessionId === 'string') write({ type: 'open', sessionId })
})

ipcMain.on('orb:new', (event) => {
  if (!fromBall(event)) return
  write({ type: 'new' })
})

ipcMain.on('orb:permission', (event, preset) => {
  if (!fromBall(event)) return
  if (typeof preset === 'string') write({ type: 'permission', preset })
})

ipcMain.on('orb:stop', (event) => {
  if (!fromBall(event)) return
  write({ type: 'stop' })
})

// 鈹€鈹€ main-window voice 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
//
// The wake path belongs to the black panel again, so the page does not call these. The hand-off
// is kept whole: a page that does call it makes the host remember the request, the main DSH
// window's page press its own microphone button, and the limits and send decision stay the same
// as the ball's (see `takeMainVoice` in host/src/orb.ts). The page reaches the host on the normal
// web port, so these two messages only ever travel over the helper socket.
ipcMain.on('orb:main-voice', (event) => {
  if (!fromBall(event)) return
  noteWakeHandOff('wake: the ball asked for the main window\'s microphone')
  write({ type: 'main-voice-start' })
})

ipcMain.on('orb:open-main', (event) => {
  if (!fromBall(event)) return
  write({ type: 'open-main' })
})

// Renderer clipboard APIs need a focused document; the ball rests unfocused,
// so writes go through the main process, which has no such gate.
ipcMain.on('orb:copy', (event, text) => {
  if (!fromBall(event)) return
  if (typeof text !== 'string' || text.length > 1_000_000) return
  clipboard.writeText(text)
})

ipcMain.handle('orb:menu', async (event) => {
  if (!fromBall(event) || !win) return
  write({ type: 'menu' })
  await showMenu(win)
})

ipcMain.on('orb:open-external', (event, url) => {
  if (!fromBall(event)) return
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 4000) return
  void shell.openExternal(url)
})

ipcMain.handle('orb:tcc-status', (event) => {
  if (!fromBall(event)) return tccUnavailable()
  return askTcc({ type: 'tcc' })
})

ipcMain.handle('orb:tcc-open', (event, right) => {
  if (!fromBall(event)) return tccUnavailable()
  if (right !== 'screen' && right !== 'accessibility') return tccUnavailable()
  return askTcc({ type: 'tcc-open', right })
})

// Meme bursts are purely cosmetic and stay in this process: the page asks for the
// schedule once, then for one random image per frame.
ipcMain.handle('orb:meme-schedule', (event) => {
  if (!fromBall(event)) return null
  return picker().schedule()
})

ipcMain.handle('orb:meme-idle', (event) => {
  if (!fromBall(event)) return null
  return picker().idle()
})

ipcMain.handle('orb:meme-hover', (event) => {
  if (!fromBall(event)) return null
  return picker().hover()
})

ipcMain.handle('orb:meme-typing', (event) => {
  if (!fromBall(event)) return null
  return picker().typing()
})

ipcMain.handle('orb:meme-reply', (event) => {
  if (!fromBall(event)) return null
  return picker().reply()
})

ipcMain.handle('orb:meme-thinking', (event) => {
  if (!fromBall(event)) return null
  return picker().thinking()
})

ipcMain.handle('orb:meme-drag', (event) => {
  if (!fromBall(event)) return null
  return picker().drag()
})

ipcMain.handle('orb:meme-tool', (event) => {
  if (!fromBall(event)) return null
  return picker().tool()
})

ipcMain.handle('orb:meme-tool-named', (event, name) => {
  if (!fromBall(event)) return null
  // A name that is not a string is not a reason to read anything: the page sends what the transcript says, and
  // `null` back means "this tool wears the shared face", which is the same answer an unlisted name gets.
  const answer = typeof name === 'string' && name !== '' ? picker().toolNamed(name) : null
  void noteToolFaceRequest(name, answer)
  return answer
})

/**
 * Note that the page asked for one named tool's face, and what it was told.
 *
 * The page cannot log anywhere a human can read, and a lookup that quietly answers "nothing special" is
 * indistinguishable from a lookup that never happened 鈥?which is exactly the question this answers. Off unless
 * `DSH_ORB_TOOL_LOG` names a file, because it is a write on the path of every tool call.
 */
async function noteToolFaceRequest(name: unknown, answer: unknown): Promise<void> {
  const path = process.env.DSH_ORB_TOOL_LOG
  if (path === undefined || path === '') return
  try {
    const src = await answer
    appendFileSync(path, `${new Date().toISOString()} asked=${JSON.stringify(name)} answered=${src === null ? 'null' : `${String(src).length} chars`}\n`)
  } catch {
    // A readout that cannot be written is not a reason to change what the ball wears.
  }
}

/**
 * Record one wake line where a human can read it.
 *
 * The file is `stream.log`, beside the profile, because that is where the rest of the wake chain is
 * written and where the page's own console lines land. This process's `console.log` does **not**
 * reach it 鈥?the host logs the page and its own messages, not the helper's stdout 鈥?and every
 * question about the decoder engine ("did the addon load", "did it hear me") is answered from there.
 */
function noteWakeTrace(line: string): void {
  try {
    appendFileSync(join(app.getPath('home'), '.dsh', 'dsh-orb', 'stream.log'), `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A readout that cannot be written must not change what the ball does.
  }
}

/**
 * Record one wake hand-off where a human can read it.
 *
 * A wake that opens no microphone has four possible breaks 鈥?the ball never asked, the ask never
 * reached the host, the page never collected, or the page collected and failed 鈥?and from the
 * outside all four look like "nothing happened". This is the ball's end of that chain; the host's
 * end writes to the same file.
 */
function noteWakeHandOff(line: string): void {
  noteWakeTrace(line)
}

ipcMain.handle('orb:meme-sleep', (event) => {
  if (!fromBall(event)) return null
  return picker().sleep()
})

ipcMain.handle('orb:meme-sleep-frame', (event, index) => {
  if (!fromBall(event)) return null
  return picker().sleepFrame(typeof index === 'number' ? Math.trunc(index) : -1)
})

ipcMain.handle('orb:meme-yawn', (event) => {
  if (!fromBall(event)) return null
  return picker().yawn()
})

ipcMain.handle('orb:meme-click', (event) => {
  if (!fromBall(event)) return null
  return picker().click()
})

ipcMain.handle('orb:meme-arrive', (event) => {
  if (!fromBall(event)) return null
  return picker().arrive()
})

ipcMain.handle('orb:meme-dock-arrive', (event) => {
  if (!fromBall(event)) return null
  return picker().dockArrive()
})

ipcMain.handle('orb:meme-poor', (event) => {
  if (!fromBall(event)) return null
  return picker().poor()
})

ipcMain.handle('orb:meme-done', (event) => {
  if (!fromBall(event)) return null
  return picker().done()
})

ipcMain.handle('orb:meme-nod', (event) => {
  if (!fromBall(event)) return null
  return picker().nod()
})

ipcMain.handle('orb:meme-interrupted', (event) => {
  if (!fromBall(event)) return null
  return picker().interrupted()
})

ipcMain.handle('orb:meme-approval', (event) => {
  if (!fromBall(event)) return null
  return picker().approval()
})

ipcMain.handle('orb:meme-maxtokens', (event) => {
  if (!fromBall(event)) return null
  return picker().maxtokens()
})

ipcMain.handle('orb:meme-fail', (event) => {
  if (!fromBall(event)) return null
  return picker().fail()
})

ipcMain.handle('orb:meme-ask', (event) => {
  if (!fromBall(event)) return null
  return picker().ask()
})

ipcMain.handle('orb:meme-wake', (event) => {
  if (!fromBall(event)) return null
  return picker().wake()
})

ipcMain.handle('orb:meme-voice', (event) => {
  if (!fromBall(event)) return null
  return picker().voice()
})

ipcMain.handle('orb:meme-speak', (event) => {
  if (!fromBall(event)) return null
  return picker().speak()
})

ipcMain.handle('orb:meme-drop', (event) => {
  if (!fromBall(event)) return null
  return picker().drop()
})

ipcMain.handle('orb:meme-skit', (event) => {
  if (!fromBall(event)) return null
  return picker().skit()
})

ipcMain.handle('orb:meme-frame', (event) => {
  if (!fromBall(event)) return null
  return picker().next()
})

let pickerInstance: MemePicker | undefined

/** The burst picker, reading `memes.json` from the orb's own runtime folder. */
function picker(): MemePicker {
  pickerInstance = pickerInstance ?? createMemePicker(join(runtimeDirectory(), 'memes.json'))
  return pickerInstance
}

/**
 * `<dsh home>/dsh-orb`: the host spawns this helper with
 * `--user-data-dir=<dsh home>/dsh-orb/helper-data/<profile id>`, and the burst config
 * belongs next to the host's own `floating-session.json`.
 */
function runtimeDirectory(): string {
  const userData = app.getPath('userData')
  const parent = dirname(userData)
  return basename(parent) === 'helper-data' ? dirname(parent) : userData
}

function openWindow(): BrowserWindow {
  const bounds = initialWindowBounds(screen.getPrimaryDisplay().workArea)
  const created = new BrowserWindow({
    title: 'dsh-orb',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: true,
    show: false,
    backgroundColor: '#00000000',
    roundedCorners: false,
    ...process.platform === 'darwin' ? { type: 'panel' } : {},
    webPreferences: {
      preload: fileURLToPath(new URL('../preload.cjs', import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // The ball rests captureable; overlays.ts syncCloak lifts it out of captures
  // for the duration of each Computer Use capture or HID interval.
  allowBallMicrophone(created)
  created.setAlwaysOnTop(true, 'screen-saver')
  // The window is the overlay rect in both states, so at rest most of it is empty space that
  // happens to sit over whatever the user is doing. Clicks have to fall through it, or the panel
  // would open onto a sheet of dead desktop. `forward` keeps mousemove coming, which is the only
  // way the page can ever learn the pointer is back over the ball and turn capture off again.
  // The page owns the state through `orb:hit-test`; this is the value it starts from.
  setHitTest(created, false)
  if (process.platform === 'darwin') {
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  }
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('context-menu', (event, params) => {
    // Electron renders no context menu of its own, so a selection has to be given one explicitly.
    // Before this, right-click over selected text was a no-op 鈥?the handler returned, nothing
    // appeared 鈥?and the only way to get a sentence out of the ball's card was to retype it.
    // `role: 'copy'` runs Chromium's own edit command against the focused selection, which is also
    // the path Ctrl+C takes, so the two behave identically.
    if (params?.hasSelection) {
      const zh = menuZh()
      Menu.buildFromTemplate([
        { label: zh ? '复制' : 'Copy', role: 'copy' },
        { label: zh ? '全选' : 'Select all', role: 'selectAll' },
      ]).popup({ window: created })
      return
    }
    // Editable text keeps the platform's own menu (cut, copy, paste); nothing in the bubble is
    // editable now, so this is only ever the question card's text field.
    if (params?.isEditable) return
    // A bare right-click opens the ball's own menu.
    event.preventDefault()
    write({ type: 'menu' })
    setTimeout(() => { void showMenu(created) }, 30)
  })
  created.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  created.on('closed', () => {
    if (!quitting) app.quit()
  })
  created.once('ready-to-show', () => {
    created.showInactive()
    const shown = created.getBounds()
    console.error(`dsh-orb helper: ball ${shown.x},${shown.y} ${shown.width}x${shown.height}`)
  })
  return created
}

function connect(attempt: number): void {
  if (quitting) return
  const colon = socketAddress.lastIndexOf(':')
  const host = socketAddress.slice(0, colon)
  const port = Number(socketAddress.slice(colon + 1))
  const socket = createConnection({ host, port })
  socket.setEncoding('utf8')
  let opened = false
  socket.on('connect', () => {
    opened = true
    live = socket
    buffer = ''
    socket.write(`${JSON.stringify({ type: 'hello', token, pid: process.pid })}\n`)
    // The host's observation walk must skip the ball itself, or a click on the ball makes
    // it the window the agent believes the user is working in.
    const ids = chromeWindowIds()
    if (ids.length > 0) write({ type: 'chrome-windows', ids })
  })
  socket.on('data', (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.trim()) continue
      let message: unknown
      try {
        message = JSON.parse(part)
      } catch {
        continue
      }
      deliver(message)
    }
  })
  socket.on('error', () => {
    // close follows and decides whether to retry.
  })
  socket.on('close', () => {
    if (live === socket) live = undefined
    if (quitting) return
    if (opened) {
      app.quit()
      return
    }
    if (attempt >= 30) {
      console.error('dsh-orb helper: host socket did not open')
      app.exit(1)
      return
    }
    setTimeout(() => connect(attempt + 1), 300)
  })
}

function deliver(message: unknown): void {
  if (overlays?.deliver(message)) return
  if (typeof message !== 'object' || message === null || !win) return
  const record = message as { type?: unknown }
  if (record.type === 'session') {
    win.webContents.send('orb:session', (record as { sessionId?: unknown }).sessionId)
    return
  }
  if (record.type === 'block') {
    win.webContents.send('orb:block', message)
    return
  }
  if (record.type === 'block-drop') {
    win.webContents.send('orb:block-drop', (record as { key?: unknown }).key)
    return
  }
  if (record.type === 'turn') {
    win.webContents.send('orb:turn', message)
    return
  }
  if (record.type === 'session-turn') {
    // News about a turn in a conversation this ball is not in. Forwarded whole, because the page switches on
    // the outcome: only `streaming` exists so far, and the payload's `sessionId` is what a log line names.
    win.webContents.send('orb:session-turn', message)
    return
  }
  if (record.type === 'status') {
    win.webContents.send('orb:status', (record as { text?: unknown }).text)
    return
  }
  if (record.type === 'question') {
    win.webContents.send('orb:question', message)
    return
  }
  if (record.type === 'question-clear') {
    win.webContents.send('orb:question-clear', (record as { id?: unknown }).id)
    return
  }
  if (record.type === 'question-error') {
    win.webContents.send('orb:question-error', message)
    return
  }
  if (record.type === 'permission') {
    win.webContents.send('orb:permission', (record as { preset?: unknown }).preset)
    return
  }
  if (record.type === 'transcript') {
    win.webContents.send('orb:transcript', { id: (record as { id?: unknown }).id, text: (record as { text?: unknown }).text })
    return
  }
  if (record.type === 'transcript-error') {
    win.webContents.send('orb:transcript', { id: (record as { id?: unknown }).id, error: (record as { message?: unknown }).message })
    return
  }
  if (record.type === 'history') {
    win.webContents.send('orb:history', (record as { items?: unknown }).items)
    return
  }
  if (record.type === 'voice-result') {
    // How the turn the main window recorded ended: `sent` left a conversation to watch, and every
    // other ending is a turn that heard nothing. The page folds back the panel it opened on the
    // wake for the second kind (`foldWakePanel` in `assets/shell.js`) 鈥?a panel that stays open on
    // an exchange that never happened reads as a ball that is still waiting.
    win.webContents.send('orb:wake', {
      type: 'voice-result',
      outcome: typeof (record as { outcome?: unknown }).outcome === 'string'
        ? (record as { outcome: string }).outcome
        : '',
    })
    return
  }
  if (record.type === 'reset') {
    win.webContents.send('orb:reset')
    return
  }
  if (record.type === 'chrome') {
    const wantedWake = (record as { wakeEnabled?: unknown }).wakeEnabled
    chrome = readChrome(record)
    // The ball's own menu is not the only place the switch lives any more: the main window's
    // composer has one too, and a flip there has to reach the engine now rather than at the next
    // launch. `wakeWanted` is what the page was told, so only a real change acts 鈥?the host mirrors
    // this process's own `set-wake` back in every `chrome` message, and acting on that would send
    // the same enabled/disabled notice a second time.
    if (wantedWake === true && !wakeWanted) enableWake()
    else if (wantedWake === false && wakeWanted) disableWake()
    // The recorder is tuned from the settings page while the ball is up, so the block travels with
    // every chrome message and is handed straight to the page: the next utterance ends on it, with
    // no relaunch and no menu round-trip. `wake.dictation` is the launch value until this lands, and
    // `wakePayload()` reads it back for a page that reloads in the meantime.
    if (chrome.dictation !== undefined) {
      wake = { ...wake, dictation: chrome.dictation }
      if (win && !win.isDestroyed()) win.webContents.send('orb:wake', { type: 'tuning', dictation: chrome.dictation })
    }
    // Straight to the page: the read-aloud buttons have to appear and disappear as the settings
    // page flips the switch, with no reload and no menu round-trip.
    if (win && !win.isDestroyed()) win.webContents.send('orb:speech', chrome.speech)
    // The hourly chime's switch and quiet window. The page owns the timer, so a flip in the menu
    // has to reach it now: turning the chime on speaks a sample immediately, and that is the only
    // proof the user gets without waiting for the next hour.
    if (win && !win.isDestroyed()) win.webContents.send('orb:chime', chrome.chime)
    return
  }
  if (record.type === 'appearance') {
    const next = readAppearanceMessage(message)
    if (next.theme !== undefined) appearance.theme = next.theme
    if (next.locale !== undefined) appearance.locale = next.locale
    applyAppearance()
    return
  }
  if (record.type === 'avatar') {
    void loadAvatar(readAvatarChoice(record as Record<string, unknown>))
    return
  }
  if (record.type === 'balance') {
    balance = readBalanceMessage(record)
    pushBalance()
    return
  }
  if (record.type === 'tcc') {
    const wait = tccWait
    tccWait = undefined
    wait?.((record as { status?: unknown }).status)
  }
  // A message this function does not know is a message the page never sees, and it fails *silently*: the host
  // sends, the helper drops, and the ball does nothing 鈥?which is indistinguishable from a host that never sent
  // anything. That is exactly how a face for the six turn endings came to do nothing for a whole round of testing.
  console.error(`dsh-orb helper: undelivered message type=${String(record.type)}`)
}

/** Ball plus overlays: the windows the host must skip when it picks an observation window. */
function chromeWindowIds(): number[] {
  return collectChromeWindowIds([win, ...(overlays?.chromeWindows() ?? [])], process.platform)
}

/**
 * The ball gets exactly one permission and nothing else: audio capture.
 *
 * Wake-word detection needs the microphone; the ball has no camera, no geolocation,
 * no notifications, and no reason to open a device. `denyWindowPermissions` still
 * guards every other window this process creates (the selection toolbar and the
 * observation frame), and it stays the default answer here for anything but `media`.
 * @param created - the freshly created ball window.
 */
function allowBallMicrophone(created: BrowserWindow): void {
  // Every window in this process shares one session, so this policy has to name the ball
  // itself: the overlays open afterwards and answer the same question. Without the
  // identity check their deny-all handler (or a later one) would refuse the microphone
  // and the engine would report `Permission denied` while the ball looked healthy.
  const isBall = (contents: unknown): boolean => !created.isDestroyed() && contents === created.webContents
  created.webContents.session.setPermissionCheckHandler((contents, permission) =>
    permission === 'media' && isBall(contents))
  created.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== 'media' || !isBall(contents)) {
      callback(false)
      return
    }
    // `mediaTypes` is absent on some Electron builds; audio-only is the safe read,
    // because a video request would light the camera and the ball never shows one.
    const types = details?.mediaTypes
    callback(types === undefined || types.length === 0 || types.every((type) => type === 'audio'))
  })
}

function fromBall(event: unknown): boolean {
  if (!win || win.isDestroyed()) return false
  return (event as { sender?: BrowserWindow['webContents'] }).sender === win.webContents
}

/**
 * Turn click-through on or off, skipping the call when it is already in that state.
 *
 * `setIgnoreMouseEvents` is a live window-state change, and calling it with the value the window
 * already has still costs a round trip through the window manager. The page reports on every
 * pointer move, so that would be a steady stream of no-ops.
 *
 * The current value is kept here rather than read back with `isIgnoreMouseEvents`, which cannot be
 * trusted to mean what it looks like: it reports the *forwarding* state that was passed alongside
 * the flag, so a window set to `setIgnoreMouseEvents(true, { forward: true })` 鈥?the only mode
 * this window ever uses 鈥?reads back in a way that does not distinguish the two states. A plain
 * boolean is both unambiguous and assertable from a test.
 */
/**
 * The regions of the window that capture the mouse: the ball, the panel, the stop cap and the
 * docked tab. Everything else in the window is empty space and has to be transparent to clicks.
 *
 * This is decided here rather than by the page, which is the reversal of the obvious arrangement
 * and worth recording why. The page knows where its elements ended up, but it cannot be *asked*:
 * the window is click-through whenever the pointer is off them, and a click-through window on this
 * platform delivers no `mousemove` to the renderer at all 鈥?not even with `forward: true`, which
 * was measured, not assumed (the page's own move counter stayed at zero while the pointer crossed
 * the ball). So a page that reports "the pointer is on me" can never find out, and the window
 * stays permanently transparent with a ball nothing can click.
 *
 * The main process has no such problem: `screen.getCursorScreenPoint` reads the pointer whatever the
 * window is doing. What it needs from the page is the *geometry* 鈥?where the ball and the panel
 * actually are 鈥?which the page can report once per layout, and which does not change while the
 * pointer is moving.
 */
/**
 * A little slack around a reported rect, for the press that lands while the pointer is still moving
 * in: the poll is 30 Hz, so the window may only learn the pointer has arrived one frame after it has.
 *
 * Small on purpose. Every pixel of it is invisible desktop that swallows a click, which is exactly
 * the failure this is supposed to prevent, and the ball's own box is already generous.
 */
const CAPTURE_MARGIN = 3

function setHitTest(target: BrowserWindow, over: boolean): void {
  if (target.isDestroyed()) return
  if (hitTestOver === over) return
  hitTestOver = over
  target.setIgnoreMouseEvents(!over, { forward: true })
  // Tell the page which side of the line the pointer crossed, with its position in the page's own
  // coordinates. The page listens for `pointerenter`/`pointerleave` to open and close the panel,
  // and on a real hand those are enough 鈥?but the events describe movement, and a pointer that
  // jumps (a fast flick, a touchpad tap, a scripted move) can cross the boundary and stop between
  // two of them. Then the last event the page saw was on the far side, and the panel would sit
  // open with the pointer gone, or stay shut with the pointer resting on the ball, until the user
  // happened to move again. This is the crossing itself, so it does not depend on there being
  // another move.
  sendPointer(over)
}

/**
 * The pointer, in the CSS coordinates the page measures in, or `null` when it is outside the window.
 *
 * `getCursorScreenPoint` is in screen coordinates and the page's rects are in CSS pixels, so this
 * converts through the window's own content bounds. That is the same conversion the page does in
 * reverse when it reports a rect, so the two agree by construction.
 */
function sendPointer(over: boolean): void {
  if (!win || win.isDestroyed()) return
  if (!over) {
    win.webContents.send('orb:pointer', null)
    return
  }
  const point = screen.getCursorScreenPoint()
  const bounds = win.getContentBounds()
  win.webContents.send('orb:pointer', { x: point.x - bounds.x, y: point.y - bounds.y })
}

/**
 * Whether a screen point is inside any of the regions the page last reported.
 *
 * A region marked `round` is drawn as a circle, so it is tested as one: the corners of the bounding
 * square are not on the shape, and treating them as captured is a dead spot the user cannot see
 * anything in — the ball's own corners are about 60x60 each.
 *
 * The page reports its rects in its own coordinate space (see {@link syncHitTest} in
 * `assets/shell.js`), so the window's position is subtracted here, on every call, from the bounds
 * the window has *now*. A rect reported while the helper was moving or resizing the window is
 * therefore still correct at the moment of the click, instead of having been frozen at a position
 * where nothing is drawn.
 */
function overCapturedRegion(target: BrowserWindow, point: { x: number; y: number }): boolean {
  if (target.isDestroyed()) return false
  const bounds = target.getContentBounds()
  const x = point.x - bounds.x
  const y = point.y - bounds.y
  for (const region of hitTestRegions) {
    if (region.round === true) {
      const radiusX = region.width / 2 + CAPTURE_MARGIN
      const radiusY = region.height / 2 + CAPTURE_MARGIN
      const dx = (x - (region.x + region.width / 2)) / radiusX
      const dy = (y - (region.y + region.height / 2)) / radiusY
      if (dx * dx + dy * dy <= 1) return true
      continue
    }
    if (x >= region.x - CAPTURE_MARGIN && x <= region.x + region.width + CAPTURE_MARGIN
      && y >= region.y - CAPTURE_MARGIN && y <= region.y + region.height + CAPTURE_MARGIN) {
      return true
    }
  }
  return false
}

/**
 * Keep the window's click-through in step with where the pointer is.
 *
 * A short poll rather than an event, because there is no event to listen to: the whole point of
 * click-through is that the window is not receiving mouse input. 30Hz is fast enough that the
 * window is capturing before a click can land 鈥?a click is a press and a release at the same place,
 * so it needs the state right at the moment of the press 鈥?and slow enough to be invisible next to
 * the work this process already does.
 */
function startHitTestPoll(): void {
  if (hitTestTimer !== undefined) return
  hitTestTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    setHitTest(win, overCapturedRegion(win, screen.getCursorScreenPoint()))
  }, 33)
}

/** What the ball's page needs before it starts the engine. */
function wakePayload(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    ready: wakeReady,
    // The page branches on this before loading anything: the two engines share the microphone, the
    // recorder and the confirmation, and nothing else. `threshold` belongs to the classifier and is
    // meaningless to the decoder, which reads its operating point from `wake-sherpa.ts`.
    engine: wake.engine,
    hasAssets: wake.assetDirectory !== '' || wake.engine === 'sherpa',
    keyword: wake.keyword,
    threshold: wake.threshold,
    autoExpandOnWake: wake.autoExpandOnWake,
    dictation: wake.dictation,
    continuous: wake.continuous,
    origin: `${WAKE_SCHEME}://assets/`,
  }
}

/**
 * Whether the host had wake switched on when it launched this helper.
 *
 * The host sends the whole tuning block as one JSON value, so the flag rides along
 * with the keyword and threshold rather than in an extra variable.
 * @returns true only for an explicit `"enabled": true`.
 */
function readWakeEnabled(): boolean {
  const raw = process.env.DSH_ORB_WAKE
  if (typeof raw !== 'string' || raw === '') return false
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && (parsed as { enabled?: unknown }).enabled === true
  } catch {
    return false
  }
}

/**
 * Turn wake-word detection on: the page starts the engine, the host remembers it.
 * @returns whether the ball was told to listen.
 */
function enableWake(): boolean {
  if (!win || win.isDestroyed()) return false
  if (!wakeReady) {
    console.error('dsh-orb helper: wake word has no model directory')
    return false
  }
  wakeWanted = true
  chrome = { ...chrome, wakeEnabled: true }
  noteWakeTrace(`wake: enabled by the user (ready=${wakeReady}, keyword=${wake.keyword})`)
  win.webContents.send('orb:wake', { type: 'enabled' })
  write({ type: 'set-wake', enabled: true })
  return true
}

/** Turn it off: the page releases the microphone, the host remembers that too. */
function disableWake(): boolean {
  wakeWanted = false
  // The decoder holds a native stream and a spotter; dropping them here is what makes "off" mean no
  // decoding at all, rather than a spotter that keeps chewing frames the page no longer sends.
  kws.stop()
  chrome = { ...chrome, wakeEnabled: false }
  if (win && !win.isDestroyed()) win.webContents.send('orb:wake', { type: 'disabled' })
  write({ type: 'set-wake', enabled: false })
  return true
}

function tccUnavailable(): { applicable: false; appName: string; screen: 'granted'; accessibility: 'granted' } {
  return { applicable: false, appName: '', screen: 'granted', accessibility: 'granted' }
}

function askTcc(message: unknown): Promise<unknown> {
  const previous = tccWait
  tccWait = undefined
  previous?.(tccUnavailable())
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (tccWait !== finish) return
      tccWait = undefined
      resolve(tccUnavailable())
    }, 3000)
    const finish = (status: unknown) => {
      clearTimeout(timer)
      resolve(status ?? tccUnavailable())
    }
    tccWait = finish
    write(message)
  })
}

function write(message: unknown): void {
  if (!live) return
  live.write(`${JSON.stringify(message)}\n`)
}

function isMove(value: unknown): value is { x: number; y: number; canDock: boolean } {
  if (typeof value !== 'object' || value === null) return false
  const point = value as { x?: unknown; y?: unknown; canDock?: unknown }
  return typeof point.x === 'number' && typeof point.y === 'number'
    && Number.isFinite(point.x) && Number.isFinite(point.y)
    && Math.abs(point.x) <= 100_000 && Math.abs(point.y) <= 100_000
    && typeof point.canDock === 'boolean'
}

function zhLocale(): boolean {
  const locale = app.getLocale?.() ?? process.env.LANG ?? ''
  return locale.toLowerCase().startsWith('zh')
}

/** Appearance seed from the host: the preferences as of helper launch. */
function readAppearanceEnv(): Appearance {
  const raw = process.env.DSH_ORB_APPEARANCE
  if (typeof raw !== 'string' || raw.length > 200) return {}
  try {
    return readAppearanceMessage(JSON.parse(raw))
  } catch {
    return {}
  }
}

function themeSourceOr(value: unknown, fallback: ThemeSource | undefined): ThemeSource | undefined {
  return value === 'light' || value === 'dark' || value === 'system' ? value : fallback
}

/** Accept only well-formed preference fields; anything else keeps the current value. */
function readAppearanceMessage(value: unknown): Appearance {
  if (typeof value !== 'object' || value === null) return {}
  const record = value as { theme?: unknown; locale?: unknown }
  const theme = themeSourceOr(record.theme, undefined)
  return {
    ...(theme === undefined ? {} : { theme }),
    ...(typeof record.locale === 'string' && record.locale.length > 0 && record.locale.length <= 35
      ? { locale: record.locale }
      : {}),
  }
}

/**
 * The UI language the ball mirrors: an explicit Host locale that names one of
 * the shipped languages wins, otherwise follow the system like the web client
 * falls back to its browser detection.
 */
function uiLanguage(): 'zh' | 'en' {
  const preference = typeof appearance.locale === 'string' ? appearance.locale.toLowerCase() : ''
  if (preference.startsWith('zh')) return 'zh'
  if (preference.startsWith('en')) return 'en'
  return zhLocale() ? 'zh' : 'en'
}

/** Menu and dialog copy follow the mirrored language, not the raw system locale. */
function menuZh(): boolean {
  return uiLanguage() === 'zh'
}

/** Point the helper's theme at the stored preference and push the resolved state. */
function applyAppearance(): void {
  nativeTheme.themeSource = appearance.theme ?? 'system'
  pushAppearance()
}

function pushAppearance(): void {
  const payload = { dark: nativeTheme.shouldUseDarkColors, locale: uiLanguage() }
  if (win && !win.isDestroyed()) win.webContents.send('orb:appearance', payload)
  overlays?.appearance(payload)
}

/**
 * The balance message the host sends: `{ cny, at }`, with `cny: null` for "not known".
 *
 * Anything else is "not known" too, and that is the point: this decides which face the ball rests in,
 * and an unreadable message must not be able to invent a number 鈥?least of all a zero, which is the
 * one value that turns the sad face on.
 */
function readBalanceMessage(record: unknown): { cny: number | null; at?: number } {
  const value = (typeof record === 'object' && record !== null ? record : {}) as { cny?: unknown; at?: unknown }
  const cny = typeof value.cny === 'number' && Number.isFinite(value.cny) && value.cny >= 0 ? value.cny : null
  return typeof value.at === 'number' && Number.isFinite(value.at) ? { cny, at: value.at } : { cny }
}

/** Hand the page the last balance it has not necessarily seen. */
function pushBalance(): void {
  if (balance === undefined) return
  if (win && !win.isDestroyed()) win.webContents.send('orb:balance', balance)
}

function readChrome(value: unknown): ChromeState {
  const record = value as {
    overlay?: MenuSelection
    background?: MenuSelection
    millifractionEnabled?: unknown
    reply?: unknown
    wakeEnabled?: unknown
    dictation?: unknown
    openMain?: unknown
    catalog?: MenuCatalog
    speech?: unknown
    chime?: unknown
  }
  return {
    overlay: selectionOr(record.overlay, chrome.overlay),
    background: selectionOr(record.background, chrome.background),
    millifractionEnabled: record.millifractionEnabled === true,
    reply: readReply(record.reply, chrome.reply),
    // The main window's composer owns a switch as well now, so this is no longer a mirror of what
    // the ball's menu said: it is whichever of the two last asked, and the `chrome` handler above
    // acts on it.
    wakeEnabled: typeof record.wakeEnabled === 'boolean' ? record.wakeEnabled : chrome.wakeEnabled,
    dictation: readDictationMessage(record.dictation),
    openMain: record.openMain === true,
    catalog: record.catalog ?? { groups: [] },
    speech: readSpeech(record.speech, chrome.speech),
    chime: readChime(record.chime, chrome.chime),
  }
}

/**
 * The dictation block from the host, field by field, or `undefined` when it sent none.
 *
 * Per-field for the same reason as {@link readSpeech}: an older host sends nothing and the launch
 * value keeps standing, while a partial update must not reset the fields it did not mention. The
 * clamp mirrors the host's own, so a hand-edited out-of-range `silenceMs` is bounded here too rather
 * than reaching the recorder as a window of zero frames.
 */
function readDictationMessage(value: unknown): DictationConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as { enabled?: unknown; silenceMs?: unknown; maxSeconds?: unknown; autoSend?: unknown; target?: unknown }
  const fallback = wake.dictation
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    silenceMs: typeof record.silenceMs === 'number' && Number.isFinite(record.silenceMs)
      ? Math.min(10_000, Math.max(300, Math.round(record.silenceMs)))
      : fallback.silenceMs,
    maxSeconds: typeof record.maxSeconds === 'number' && Number.isFinite(record.maxSeconds)
      ? Math.min(120, Math.max(2, Math.round(record.maxSeconds)))
      : fallback.maxSeconds,
    autoSend: typeof record.autoSend === 'boolean' ? record.autoSend : fallback.autoSend,
    target: record.target === 'panel' ? 'panel' : fallback.target,
  }
}

/**
 * Reply settings from the host, each field falling back independently.
 *
 * Per-field for the same reason as {@link readSpeech}: an older host sends nothing and the row
 * keeps the shipped defaults, while a partial update does not reset the other field.
 */
function readReply(value: unknown, fallback: ReplySettings): ReplySettings {
  if (typeof value !== 'object' || value === null) return fallback
  const record = value as { enabled?: unknown; maxReplyChars?: unknown }
  const cap = typeof record.maxReplyChars === 'number' && Number.isFinite(record.maxReplyChars)
    ? Math.round(record.maxReplyChars)
    : fallback.maxReplyChars
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    maxReplyChars: cap > 0 ? cap : fallback.maxReplyChars,
  }
}

/**
 * Speech settings from the host, each field falling back independently.
 *
 * Per-field rather than all-or-nothing on purpose: an older host that knows nothing about speech
 * sends no field at all and the ball keeps its defaults, while a host that sends a partial update
 * does not accidentally reset the other switches.
 */
function readSpeech(value: unknown, fallback: SpeechSettings): SpeechSettings {
  if (typeof value !== 'object' || value === null) return fallback
  const record = value as { enabled?: unknown; autoPlay?: unknown; endpoint?: unknown; voice?: unknown }
  const endpoint = typeof record.endpoint === 'string' && record.endpoint.trim() !== ''
    ? record.endpoint.trim()
    : fallback.endpoint
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    autoPlay: typeof record.autoPlay === 'boolean' ? record.autoPlay : fallback.autoPlay,
    endpoint,
    // Empty is a real value here — it means "whatever the service was started with" — so only a
    // missing or non-string field falls back.
    voice: typeof record.voice === 'string' ? record.voice.trim() : fallback.voice,
  }
}

/**
 * Chime settings from the host, each field falling back independently.
 *
 * The quiet window is clamped to 0鈥?4 here as well as on the host, because the row draws its
 * numbers straight from this record: an out-of-range value from a hand-edited file would be
 * printed in the menu before the page ever had a chance to correct it.
 */
function readChime(value: unknown, fallback: ChimeSettings): ChimeSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fallback
  const record = value as { enabled?: unknown; quietFrom?: unknown; quietTo?: unknown }
  const hour = (candidate: unknown, current: number): number =>
    typeof candidate === 'number' && Number.isFinite(candidate)
      ? Math.min(24, Math.max(0, Math.round(candidate)))
      : current
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    quietFrom: hour(record.quietFrom, fallback.quietFrom),
    quietTo: hour(record.quietTo, fallback.quietTo),
  }
}

function selectionOr(value: MenuSelection | undefined, fallback: MenuSelection): MenuSelection {
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return fallback
  return value
}

async function showMenu(window: BrowserWindow): Promise<void> {
  const template = contextMenuTemplate({
    catalog: chrome.catalog,
    overlay: chrome.overlay,
    background: chrome.background,
    millifractionEnabled: chrome.millifractionEnabled,
    replyEnabled: chrome.reply.enabled,
    replyMaxChars: chrome.reply.maxReplyChars,
    chimeEnabled: chrome.chime.enabled,
    chimeQuietFrom: chrome.chime.quietFrom,
    chimeQuietTo: chrome.chime.quietTo,
    // The chime is spoken by the read-aloud service, so the row needs it: without one there is
    // nothing to speak the time, and a checked row that does nothing is the failure this label
    // exists to avoid.
    speechEnabled: chrome.speech.enabled,
    speechVoice: chrome.speech.voice,
    speechVoices: [...SPEECH_VOICES, ...clonedVoices()],
    wakeEnabled: wakeWanted && wakeReady,
    wakeAvailable: wakeReady,
    wakeWord: spokenName(wake.keyword),
    wakeKeyword: wake.keyword,
    wakeKeywords: wakeKeywordOptions(),
    wakeEngine: wake.engine,
    wakeEngines: wakeEngineOptions(),
    // The recorder runs on the wake engine's microphone, so the row needs a live engine.
    dictationReady: wakeWanted && wakeReady && wake.dictation.enabled,
    openMain: chrome.openMain,
  }, menuZh(), {
    openMain: () => { write({ type: 'open-main' }) },
    setOverlay: (selection) => { write({ type: 'set-overlay', selection }) },
    setBackground: (selection) => { write({ type: 'set-background', selection }) },
    setMillifraction: (enabled) => { void confirmMillifraction(window, enabled) },
    setReply: (enabled) => { write({ type: 'set-reply', enabled }) },
    setChime: (enabled) => { write({ type: 'set-chime', enabled }) },
    setSpeechVoice: (voice) => { write({ type: 'set-speech-voice', voice }) },
    setWake: (enabled) => { if (enabled) enableWake(); else disableWake() },
    setWakeWord: (keyword) => { write({ type: 'set-wake-word', keyword }) },
    setWakeEngine: (engine) => { write({ type: 'set-wake-engine', engine }) },
    dictate: () => {
      if (win && !win.isDestroyed()) win.webContents.send('orb:dictate')
    },
    disable: () => { write({ type: 'disable' }) },
  })
  Menu.buildFromTemplate(template).popup({ window })
}

/**
 * The wake words the menu may offer, each marked with whether its model is on disk.
 *
 * Checked here rather than in the host: the asset directory is the helper's, and the page can only
 * load a file the helper is already serving. Read on every menu open so a freshly deployed model
 * appears without a relaunch, and a missing one is visibly disabled instead of failing on click.
 *
 * The list itself depends on the engine: the decoder has no per-word model to look for (its phrase is
 * a token line in `assets/kws`), and it has no English phrase at all, so it offers a shorter list.
 */
function wakeKeywordOptions(): WakeKeywordOption[] {
  return ENGINE_KEYWORDS[wake.engine].map((keyword) => ({
    keyword,
    spoken: spokenName(keyword),
    available: keywordAvailable(wake.engine, keyword),
  }))
}

/** Whether one phrase has what its engine needs, for the engine currently configured. */
function keywordAvailable(engine: WakeEngineId, keyword: string): boolean {
  if (engine === 'sherpa') return existsSync(join(assetsRoot, 'kws', `keywords-${keyword}.txt`))
  const directory = wake.assetDirectory
  return directory !== '' && existsSync(join(directory, keywordFile(keyword)))
}

/** Every engine this build can offer, in menu order, with availability computed per engine. */
function wakeEngineOptions(): WakeEngineOption[] {
  return WAKE_ENGINES.map((engine) => ({
    engine,
    available: wakeAvailable({ ...wake, engine, keyword: ENGINE_KEYWORDS[engine].includes(wake.keyword)
      ? wake.keyword
      : ENGINE_KEYWORDS[engine][0] ?? wake.keyword }, assetsRoot),
  }))
}

async function confirmMillifraction(window: BrowserWindow, enabled: boolean): Promise<void> {
  if (enabled === chrome.millifractionEnabled) return
  const zh = menuZh()
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    message: zh ? '新编码只在新对话中生效。' : 'The new encoding takes effect in a new conversation.',
    detail: zh
      ? '当前对话不变，仍可从历史记录打开。取消不写入、不新建。'
      : 'The current conversation stays unchanged and remains in History. Cancel leaves the default and this chat as they are.',
    buttons: zh ? ['取消', '新建对话'] : ['Cancel', 'Create new conversation'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  })
  if (response !== 1) return
  write({ type: 'set-millifraction', enabled })
}

async function loadAvatar(choice: AvatarChoice): Promise<void> {
  const tokenId = ++avatarToken
  if (!win) return
  if (choice.kind === 'default') {
    win.webContents.send('orb:avatar', '')
    return
  }
  const image = await fetchAvatar(choice.version)
  if (tokenId !== avatarToken || !win || !image) return
  win.webContents.send('orb:avatar', `data:${image.mime};base64,${image.body.toString('base64')}`)
}

function fetchAvatar(version: number): Promise<{ mime: string; body: Buffer } | undefined> {
  const port = Number(webPort)
  if (!Number.isInteger(port) || port <= 0 || !token) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/.dsh-orb/avatar?v=${Math.trunc(version)}`,
      method: 'GET',
      headers: { 'x-dsh-orb-helper': token },
    }, (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2_500_000) {
          req.destroy()
          resolve(undefined)
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve(undefined)
          return
        }
        const mime = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'].split(';')[0] : 'image/gif'
        resolve({ mime: mime ?? 'image/gif', body: Buffer.concat(chunks) })
      })
    })
    req.setTimeout(5000, () => {
      req.destroy()
      resolve(undefined)
    })
    req.on('error', () => resolve(undefined))
    req.end()
  })
}
