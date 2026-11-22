/**
 * Settings routes on the official web port.
 * The main window calls these with a relative fetch, so the existing login cookie is enough.
 * The helper may read only the avatar, and only with its socket token.
 */

import { timingSafeEqual } from 'node:crypto'
import { appendFileSync, createReadStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeCatalog, type ModelCatalog } from './catalog.ts'
import {
  DICTATION_NO_SPEECH_MS,
  isAgentModelSelection,
  isSpeechEndpoint,
  isSpeechVoice,
  MAX_AVATAR_BYTES,
  MAX_SILENCE_MS,
  MIN_SILENCE_MS,
  sniffAvatarMime,
  type AgentModelSelection,
  type ProfileStore,
  type SpeechSettings,
} from './preferences.ts'
import { selectionRuntimeAvailable } from '@dsh-orb/native-selection'
import { defaultAvatarPath } from './helper-path.ts'
import { isTccRight, type TccMonitor, type TccStatus } from './tcc.ts'
import { discoverWakeAssets, readWakeDirectory, resolveWakeAsset, wakeAssetMime } from './wake-assets.ts'

const PREFIX = '/.dsh-orb'
const HELPER_HEADER = 'x-dsh-orb-helper'
const WAKE_PREFIX = `${PREFIX}/wake-assets/`
/**
 * The longest sentence one voice turn may hand to {@link OrbControl.sendVoiceText}.
 *
 * A dictation ceiling, not a document's: the recorder stops after `maxSeconds` and the transcriber
 * returns a sentence. Anything far past this is a caller that is not the page, and a conversation
 * turn is the wrong place to discover it.
 */
const MAX_VOICE_TEXT = 6_000

interface RouteContext {
  readonly webServer: {
    register(route: {
      kind: 'prefix'
      path: string
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
    }): () => void
  }
  readonly connection: {
    admit?(request: IncomingMessage): { rejection?: number } | { peer?: unknown }
    isAuthenticated?(request: IncomingMessage): boolean
  }
  readonly sessionController: {
    modelCatalog(): unknown
  }
}

/**
 * One wake-word hand-off, consumed by the main window's page.
 *
 * The page is the one that presses the main window's microphone button; this is the whole of
 * what the host tells it. The numbers are the black panel's own limits (`orb-wake.json`) and
 * `send` is its own rule, so the main-window path does not grow a second set of thresholds.
 */
export interface MainVoiceCommand {
  readonly start: true
  /** How long the microphone waits for the first word before it closes itself. */
  readonly noSpeechMs: number
  /** The pause after speech that ends the turn. */
  readonly silenceMs: number
  /** The hard ceiling, seconds. */
  readonly maxSeconds: number
  /** Whether the transcript is sent, or only left in the main window's draft. */
  readonly send: boolean
  /**
   * Whether the exchange continues after the reply: the page opens the microphone again on its
   * own, the way the ball does, so the next sentence needs no wake word.
   */
  readonly continuous: boolean
  /** The pause between a finished reply and that re-opening, milliseconds. */
  readonly followUpMs: number
  /**
   * The conversation these words belong to, when one is pinned for voice turns.
   *
   * Present means "post the transcript to the host": the page then writes nothing into the composer
   * of the window the user is looking at, because the turn is not that window's. Absent is the
   * ordinary hand-off, unchanged — the words land in the visible conversation.
   */
  readonly sendTo?: string
}

