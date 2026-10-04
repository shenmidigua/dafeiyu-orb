/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAvatarChoice, type AvatarChoice } from './avatar.ts'
import { collectChromeWindowIds, type NativeHandleWindow } from './chrome-windows.ts'
import { FloatingPlacement, initialBallOrigin, initialWindowBounds } from './geometry.ts'
import { createMemePicker, type MemePicker } from './memes.ts'
import { contextMenuTemplate } from './menu.ts'
import { attachOverlays, denyWindowPermissions } from './overlays.ts'
import { type MenuCatalog, type MenuSelection } from './model-menu.ts'
import {
  readWakeConfig,
  registerWakeScheme,
  serveWakeAssets,
  wakeAvailable,
  WAKE_SCHEME,
  type WakeConfig,
} from './wake.ts'

const socketAddress = process.env.DSH_ORB_SOCKET ?? ''
const token = process.env.DSH_ORB_TOKEN ?? ''
const webPort = process.env.DSH_ORB_WEB_PORT ?? ''

/** Wake-word settings the host seeded at launch. */
const wake: WakeConfig = readWakeConfig()

// The ball's page loads its ONNX models and the wasm runtime over a private scheme.
// Privileges have to be declared before the app is ready.
registerWakeScheme()

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
  wakeEnabled: boolean
  openMain: boolean
  catalog: MenuCatalog
  speech: SpeechSettings
}

/**
 * Read-aloud settings owned by the settings page and pushed in every `chrome` message.
 *
 * The defaults are off: a profile that has never opened the settings page has no TTS service
 * behind it, and a play button that always fails is worse than no button. The endpoint travels
 * with the switch so moving the service to another port needs no rebuild.
 */
