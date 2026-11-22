import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizeCatalog } from '../src/catalog.ts'
import { ProfileStore } from '../src/preferences.ts'
import { orbSupported, registerOrbRoutes, tokensMatch, type OrbControl } from '../src/routes.ts'
import { TccMonitor } from '../src/tcc.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-routes-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])

function request(method: string, url: string, body?: Buffer | string, headers: Record<string, string> = {}): IncomingMessage {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(body)
  const stream = Readable.from(payload.length === 0 ? [] : [payload])
  return Object.assign(stream, { method, url, headers }) as IncomingMessage
}

function response(): ServerResponse & { status: number; body: Buffer } {
  const res = {
    status: 0,
    body: Buffer.alloc(0),
    writeHead(status: number) { this.status = status },
    end(chunk?: Buffer | string) {
      if (chunk) this.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    },
  }
  return res as ServerResponse & { status: number; body: Buffer }
}

describe('settings routes', () => {
  it('normalizes the official model catalog', () => {
    assert.deepEqual(normalizeCatalog({
      groups: [
        { id: '', name: 'skip' },
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            { id: 'plain', name: 'Plain' },
            { id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } },
            { id: 'bad' },
          ],
        },
        { id: 'empty', name: 'Empty', models: [] },
      ],
    }), {
      groups: [{
        id: 'deepseek-official',
        name: 'DeepSeek',
        models: [
          { id: 'plain', name: 'Plain' },
          { id: 'think', name: 'Think', reasoning: { efforts: [{ id: 'max', name: 'Max' }], defaultEffort: 'max' } },
        ],
      }],
    })
    assert.deepEqual(normalizeCatalog(null), { groups: [] })
    assert.equal(orbSupported('linux'), false)
    assert.equal(orbSupported('darwin'), true)
    assert.equal(orbSupported('win32'), true)
    assert.equal(tokensMatch('same-token', 'same-token'), true)
    assert.equal(tokensMatch('same-token', 'other-token'), false)
    assert.equal(tokensMatch('', ''), false)
  })

  it('serves the snapshot on the official port and lets the helper read only the avatar', async () => {
    const profile = join(root, 'profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const calls: unknown[] = []
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() { calls.push('chrome') },
      async setOverlayModel(selection) { store.setOverlay(selection); calls.push(['overlay', selection]) },
      async setBackgroundModel(selection) { store.setBackground(selection); calls.push(['background', selection]) },
      async setSelectionEnabled(enabled) { store.setSelectionEnabled(enabled) },
      async setMillifractionEnabled(enabled) { store.setMillifractionEnabled(enabled) },
      async setBallEnabled(enabled) { store.setBallEnabled(enabled) },
      async setWakeEnabled(enabled) { store.setWakeEnabled(enabled) },
      async setSpeech(settings) { store.setSpeech(settings) },
      async setWakeSilence(silenceMs) { store.setDictationSilence(silenceMs); calls.push(['silence', silenceMs]) },
    }
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            assert.equal(route.kind, 'prefix')
            assert.equal(route.path, '/.dsh-orb')
            handler = route.handler
            return () => { handler = undefined }
          },
        },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: {
          modelCatalog: () => ({ groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'Flash' }] }] }),
        },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)
    const denied = response()
    await handler(request('GET', '/.dsh-orb/settings'), denied)
    assert.equal(denied.status, 401)
    assert.equal(denied.body.length, 0)

    const helperSettings = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-orb-helper': 'helper-secret' }), helperSettings)
    assert.equal(helperSettings.status, 401)

    const avatar = response()
    await handler(request('GET', '/.dsh-orb/avatar?v=0', undefined, { 'x-dsh-orb-helper': 'helper-secret' }), avatar)
    assert.equal(avatar.status, 200)
    assert.equal(avatar.body.subarray(0, 6).toString('ascii'), 'GIF89a')

    const wrong = response()
    await handler(request('GET', '/.dsh-orb/avatar', undefined, { 'x-dsh-orb-helper': 'nope' }), wrong)
    assert.equal(wrong.status, 401)

    const settings = response()
    await handler(request('GET', '/.dsh-orb/settings', undefined, { 'x-dsh-user': 'ok' }), settings)
    const snapshot = JSON.parse(settings.body.toString('utf8')) as {
      avatarUrl: string
      ballEnabled: boolean
      overlay: { model: string }
      supported: boolean
      permissionFallback: boolean
    }
    assert.equal(settings.status, 200)
    assert.equal(snapshot.avatarUrl, '/.dsh-orb/avatar?v=0')
    assert.equal(snapshot.avatarUrl.includes('token'), false)
    assert.equal(snapshot.ballEnabled, true)
    assert.equal(snapshot.overlay.model, 'deepseek-flash')
    assert.equal(snapshot.supported, process.platform === 'darwin' || process.platform === 'win32')
    assert.equal(snapshot.permissionFallback, false)

    const models = response()
    await handler(request('GET', '/.dsh-orb/models', undefined, { 'x-dsh-user': 'ok' }), models)
    assert.equal(JSON.parse(models.body.toString('utf8')).groups[0].models[0].id, 'deepseek-flash')

    const overlay = response()
    await handler(request('POST', '/.dsh-orb/overlay-model', JSON.stringify({
      provider: 'deepseek-official',
      model: 'deepseek-pro',
      reasoningEffort: 'high',
    }), { 'x-dsh-user': 'ok' }), overlay)
    assert.equal(JSON.parse(overlay.body.toString('utf8')).overlay.model, 'deepseek-pro')

    const background = response()
    await handler(request('POST', '/.dsh-orb/background-model', JSON.stringify({
      provider: 'deepseek-official',
      model: 'background',
    }), { 'x-dsh-user': 'ok' }), background)
    assert.equal(JSON.parse(background.body.toString('utf8')).background.model, 'background')
    assert.equal(JSON.parse(background.body.toString('utf8')).overlay.model, 'deepseek-pro')

    const selection = response()
    await handler(request('POST', '/.dsh-orb/selection', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), selection)
    assert.equal(JSON.parse(selection.body.toString('utf8')).selectionEnabled, false)

    const fraction = response()
    await handler(request('POST', '/.dsh-orb/millifraction', JSON.stringify({ enabled: true }), { 'x-dsh-user': 'ok' }), fraction)
    assert.equal(JSON.parse(fraction.body.toString('utf8')).millifractionEnabled, true)
    assert.equal(store.coordinateMode(), 'millifraction')

    const ball = response()
    await handler(request('POST', '/.dsh-orb/ball', JSON.stringify({ enabled: false }), { 'x-dsh-user': 'ok' }), ball)
    assert.equal(JSON.parse(ball.body.toString('utf8')).ballEnabled, false)
    assert.equal(store.ballEnabled(), false)

    // Read-aloud: each switch is sent on its own, so the others must survive the round trip.
    const speechOn = response()
    await handler(request('POST', '/.dsh-orb/speech', JSON.stringify({ enabled: true }), { 'x-dsh-user': 'ok' }), speechOn)
    assert.deepEqual(JSON.parse(speechOn.body.toString('utf8')).speech, {
      enabled: true,
      autoPlay: false,
      endpoint: 'http://127.0.0.1:8765',
      voice: '',
    })

    const speechEndpoint = response()
    await handler(request('POST', '/.dsh-orb/speech', JSON.stringify({ endpoint: 'http://127.0.0.1:9000' }), { 'x-dsh-user': 'ok' }), speechEndpoint)
    assert.equal(JSON.parse(speechEndpoint.body.toString('utf8')).speech.endpoint, 'http://127.0.0.1:9000')

    const speechAuto = response()
    await handler(request('POST', '/.dsh-orb/speech', JSON.stringify({ autoPlay: true }), { 'x-dsh-user': 'ok' }), speechAuto)
    // A later write must not quietly reset the endpoint set above.
    assert.deepEqual(JSON.parse(speechAuto.body.toString('utf8')).speech, {
      enabled: true,
      autoPlay: true,
      endpoint: 'http://127.0.0.1:9000',
      voice: '',
    })

    // A bad endpoint rejects the whole request rather than half-applying it.
    const speechBad = response()
    await handler(request('POST', '/.dsh-orb/speech', JSON.stringify({ endpoint: 'file:///secret' }), { 'x-dsh-user': 'ok' }), speechBad)
    assert.equal(speechBad.status, 400)
    assert.equal(JSON.parse(speechBad.body.toString('utf8')).error, 'invalid-speech')
    assert.equal(store.speech().endpoint, 'http://127.0.0.1:9000')

    const speechWrongType = response()
    await handler(request('POST', '/.dsh-orb/speech', JSON.stringify({ enabled: 'yes' }), { 'x-dsh-user': 'ok' }), speechWrongType)
    assert.equal(speechWrongType.status, 400)
    assert.equal(store.speech().enabled, true)

    // The "finished speaking" pause: milliseconds over the wire, the shipped 2.5 s until moved.
    assert.equal(JSON.parse(settings.body.toString('utf8')).dictation.silenceMs, 2500)
    const silence = response()
    await handler(request('POST', '/.dsh-orb/wake/silence', JSON.stringify({ silenceMs: 3500 }), { 'x-dsh-user': 'ok' }), silence)
    assert.equal(silence.status, 200)
    assert.equal(JSON.parse(silence.body.toString('utf8')).dictation.silenceMs, 3500)
    assert.equal(store.wake().dictation.silenceMs, 3500)
    // It is in the file the helper reads at launch, not only in memory.
    const wakeFile = JSON.parse(readFileSync(join(profile, 'orb-wake.json'), 'utf8')) as {
      dictation: { silenceMs: number; maxSeconds: number }
    }
    assert.equal(wakeFile.dictation.silenceMs, 3500)
    assert.equal(wakeFile.dictation.maxSeconds, 15, 'the other dictation fields survive the write')
    // The ball hears about it on the same broadcast as everything else.
    assert.deepEqual(calls.filter((call) => Array.isArray(call)).at(-1), ['silence', 3500])

    // Out of band is clamped to the slider's own ends, not refused.
    const silenceLow = response()
    await handler(request('POST', '/.dsh-orb/wake/silence', JSON.stringify({ silenceMs: 10 }), { 'x-dsh-user': 'ok' }), silenceLow)
    assert.equal(JSON.parse(silenceLow.body.toString('utf8')).dictation.silenceMs, 300)
    const silenceHigh = response()
    await handler(request('POST', '/.dsh-orb/wake/silence', JSON.stringify({ silenceMs: 60_000 }), { 'x-dsh-user': 'ok' }), silenceHigh)
    assert.equal(JSON.parse(silenceHigh.body.toString('utf8')).dictation.silenceMs, 10_000)

    // A wrong type or a missing field is a caller with the units wrong, not something to guess at.
    for (const body of ['{ "silenceMs": "3.5" }', '{}', '{ "silenceMs": null }']) {
      const bad = response()
      await handler(request('POST', '/.dsh-orb/wake/silence', body, { 'x-dsh-user': 'ok' }), bad)
      assert.equal(bad.status, 400, body)
      assert.equal(JSON.parse(bad.body.toString('utf8')).error, 'invalid-silence')
    }
    assert.equal(store.wake().dictation.silenceMs, 10_000)

    // Put the pause back to the shipped value so later assertions read the ordinary profile.
    const silenceReset = response()
    await handler(request('POST', '/.dsh-orb/wake/silence', JSON.stringify({ silenceMs: 2200 }), { 'x-dsh-user': 'ok' }), silenceReset)
    assert.equal(store.wake().dictation.silenceMs, 2200)

    const uploaded = response()
    await handler(request('POST', '/.dsh-orb/avatar', png, { 'x-dsh-user': 'ok' }), uploaded)
    const uploadedSnapshot = JSON.parse(uploaded.body.toString('utf8')) as { avatarUrl: string }
    assert.match(uploadedSnapshot.avatarUrl, /^\/\.dsh-orb\/avatar\?v=[1-9]/)
    const custom = response()
    await handler(request('GET', '/.dsh-orb/avatar?v=2', undefined, { 'x-dsh-user': 'ok' }), custom)
    assert.equal(custom.body.equals(png), true)

    const invalid = response()
    await handler(request('POST', '/.dsh-orb/avatar', Buffer.from('nope'), { 'x-dsh-user': 'ok' }), invalid)
    assert.equal(invalid.status, 400)
    assert.equal(JSON.parse(invalid.body.toString('utf8')).error, 'invalid-type')

    const restored = response()
    await handler(request('POST', '/.dsh-orb/avatar/restore', '{}', { 'x-dsh-user': 'ok' }), restored)
    assert.equal(JSON.parse(restored.body.toString('utf8')).avatarUrl, '/.dsh-orb/avatar?v=0')
    assert.equal(calls.includes('chrome'), true)

    // The built-in animation gallery is gone: no preset list in the snapshot, and both of its
    // routes are 404s rather than something a stale page could still drive.
    const gallery = JSON.parse(settings.body.toString('utf8')) as {
      avatarPresetId?: string | null
      avatarPresets?: { id: string; url: string }[]
    }
    assert.equal(gallery.avatarPresetId, undefined)
    assert.equal(gallery.avatarPresets, undefined)

    const presetRoute = response()
    await handler(request('GET', '/.dsh-orb/avatar/preset/point', undefined, { 'x-dsh-user': 'ok' }), presetRoute)
    assert.equal(presetRoute.status, 404)

    const pickRoute = response()
    await handler(request('POST', '/.dsh-orb/avatar/preset', JSON.stringify({ preset: 'point' }), { 'x-dsh-user': 'ok' }), pickRoute)
    assert.equal(pickRoute.status, 404)

    const missing = response()
    await handler(request('GET', '/.dsh-orb/nope', undefined, { 'x-dsh-user': 'ok' }), missing)
    assert.equal(missing.status, 404)
    dispose()
  })

  // The two routes that carry a wake turn's words into a fixed conversation. They are the only way
  // into that conversation that does not go through the window's composer, so their refusals matter
  // as much as their successes: the page reads the reason out rather than silently dropping words.
  it('takes a wake turn\'s words to one conversation, and refuses them clearly', async () => {
    const profile = join(root, 'voice-profile')
    mkdirSync(profile, { recursive: true })
    const store = new ProfileStore(profile)
    const taken: string[] = []
    const endings: [string, boolean][] = []
    let found = 'session-voice'
    const control: OrbControl = {
      helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
      async publishChrome() {},
      async setOverlayModel(selection) { store.setOverlay(selection) },
      async setBackgroundModel(selection) { store.setBackground(selection) },
      async setSelectionEnabled(enabled) { store.setSelectionEnabled(enabled) },
      async setMillifractionEnabled(enabled) { store.setMillifractionEnabled(enabled) },
      async setBallEnabled(enabled) { store.setBallEnabled(enabled) },
      async setWakeEnabled(enabled) { store.setWakeEnabled(enabled) },
      async setSpeech(settings) { store.setSpeech(settings) },
      async setWakeSilence() {},
      takeMainVoice: () => null,
      async sendVoiceText(text) {
        if (found === '') return { ok: false, reason: '没有找到名为「语音总管」的对话' }
        taken.push(text)
        return { ok: true }
      },
      async voiceTargetInfo() { return { title: '语音总管', sessionId: found === '' ? null : found } },
      noteVoiceResult(outcome, routed) { endings.push([outcome, routed === true]) },
    } as OrbControl
    let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
    const dispose = registerOrbRoutes({
      ctx: {
        webServer: {
          register(route) {
            handler = route.handler
            return () => { handler = undefined }
          },
        },
        connection: {
          admit(req) {
            return req.headers['x-dsh-user'] === 'ok' ? { peer: { id: 'local' } } : { rejection: 401 }
          },
        },
        sessionController: { modelCatalog: () => ({ groups: [] }) },
      },
      store,
      tcc: new TccMonitor(),
      control,
    })
    assert.ok(handler)

    const where = response()
    await handler(request('GET', '/.dsh-orb/voice-target', undefined, { 'x-dsh-user': 'ok' }), where)
    assert.deepEqual(JSON.parse(where.body.toString('utf8')), { title: '语音总管', sessionId: 'session-voice' })

    const sent = response()
    await handler(request('POST', '/.dsh-orb/voice-send', JSON.stringify({ text: '  今天几号  ' }), { 'x-dsh-user': 'ok' }), sent)
    assert.equal(sent.status, 200)
    assert.deepEqual(taken, ['今天几号'], 'the words are trimmed, not passed with the pause a transcription leaves')

    const blank = response()
    await handler(request('POST', '/.dsh-orb/voice-send', JSON.stringify({ text: '   ' }), { 'x-dsh-user': 'ok' }), blank)
    assert.equal(blank.status, 400)
    assert.equal(JSON.parse(blank.body.toString('utf8')).reason, 'empty-or-too-long')
    assert.equal(taken.length, 1, 'nothing empty reaches a conversation')

    const huge = response()
    await handler(request('POST', '/.dsh-orb/voice-send', JSON.stringify({ text: 'a'.repeat(6_001) }), { 'x-dsh-user': 'ok' }), huge)
    assert.equal(huge.status, 400)

    // No conversation with that title: the page still gets an answer it can say out loud, and the
    // status is not 200, because nothing was delivered.
    found = ''
    const absent = response()
    await handler(request('POST', '/.dsh-orb/voice-send', JSON.stringify({ text: '你在吗' }), { 'x-dsh-user': 'ok' }), absent)
    assert.equal(absent.status, 409)
    assert.equal(JSON.parse(absent.body.toString('utf8')).ok, false)

    const nowhere = response()
    await handler(request('GET', '/.dsh-orb/voice-target', undefined, { 'x-dsh-user': 'ok' }), nowhere)
    assert.equal(JSON.parse(nowhere.body.toString('utf8')).sessionId, null)

    // Both routes sit behind the same door as the rest of the panel: a page without the user
    // header is not this window.
    const closed = response()
    await handler(request('POST', '/.dsh-orb/voice-send', JSON.stringify({ text: 'hi' })), closed)
    assert.equal(closed.status, 401)

    // How the turn ended travels with it, and `routed` has to survive the trip: it is what makes
    // the ball drop its continuous exchange instead of handing the microphone back.
    const ending = response()
    await handler(request('POST', '/.dsh-orb/main-voice-result', JSON.stringify({ outcome: 'sent', routed: true }), { 'x-dsh-user': 'ok' }), ending)
    assert.equal(ending.status, 200)
    const plain = response()
    await handler(request('POST', '/.dsh-orb/main-voice-result', JSON.stringify({ outcome: 'empty' }), { 'x-dsh-user': 'ok' }), plain)
    assert.deepEqual(endings, [['sent', true], ['empty', false]])
    dispose()
  })
})