/** Side effects that have to reach the live ball. */
export interface OrbControl {
  helperAuthorized(token: string): boolean
  publishChrome(): Promise<void>
  setOverlayModel(selection: AgentModelSelection): Promise<void>
  setBackgroundModel(selection: AgentModelSelection): Promise<void>
  setSelectionEnabled(enabled: boolean): Promise<void>
  setMillifractionEnabled(enabled: boolean): Promise<void>
  setBallEnabled(enabled: boolean): Promise<void>
  /** The ball asked for wake-word detection to be turned on or off. */
  setWakeEnabled(enabled: boolean): Promise<void>,
  /** The settings page changed the read-aloud switches or the service endpoint. */
  setSpeech(settings: SpeechSettings): Promise<void>
  /**
   * The settings page moved the "finished speaking" pause, in milliseconds.
   *
   * The store writes `orb-wake.json` and the ball is told on the `chrome` broadcast, so the next
   * utterance already ends on the new value — no relaunch of the helper, which would drop the panel
   * the user is looking at.
   */
  setWakeSilence(silenceMs: number): Promise<void>
  /**
   * The wake-word hand-off waiting for the main window's page, or `null` when there is none.
   *
   * The page polls this from the main window. Whoever calls it consumes the hand-off, so a page
   * reload between turns cannot press the microphone a second time.
   */
  takeMainVoice(): MainVoiceCommand | null
  /**
   * How the turn the main window ran ended, once it is over.
   *
   * The other half of {@link takeMainVoice}: a hand-off the page heard nothing on is a panel the
   * ball opened for nothing, and only the page knows the difference between "no words" and "words
   * on their way". `sent` and `draft` leave something in the main window; `empty`, `closing` and
   * `failed` are the panel folding back.
   *
   * `routed` marks a turn whose words were delivered to another conversation: the ball then ends
   * the continuous exchange instead of handing the microphone back, because the reply it is reading
   * came from a window this page cannot watch.
   */
  noteVoiceResult(outcome: string, routed?: boolean): void
  /**
   * Transcribe one utterance the main window's page recorded itself.
   *
   * The composer's microphone button runs the ball's recorder — it opens the device, measures the
   * level and decides when the sentence ended — and posts the finished WAV here, so the words are
   * produced by the same service as the ball's. Returns the reason on failure rather than throwing.
   */
  transcribe(audio: Buffer): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  /**
   * Send one voice turn's words into the pinned conversation, as a new turn there.
   *
   * The counterpart of `MainVoiceCommand.sendTo`: the page recorded the sentence and transcribed
   * it, and this puts it where the user asked every wake-word turn to go, without switching any
   * window. Never throws — a missing conversation comes back as `ok: false` with a reason the
   * page can read out.
   */
  sendVoiceText(text: string): Promise<{ ok: boolean; reason?: string }>
  /** Which conversation that lookup currently finds, for the diagnosis route. */
  voiceTargetInfo(): Promise<{ title: string; sessionId: string | null }>
  helperStatus?(): string
}

interface RouteDeps {
  readonly ctx: RouteContext
  readonly store: ProfileStore
  readonly tcc: TccMonitor
  readonly control: OrbControl
  /** Where the main window's diagnosis beacon lands. Defaults to the plugin's own folder. */
  readonly reportPath?: string
}

/** Mount `/.dsh-orb` and return the disposer. */
export function registerOrbRoutes(deps: RouteDeps): () => void {
  return deps.ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    // The handler is async, and a rejection used to go nowhere: the request would hang until the
    // page gave up, and the composer's microphone — which posts its WAV here and waits for the
    // words — would stay busy forever. Every route now answers, even the ones that threw.
    handler: async (req, res) => {
      try {
        await handle(deps, req, res)
      } catch {
        try {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: '内部错误' }))
        } catch {
          // The socket is already gone; there is nobody left to tell.
        }
      }
    },
  })
}

export function orbSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

