/**
 * Floating ball window. The official dsh process owns the session; this process only draws and forwards one socket.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { createConnection, type Socket } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAvatarChoice, type AvatarChoice } from './avatar.ts'
import { collectChromeWindowIds, type NativeHandleWindow } from './chrome-windows.ts'
import { FloatingPlacement, initialWindowBounds } from './geometry.ts'
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
let live: Socket | undefined
let quitting = false
let buffer = ''

app.on('before-quit', () => {
  quitting = true
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
  }, () => screen.getAllDisplays().map((display) => display.bounds))
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
 * The corner the ball is about to be given, asked before the window grows into it.
 *
 * A no-op for the window: the answer is the whole point. It exists so the page can wear the
 * corner while the window is still ball-sized, where it costs no pixels at all, rather than
 * learning it from the resize's own return value — which is one frame too late to keep the ball
 * still. See {@link FloatingPlacement.expandCorner}.
 */
ipcMain.handle('orb:expand-corner', (event) => {
  if (!fromBall(event) || !placement) return null
  return placement.expandCorner()
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
