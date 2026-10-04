/**
 * Settings routes on the official web port.
 * The main window calls these with a relative fetch, so the existing login cookie is enough.
 * The helper may read only the avatar, and only with its socket token.
 */

import { timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AVATAR_PRESETS, avatarPresetPath, isAvatarPresetId } from './avatar-presets.ts'
import { normalizeCatalog, type ModelCatalog } from './catalog.ts'
import {
  isAgentModelSelection,
  isSpeechEndpoint,
  MAX_AVATAR_BYTES,
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
  helperStatus?(): string
}

interface RouteDeps {
  readonly ctx: RouteContext
  readonly store: ProfileStore
  readonly tcc: TccMonitor
  readonly control: OrbControl
}

/** Mount `/.dsh-orb` and return the disposer. */
export function registerOrbRoutes(deps: RouteDeps): () => void {
  return deps.ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: (req, res) => handle(deps, req, res),
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
  if (method === 'GET' && path === `${PREFIX}/models`) {
    sendJson(res, 200, await catalog(deps))
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
  if ((method === 'GET' || method === 'HEAD') && path.startsWith(`${PREFIX}/avatar/preset/`)) {
    const id = decodeURIComponent(path.slice(`${PREFIX}/avatar/preset/`.length))
    const file = avatarPresetPath(id)
    if (file === undefined || !await sendFile(res, method, file, 'image/gif')) {
      res.writeHead(404)
      res.end()
    }
    return
  }
  if (!orbSupported()) {
    sendJson(res, 403, { error: 'unsupported' })
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
  if (method === 'POST' && path === `${PREFIX}/avatar/preset`) {
    const preset = asRecord(await readJson(req))?.preset
    if (!isAvatarPresetId(preset)) {
      sendJson(res, 400, { error: 'invalid-preset' })
      return
    }
    deps.store.selectAvatarPreset(preset)
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
  avatarPresetId: string | null
  avatarPresets: { id: string; url: string }[]
  overlay: AgentModelSelection
  background: AgentModelSelection
  selectionEnabled: boolean
  millifractionEnabled: boolean
  speech: SpeechSettings
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
    avatarPresetId: selection.kind === 'preset' ? selection.id : null,
    // No version on the gallery URLs: the files are the same on every render, and a
    // bump would make the page refetch every multi-megabyte GIF on any avatar change.
    avatarPresets: AVATAR_PRESETS.map((preset) => ({ id: preset.id, url: `${PREFIX}/avatar/preset/${preset.id}` })),
    overlay: models.overlay,
    background: models.background,
    selectionEnabled: deps.store.selectionEnabled(),
    millifractionEnabled: deps.store.millifractionEnabled(),
    speech: deps.store.speech(),
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

/** The profile's avatar: a built-in preset, the uploaded bytes, or the shipped GIF. */
async function sendAvatar(store: ProfileStore, method: string, res: ServerResponse): Promise<void> {
  const selection = store.avatarSelection()
  if (selection.kind === 'preset') {
    const file = avatarPresetPath(selection.id)
    if (file !== undefined && await sendFile(res, method, file, 'image/gif')) return
  }
  const custom = selection.kind === 'custom' ? store.readAvatar() : undefined
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
  const next: { enabled: boolean; autoPlay: boolean; endpoint: string } = { ...current }
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
  return next
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