async function handle(deps: RouteDeps, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const helperAvatar = path === `${PREFIX}/avatar` && req.method === 'GET' && helperTokenOk(deps, req)
  if (!helperAvatar) {
    const rejection = rejectionStatus(deps.ctx, req)
    if (rejection !== undefined) {
      res.writeHead(rejection)
      res.end()
      return
    }
  }
  const method = req.method ?? 'GET'
  // Wake-word models. The ball is a `file://` page with no session cookie, so this
  // route authenticates with the helper socket token exactly like the avatar route.
  if ((method === 'GET' || method === 'HEAD') && path.startsWith(WAKE_PREFIX)) {
    await sendWakeAsset(deps, req, res, path, method)
    return
  }
  if (method === 'GET' && path === `${PREFIX}/settings`) {
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/main-voice`) {
    // Polled by the main window's page while it is open. `{ start: false }` is the ordinary
    // answer; a hand-off is returned once and then consumed, so a reload cannot press the
    // microphone a second time. See `MainVoiceCommand` and `Orb.takeMainVoice`.
    sendJson(res, 200, deps.control.takeMainVoice() ?? { start: false })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/voice-target`) {
    // One line to answer "where will my voice turn go", without speaking into a microphone: the
    // title that is looked for and the conversation it currently resolves to, or null.
    sendJson(res, 200, await deps.control.voiceTargetInfo())
    return
  }
  if (method === 'POST' && path === `${PREFIX}/voice-send`) {
    // The page recorded a wake turn and the hand-off named a conversation. The words arrive here
    // rather than in the composer, so nothing is typed into a window the user is not using.
    const body = asRecord(await readJson(req))
    const text = typeof body?.text === 'string' ? body.text.trim() : ''
    if (text === '' || text.length > MAX_VOICE_TEXT) {
      sendJson(res, 400, { ok: false, reason: 'empty-or-too-long' })
      return
    }
    const result = await deps.control.sendVoiceText(text)
    sendJson(res, result.ok ? 200 : 409, result)
    return
  }
  if (method === 'GET' && path === `${PREFIX}/models`) {
    sendJson(res, 200, await catalog(deps))
    return
  }
  if (method === 'GET' && path === `${PREFIX}/wake`) {
    // The main window's composer switch reads this when it mounts, so a reload shows the switch the
    // helper is actually listening on rather than a default. The rest of the wake block stays on
    // `GET /settings`; this is the one field the composer changes.
    sendJson(res, 200, { enabled: deps.store.wake().enabled })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/dictation`) {
    // What the composer's own microphone button records with: the same numbers the black panel
    // writes, so the two recorders cannot drift apart. Read once per press rather than cached, so
    // moving the pause slider in settings takes effect on the next sentence.
    const wake = deps.store.wake()
    sendJson(res, 200, {
      silenceMs: wake.dictation.silenceMs,
      maxSeconds: wake.dictation.maxSeconds,
      autoSend: wake.dictation.autoSend,
      noSpeechMs: DICTATION_NO_SPEECH_MS,
    })
    return
  }
  if (method === 'GET' && path === `${PREFIX}/tcc`) {
    sendJson(res, 200, deps.tcc.status())
    return
  }
  if ((method === 'GET' || method === 'HEAD') && path === `${PREFIX}/avatar`) {
    await sendAvatar(deps.store, method, res)
    return
  }
  if (!orbSupported()) {
    sendJson(res, 403, { error: 'unsupported' })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/transcribe`) {
    // The composer's microphone button recorded the sentence itself and posts the WAV. One
    // utterance is a few hundred kilobytes at 16 kHz mono; the cap is the transcriber's own
    // `MAX_AUDIO_BYTES` with room for the RIFF header, and a body past it is a client bug rather
    // than a long sentence.
    let audio: Buffer
    try {
      audio = await readBody(req, 8 * 1024 * 1024)
    } catch {
      sendJson(res, 413, { error: '录音太长' })
      return
    }
    let result: Awaited<ReturnType<OrbControl['transcribe']>>
    try {
      result = await deps.control.transcribe(audio)
    } catch {
      // The transcriber is a service on this machine; when it is not up, the words are the one
      // thing missing and the page needs a reason to say so rather than a request that never ends.
      sendJson(res, 500, { error: '语音识别服务没有响应' })
      return
    }
    sendJson(res, 200, result.ok ? { text: result.text } : { error: result.reason })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/main-voice-result`) {
    // Whoever recorded the turn posts its ending here. The ball cannot see the main window's
    // microphone, so this line is the only thing that tells it the exchange it opened for is over
    // without a word — see `OrbControl.noteVoiceResult`.
    const body = await readJson(req)
    const outcome = body !== null && typeof body === 'object' && typeof (body as { outcome?: unknown }).outcome === 'string'
      ? (body as { outcome: string }).outcome
      : ''
    if (outcome === '') {
      sendJson(res, 400, { error: 'invalid-outcome' })
      return
    }
    // The turn's words went to another conversation, so the ball must not keep the continuous
    // exchange alive for it; see `OrbControl.noteVoiceResult`.
    const routed = (body as { routed?: unknown }).routed === true
    deps.control.noteVoiceResult(outcome, routed)
    sendJson(res, 200, { ok: true })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/client-report`) {
    // A beacon from the main window's page. The composer switch is a slot occupant this plugin
    // registers, and a missing switch has two very different causes: the page never ran this
    // plugin's client code, or the slot never rendered it. Writing down what the page saw tells
    // the two apart without attaching a debugger to a running window.
    const report = await readJson(req)
    const file = deps.reportPath ?? join(homedir(), '.dsh', 'dsh-orb', 'client-report.json')
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(report, null, 1)}\n`, 'utf8')
    } catch {
      // Diagnostics must never fail the page that sent them.
    }
    // The newest report overwrites the file, which is what a one-shot beacon wants; the voice
    // hand-off sends a line per step, so it also goes to the rolling log where the earlier steps
    // survive. A test passes its own `reportPath` and must not touch the real log.
    if (deps.reportPath === undefined) {
      try {
        const seen = report as Record<string, unknown> | null
        const note = seen !== null && typeof seen === 'object' && typeof seen.note === 'string'
          ? seen.note
          : JSON.stringify(report)
        appendFileSync(join(homedir(), '.dsh', 'dsh-orb', 'stream.log'),
          `${new Date().toISOString()} page: ${note}\n`)
      } catch {
        // Same rule as above: a readout is not worth failing a request over.
      }
    }
    sendJson(res, 200, { ok: true })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/overlay-model`) {
    const selection = selectionFrom(await readJson(req))
    if (selection === undefined) {
      sendJson(res, 400, { error: 'invalid-model' })
      return
    }
    await deps.control.setOverlayModel(selection)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/background-model`) {
    const selection = selectionFrom(await readJson(req))
    if (selection === undefined) {
      sendJson(res, 400, { error: 'invalid-model' })
      return
    }
    await deps.control.setBackgroundModel(selection)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/selection`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-selection' })
      return
    }
    await deps.control.setSelectionEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/millifraction`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-millifraction' })
      return
    }
    await deps.control.setMillifractionEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/ball`) {
    const enabled = booleanField(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-ball' })
      return
    }
    await deps.control.setBallEnabled(enabled)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/speech`) {
    const speech = await readJson(req)
    const next = speechUpdate(speech, deps.store.speech())
    if (next === undefined) {
      sendJson(res, 400, { error: 'invalid-speech' })
      return
    }
    await deps.control.setSpeech(next)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/wake`) {
    const enabled = enabledFrom(await readJson(req))
    if (enabled === undefined) {
      sendJson(res, 400, { error: 'invalid-wake' })
      return
    }
    await deps.control.setWakeEnabled(enabled)
    sendJson(res, 200, { enabled })
    return
  }
  if (method === 'POST' && path === `${PREFIX}/wake/silence`) {
    const silenceMs = silenceFrom(await readJson(req))
    if (silenceMs === undefined) {
      sendJson(res, 400, { error: 'invalid-silence' })
      return
    }
    await deps.control.setWakeSilence(silenceMs)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/avatar`) {
    const bytes = await readBody(req, MAX_AVATAR_BYTES + 1).catch((error: unknown) => {
      if (error instanceof Error && error.message === 'too-large') return undefined
      throw error
    })
    if (bytes === undefined || bytes.length > MAX_AVATAR_BYTES) {
      sendJson(res, 413, { error: 'too-large' })
      return
    }
    const mime = sniffAvatarMime(bytes)
    if (mime === undefined) {
      sendJson(res, 400, { error: 'invalid-type' })
      return
    }
    deps.store.writeAvatar(bytes, mime)
    await deps.control.publishChrome()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/avatar/restore`) {
    deps.store.restoreAvatar()
    await deps.control.publishChrome()
    sendJson(res, 200, await snapshot(deps))
    return
  }
  if (method === 'POST' && path === `${PREFIX}/tcc`) {
    const right = asRecord(await readJson(req))?.right
    if (!isTccRight(right)) {
      sendJson(res, 400, { error: 'invalid-tcc' })
      return
    }
    await deps.tcc.open(right)
    sendJson(res, 200, await snapshot(deps))
    return
  }
  res.writeHead(404)
  res.end()
}