interface SpeechSettings {
  enabled: boolean
  autoPlay: boolean
  endpoint: string
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
  wakeEnabled: false,
  openMain: false,
  catalog: { groups: [] },
  speech: { enabled: false, autoPlay: false, endpoint: 'http://127.0.0.1:8765' },
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
 * owned by the pointer poll — see {@link setHitTest}.
 */
let hitTestOver = false
/**
 * The screen rectangles that capture the mouse: the ball, the open panel, the stop cap and the
 * docked tab, as last laid out by the page. Empty until the page reports, which means the window
 * is click-through until then — the safe direction, since a ball that cannot be clicked is a
 * smaller problem than a window that eats every click on the desktop.
 */
let hitTestRegions: Array<{ x: number; y: number; width: number; height: number }> = []
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
  wakeReady = wakeAvailable(wake)
  serveWakeAssets(wake)
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

// ── wake word ────────────────────────────────────────────────────────────────
//
// The engine lives in the ball's page (`assets/wake.js`); this process only owns the
// switch, the model route, and the status relay. Nothing here scores audio.

ipcMain.handle('orb:wake-config', (event) => {
  if (!fromBall(event)) return wakePayload(false)
  return wakePayload(wakeWanted && wakeReady)
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
 * Live engine state, for the ball's status line and for the host's own log.
 * @param event - the IPC event, checked to come from the ball.
 * @param status - `{ state, detail, keyword, threshold, frames, peak }` as reported.
 */
ipcMain.handle('orb:wake-report', (event, status) => {
  if (!fromBall(event)) return false
  const record = status !== null && typeof status === 'object' ? status as Record<string, unknown> : {}
  const state = typeof record.state === 'string' ? record.state : ''
  if (state === 'error' && typeof record.detail === 'string' && record.detail !== '') {
    console.error(`dsh-orb helper: wake word stopped: ${record.detail}`)
  }
  return true
})

// ── read-aloud service ───────────────────────────────────────────────────────
//
// The TTS model takes ~33 s to load and holds ~5 GB of VRAM, so the service has to be resident
// rather than started per request — and starting it is not something the page can do, because the
// page is a `file://` document whose CSP only lets it talk to the local port once something is
// listening there. So the launch belongs to this process, and it happens on demand: the first
// play that finds nothing answering starts the service and waits for it.
//
// `DSH_ORB_TTS_LAUNCH` overrides the command line; an empty value disables launching entirely, so
// a profile that expects to start the service itself is not fought by the ball.

/**
 * How long a freshly launched service may take to answer before the wait is treated as a failure.
 * Comfortably past the measured ~33 s model load, because the first start also reads 5 GB cold.
 */
const SPEECH_START_TIMEOUT_MS = 180_000
/** Health probes are local and cheap; anything slower than this is not our service answering. */
const SPEECH_PROBE_TIMEOUT_MS = 1_500
/** Gap between health probes while the model loads. */
const SPEECH_PROBE_INTERVAL_MS = 2_000

const speechLaunch = (process.env.DSH_ORB_TTS_LAUNCH
  ?? 'D:\\tools\\indextts\\start_server.cmd').trim()

/**
 * The command interpreter to run the launcher with.
 *
 * Absolute, because a bare `cmd.exe` depends on PATH — and this process's PATH does not reliably
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
      // `cmd.exe` so the configured value can be a command line rather than a single executable —
      // and deliberately **not** `detached`. Detaching was tried first and it is what put a black
      // console window on screen.
      //
      // A detached process is created without a console. `cmd.exe` is a console program, so it runs
      // console-less and the `python.exe` inside it allocates a console of its own — and a console a
      // process allocates for itself is not covered by the hide request that travelled with
      // `CreateProcess`. Measured here by starting the same `cmd.exe -> python.exe` pair once per
      // flag set (`dsh_orb/window_flags_probe.py`):
      //
      //   DETACHED_PROCESS                  1 visible ConsoleWindowClass window   ← the black box
      //   STARTF_USESHOWWINDOW + SW_HIDE    0 windows, 0 conhost processes        ← what we want
      //   CREATE_NO_WINDOW                  0 windows, 1 conhost, none visible
      //   CREATE_NEW_CONSOLE + SW_HIDE      0 windows, 1 conhost, none visible
      //
      // `windowsHide: true` without `detached` is the second row: no extra launcher, no extra
      // process, nothing to see. Dropping `detached` costs nothing either — Windows does not kill a
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
 * question for it — but it is asked for geometry, not for a verdict on the pointer. The verdict is
 * made here, from the pointer's actual position, because a click-through window delivers no mouse
 * events to the renderer and so the page could never reach one. See {@link setHitTest}.
 */
ipcMain.on('orb:hit-test', (event, regions) => {
  if (!fromBall(event)) return
  hitTestRegions = Array.isArray(regions)
    ? regions.filter(isRect).map((region) => ({ x: region.x, y: region.y, width: region.width, height: region.height }))
    : []
  // The pointer may already be over the new regions — a panel opening under it, say — and the poll
  // only runs every 30ms, so re-decide now rather than leaving a frame where a click would fall
  // through a panel that is already there.
  if (win && !win.isDestroyed()) setHitTest(win, overCapturedRegion(screen.getCursorScreenPoint()))
})

function isRect(value: unknown): value is { x: number; y: number; width: number; height: number } {
  if (value === null || typeof value !== 'object') return false
  const rect = value as Record<string, unknown>
  return ['x', 'y', 'width', 'height'].every((key) => typeof rect[key] === 'number' && Number.isFinite(rect[key]))
}

/**
 * The corner the ball is in right now, for the page to wear before it draws anything.
 * Answers a question and changes nothing — see {@link FloatingPlacement.currentDirection}.
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

ipcMain.handle('orb:meme-done', (event) => {
  if (!fromBall(event)) return null
  return picker().done()
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
    // Editable text and an active selection get the native menu (Copy/Paste);
    // bare right-click still opens the ball's own menu.
    if (params?.isEditable || params?.hasSelection) return
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
  if (record.type === 'reset') {
    win.webContents.send('orb:reset')
    return
  }
  if (record.type === 'chrome') {
    chrome = readChrome(record)
    // Straight to the page: the read-aloud buttons have to appear and disappear as the settings
    // page flips the switch, with no reload and no menu round-trip.
    if (win && !win.isDestroyed()) win.webContents.send('orb:speech', chrome.speech)
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
  if (record.type === 'tcc') {
    const wait = tccWait
    tccWait = undefined
    wait?.((record as { status?: unknown }).status)
  }
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
 * the flag, so a window set to `setIgnoreMouseEvents(true, { forward: true })` — the only mode
 * this window ever uses — reads back in a way that does not distinguish the two states. A plain
 * boolean is both unambiguous and assertable from a test.
 */
/**
 * The regions of the window that capture the mouse: the ball, the panel, the stop cap and the
 * docked tab. Everything else in the window is empty space and has to be transparent to clicks.
 *
 * This is decided here rather than by the page, which is the reversal of the obvious arrangement
 * and worth recording why. The page knows where its elements ended up, but it cannot be *asked*:
 * the window is click-through whenever the pointer is off them, and a click-through window on this
 * platform delivers no `mousemove` to the renderer at all — not even with `forward: true`, which
 * was measured, not assumed (the page's own move counter stayed at zero while the pointer crossed
 * the ball). So a page that reports "the pointer is on me" can never find out, and the window
 * stays permanently transparent with a ball nothing can click.
 *
 * The main process has no such problem: `screen.getCursorScreenPoint` reads the pointer whatever the
 * window is doing. What it needs from the page is the *geometry* — where the ball and the panel
 * actually are — which the page can report once per layout, and which does not change while the
 * pointer is moving.
 */
const CAPTURE_MARGIN = 8

function setHitTest(target: BrowserWindow, over: boolean): void {
  if (target.isDestroyed()) return
  if (hitTestOver === over) return
  hitTestOver = over
  target.setIgnoreMouseEvents(!over, { forward: true })
  // Tell the page which side of the line the pointer crossed, with its position in the page's own
  // coordinates. The page listens for `pointerenter`/`pointerleave` to open and close the panel,
  // and on a real hand those are enough — but the events describe movement, and a pointer that
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

/** Whether a point is inside any of the regions the page last reported. */
function overCapturedRegion(point: { x: number; y: number }): boolean {
  for (const region of hitTestRegions) {
    if (point.x >= region.x - CAPTURE_MARGIN && point.x <= region.x + region.width + CAPTURE_MARGIN
      && point.y >= region.y - CAPTURE_MARGIN && point.y <= region.y + region.height + CAPTURE_MARGIN) {
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
 * window is capturing before a click can land — a click is a press and a release at the same place,
 * so it needs the state right at the moment of the press — and slow enough to be invisible next to
 * the work this process already does.
 */
function startHitTestPoll(): void {
  if (hitTestTimer !== undefined) return
  hitTestTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    setHitTest(win, overCapturedRegion(screen.getCursorScreenPoint()))
  }, 33)
}

/** What the ball's page needs before it starts the engine. */
function wakePayload(enabled: boolean): Record<string, unknown> {
  return {
    enabled,
    ready: wakeReady,
    hasAssets: wake.assetDirectory !== '',
    keyword: wake.keyword,
    threshold: wake.threshold,
    autoExpandOnWake: wake.autoExpandOnWake,
    dictation: wake.dictation,
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
  win.webContents.send('orb:wake', { type: 'enabled' })
  write({ type: 'set-wake', enabled: true })
  return true
}

/** Turn it off: the page releases the microphone, the host remembers that too. */
function disableWake(): boolean {
  wakeWanted = false
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

function readChrome(value: unknown): ChromeState {
  const record = value as {
    overlay?: MenuSelection
    background?: MenuSelection
    millifractionEnabled?: unknown
    wakeEnabled?: unknown
    openMain?: unknown
    catalog?: MenuCatalog
    speech?: unknown
  }
  return {
    overlay: selectionOr(record.overlay, chrome.overlay),
    background: selectionOr(record.background, chrome.background),
    millifractionEnabled: record.millifractionEnabled === true,
    // Informational only: the ball's menu owns the switch, and it has already told
    // the host about every change, so the host's value just mirrors it back.
    wakeEnabled: chrome.wakeEnabled,
    openMain: record.openMain === true,
    catalog: record.catalog ?? { groups: [] },
    speech: readSpeech(record.speech, chrome.speech),
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
  const record = value as { enabled?: unknown; autoPlay?: unknown; endpoint?: unknown }
  const endpoint = typeof record.endpoint === 'string' && record.endpoint.trim() !== ''
    ? record.endpoint.trim()
    : fallback.endpoint
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : fallback.enabled,
    autoPlay: typeof record.autoPlay === 'boolean' ? record.autoPlay : fallback.autoPlay,
    endpoint,
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
    wakeEnabled: wakeWanted && wakeReady,
    wakeAvailable: wakeReady,
    // The recorder runs on the wake engine's microphone, so the row needs a live engine.
    dictationReady: wakeWanted && wakeReady && wake.dictation.enabled,
    openMain: chrome.openMain,
  }, menuZh(), {
    openMain: () => { write({ type: 'open-main' }) },
    setOverlay: (selection) => { write({ type: 'set-overlay', selection }) },
    setBackground: (selection) => { write({ type: 'set-background', selection }) },
    setMillifraction: (enabled) => { void confirmMillifraction(window, enabled) },
    setWake: (enabled) => { if (enabled) enableWake(); else disableWake() },
    dictate: () => {
      if (win && !win.isDestroyed()) win.webContents.send('orb:dictate')
    },
    disable: () => { write({ type: 'disable' }) },
  })
  Menu.buildFromTemplate(template).popup({ window })
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
  if (choice.kind === 'preset') {
    // A shipped GIF: the page loads the file itself, no socket payload involved.
    win.webContents.send('orb:avatar', choice.src)
    return
  }
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