async function snapshot(deps: RouteDeps): Promise<{
  supported: boolean
  ballEnabled: boolean
  avatarUrl: string
  overlay: AgentModelSelection
  background: AgentModelSelection
  selectionEnabled: boolean
  millifractionEnabled: boolean
  speech: SpeechSettings
  /** The voice-recognition block: the settings page's slider renders `silenceMs` as seconds. */
  dictation: { enabled: boolean; silenceMs: number; maxSeconds: number; autoSend: boolean }
  tcc: TccStatus
  helperError: string
  selectionAvailable: boolean
  permissionFallback: boolean
}> {
  const models = deps.store.models()
  const version = Math.trunc(deps.store.avatarVersion())
  const selection = deps.store.avatarSelection()
  return {
    supported: orbSupported(),
    ballEnabled: deps.store.ballEnabled(),
    avatarUrl: `${PREFIX}/avatar?v=${version}`,
    overlay: models.overlay,
    background: models.background,
    selectionEnabled: deps.store.selectionEnabled(),
    millifractionEnabled: deps.store.millifractionEnabled(),
    speech: deps.store.speech(),
    dictation: deps.store.wake().dictation,
    tcc: deps.tcc.status(),
    helperError: deps.control.helperStatus?.() ?? '',
    selectionAvailable: selectionRuntimeAvailable(),
    permissionFallback: deps.store.permissionFallback(),
  }
}

/**
 * Serve one wake-word asset to the ball.
 *
 * `?token=` is accepted alongside the header because the request comes from a page:
 * `fetch` can set no custom header the page does not already own, and the token is
 * already in the ball's environment. Both forms are compared in constant time.
 * @param deps - route dependencies, for the token check and the settings file.
 * @param req - the incoming request.
 * @param res - the response, owned end to end by this handler.
 * @param path - the request pathname, already known to start with the wake prefix.
 * @param method - `GET` or `HEAD`.
 */
async function sendWakeAsset(
  deps: RouteDeps,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
): Promise<void> {
  if (!wakeTokenOk(deps, req)) {
    res.writeHead(403)
    res.end()
    return
  }
  const settings = deps.store.wake()
  const root = settings.assetDirectory !== ''
    ? readWakeDirectory(settings.assetDirectory, settings.keyword)
    : discoverWakeAssets(settings.keyword)
  if (root === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  const relative = decodeURIComponent(path.slice(WAKE_PREFIX.length))
  const target = resolveWakeAsset(root, relative, settings.keyword)
  if (target === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  let info
  try {
    info = await stat(target)
  } catch {
    res.writeHead(404)
    res.end()
    return
  }
  if (!info.isFile()) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': wakeAssetMime(relative),
    'content-length': String(info.size),
    // The files are content-addressed by name and only ever replaced wholesale, so a
    // long private cache keeps ~20 MB off the wire on every ball reload.
    'cache-control': 'private, max-age=604800',
  })
  if (method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(target).pipe(res)
}

async function catalog(deps: RouteDeps): Promise<ModelCatalog> {
  try {
    return normalizeCatalog(await deps.ctx.sessionController.modelCatalog())
  } catch (error) {
    console.error(`dsh-orb: model catalog failed: ${error instanceof Error ? error.message : String(error)}`)
    return { groups: [] }
  }
}

/** The profile's avatar: the uploaded bytes, or the shipped GIF. */
async function sendAvatar(store: ProfileStore, method: string, res: ServerResponse): Promise<void> {
  const custom = store.avatarSelection().kind === 'custom' ? store.readAvatar() : undefined
  if (custom !== undefined) {
    sendImage(res, method, custom.bytes, custom.mime)
    return
  }
  if (await sendFile(res, method, defaultAvatarPath(), 'image/gif')) return
  res.writeHead(404)
  res.end()
}

/** Reads the file and answers with the image; false means the caller still has to answer. */
async function sendFile(res: ServerResponse, method: string, file: string, mime: string): Promise<boolean> {
  let body: Buffer
  try {
    body = await readFile(file)
  } catch {
    return false
  }
  sendImage(res, method, body, mime)
  return true
}

function sendImage(res: ServerResponse, method: string, body: Buffer, mime: string): void {
  res.writeHead(200, {
    'content-type': mime,
    'cache-control': 'no-store',
    'content-length': body.length,
  })
  res.end(method === 'HEAD' ? undefined : body)
}

function helperTokenOk(deps: RouteDeps, req: IncomingMessage): boolean {
  const header = req.headers[HELPER_HEADER]
  return typeof header === 'string' && deps.control.helperAuthorized(header)
}

/**
 * The ball presents the helper token either as the helper header or as `?token=`,
 * because a page's `fetch` cannot set a header the ball's own process keeps.
 */
function wakeTokenOk(deps: RouteDeps, req: IncomingMessage): boolean {
  if (helperTokenOk(deps, req)) return true
  const token = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token')
  return typeof token === 'string' && token !== '' && deps.control.helperAuthorized(token)
}

export function tokensMatch(given: string, expected: string): boolean {
  const left = Buffer.from(given)
  const right = Buffer.from(expected)
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right)
}

function rejectionStatus(ctx: RouteContext, req: IncomingMessage): number | undefined {
  if (typeof ctx.connection.admit === 'function') {
    const admitted = ctx.connection.admit(req)
    if (typeof admitted === 'object' && admitted !== null && 'rejection' in admitted && typeof admitted.rejection === 'number') {
      return admitted.rejection
    }
    return undefined
  }
  if (typeof ctx.connection.isAuthenticated === 'function') {
    return ctx.connection.isAuthenticated(req) ? undefined : 401
  }
  return 401
}

function selectionFrom(value: unknown): AgentModelSelection | undefined {
  return isAgentModelSelection(value) ? value : undefined
}

function booleanField(value: unknown): boolean | undefined {
  const enabled = asRecord(value)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

/**
 * A partial speech update layered onto what is stored.
 *
 * The settings page sends only the field it changed, so the others come from the store rather than
 * being reset — otherwise flipping `autoPlay` would silently clear a custom endpoint. An endpoint
 * that is present but not a usable http(s) URL rejects the whole request: half-applying it would
 * leave the user with a setting they cannot see or undo.
 */
function speechUpdate(value: unknown, current: SpeechSettings): SpeechSettings | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const next: { enabled: boolean; autoPlay: boolean; endpoint: string; voice: string } = { ...current }
  if ('enabled' in record) {
    if (typeof record.enabled !== 'boolean') return undefined
    next.enabled = record.enabled
  }
  if ('autoPlay' in record) {
    if (typeof record.autoPlay !== 'boolean') return undefined
    next.autoPlay = record.autoPlay
  }
  if ('endpoint' in record) {
    if (!isSpeechEndpoint(record.endpoint)) return undefined
    next.endpoint = record.endpoint
  }
  // The voice is the one field whose empty value is meaningful — it means "whatever the service
  // was started with" — so it is validated rather than required.
  if ('voice' in record) {
    if (!isSpeechVoice(record.voice)) return undefined
    next.voice = record.voice
  }
  return next
}

/**
 * The "finished speaking" pause out of the slider's request, in milliseconds.
 *
 * A number, or nothing: the page converts its seconds to milliseconds before sending, so a string
 * or a missing field is a caller that has it wrong rather than something to coerce. An out-of-band
 * number is clamped rather than rejected, because the two ends of the slider are exactly the two
 * clamped bounds and a value just outside them is a rounding edge, not a mistake worth losing.
 * A non-finite number is a mistake, and is refused.
 */
function silenceFrom(value: unknown): number | undefined {
  const silenceMs = asRecord(value)?.silenceMs
  if (typeof silenceMs !== 'number' || !Number.isFinite(silenceMs)) return undefined
  return Math.min(MAX_SILENCE_MS, Math.max(MIN_SILENCE_MS, Math.round(silenceMs)))
}

/** The composer switch's body: `{ enabled: boolean }` and nothing else. */
function enabledFrom(value: unknown): boolean | undefined {
  const enabled = asRecord(value)?.enabled
  return typeof enabled === 'boolean' ? enabled : undefined
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const bytes = await readBody(req, 64 * 1024)
  if (bytes.length === 0) return undefined
  return JSON.parse(bytes.toString('utf8')) as unknown
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too-large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
