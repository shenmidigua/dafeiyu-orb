import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ProfileStore } from '../src/preferences.ts'
import { registerOrbRoutes, tokensMatch, type OrbControl } from '../src/routes.ts'
import { TccMonitor } from '../src/tcc.ts'

/** The reference plugin's model folder, which is what the wake route serves from. */
const reference = resolve(import.meta.dirname, '..', '..', '..', 'dsh-voice-dialog', 'assets')

const root = mkdtempSync(join(tmpdir(), 'orb-wake-route-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

/** A live loopback server with the real route mounted. */
async function serve(
  reportPath?: string,
  transcribe?: (audio: Buffer) => Promise<{ ok: true; text: string } | { ok: false; reason: string }>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const store = new ProfileStore(root)
  const control: OrbControl = {
    helperAuthorized: (token) => tokensMatch(token, 'helper-secret'),
    async publishChrome() {},
    async setOverlayModel() {},
    async setBackgroundModel() {},
    async setSelectionEnabled() {},
    async setMillifractionEnabled() {},
    async setBallEnabled() {},
    async setWakeEnabled(enabled) { store.setWakeEnabled(enabled) },
    async transcribe(audio) { return transcribe === undefined ? { ok: true, text: '' } : transcribe(audio) },
  }
  const server: Server = createServer((req, res) => { void handler(req, res) })
  let handler: (req: Parameters<Parameters<typeof createServer>[0]>[0], res: Parameters<Parameters<typeof createServer>[0]>[1]) => Promise<void> = async (_req, res) => {
    res.writeHead(500)
    res.end()
  }
  registerOrbRoutes({
    ctx: {
      webServer: {
        register(route) {
          handler = route.handler as typeof handler
          return () => {}
        },
      },
      connection: { isAuthenticated: () => true },
      sessionController: { modelCatalog: () => ({ groups: [] }) },
    },
    store,
    tcc: new TccMonitor(),
    control,
    reportPath,
  })
  await new Promise<void>((done) => { server.listen(0, '127.0.0.1', () => { done() }) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    // `fetch` keeps its socket alive, and a server with a live keep-alive connection
    // never finishes closing on its own.
    close: () => new Promise<void>((done) => {
      server.closeAllConnections()
      server.close(() => { done() })
    }),
  }
}

describe('wake asset route', () => {
  it('serves the models and the wasm runtime to a helper-token holder', { skip: !existsSync(reference) }, async () => {
    const { url, close } = await serve()
    try {
      const wasm = await fetch(`${url}/.dsh-orb/wake-assets/ort/ort-wasm-simd-threaded.wasm?token=helper-secret`)
      assert.equal(wasm.status, 200)
      assert.equal(wasm.headers.get('content-type'), 'application/wasm')
      assert.ok(Number(wasm.headers.get('content-length')) > 1_000_000)
      const mel = await fetch(`${url}/.dsh-orb/wake-assets/melspectrogram.onnx?token=helper-secret`, { method: 'HEAD' })
      assert.equal(mel.status, 200)
      assert.equal(mel.headers.get('content-type'), 'application/octet-stream')
      const loader = await fetch(`${url}/.dsh-orb/wake-assets/ort/ort-wasm-simd-threaded.mjs?token=helper-secret`)
      assert.equal(loader.status, 200)
      assert.equal(loader.headers.get('content-type'), 'text/javascript; charset=utf-8')
    } finally {
      await close()
    }
  })

  it('rejects a wrong token, a traversal, and an unknown file', { skip: !existsSync(reference) }, async () => {
    const { url, close } = await serve()
    try {
      const wrong = await fetch(`${url}/.dsh-orb/wake-assets/melspectrogram.onnx?token=nope`)
      assert.equal(wrong.status, 403)
      const traversal = await fetch(`${url}/.dsh-orb/wake-assets/..%2F..%2Fpackage.json?token=helper-secret`)
      assert.equal(traversal.status, 404)
      const unknown = await fetch(`${url}/.dsh-orb/wake-assets/credentials.json?token=helper-secret`)
      assert.equal(unknown.status, 404)
    } finally {
      await close()
    }
  })

  it('keeps the token out of the URL of every other route', async () => {
    const { url, close } = await serve()
    try {
      const other = await fetch(`${url}/.dsh-orb/settings`)
      assert.equal(other.status, 200)
    } finally {
      await close()
    }
  })

  it('reads and flips the wake switch the composer shows', async () => {
    const { url, close } = await serve()
    try {
      const read = await fetch(`${url}/.dsh-orb/wake`)
      assert.equal(read.status, 200)
      assert.deepEqual(await read.json(), { enabled: false }, 'nothing configured yet')

      const on = await fetch(`${url}/.dsh-orb/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      })
      assert.equal(on.status, 200)
      assert.deepEqual(await on.json(), { enabled: true })
      assert.deepEqual(await (await fetch(`${url}/.dsh-orb/wake`)).json(), { enabled: true },
        'the switch is what the store kept, not just what the reply said')

      const off = await fetch(`${url}/.dsh-orb/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: false }),
      })
      assert.deepEqual(await off.json(), { enabled: false })
    } finally {
      await close()
    }
  })

  it('refuses a switch body that is not a boolean', async () => {
    const { url, close } = await serve()
    try {
      const bad = await fetch(`${url}/.dsh-orb/wake`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      })
      assert.equal(bad.status, 400)
      assert.deepEqual(await bad.json(), { error: 'invalid-wake' })
      assert.deepEqual(await (await fetch(`${url}/.dsh-orb/wake`)).json(), { enabled: false },
        'a refused body must not have changed the switch')
    } finally {
      await close()
    }
  })

  it('tells the composer recorder the numbers the black panel writes', async () => {
    // The button beside the wake switch records on the same three limits as the ball. Reading them
    // per press is what lets the settings slider take effect on the next sentence.
    const { url, close } = await serve()
    try {
      const read = await fetch(`${url}/.dsh-orb/dictation`)
      assert.equal(read.status, 200)
      assert.deepEqual(await read.json(), {
        silenceMs: 2500,
        maxSeconds: 15,
        autoSend: false,
        noSpeechMs: 6000,
      })
    } finally {
      await close()
    }
  })

  it('hands a composer recording to the transcriber the ball uses', async () => {
    let seen = Buffer.alloc(0)
    const { url, close } = await serve(undefined, async (audio) => {
      seen = audio
      return { ok: true, text: '今天天气不错' }
    })
    try {
      const response = await fetch(`${url}/.dsh-orb/transcribe`, {
        method: 'POST',
        headers: { 'content-type': 'audio/wav' },
        body: Buffer.from('RIFF-test-bytes'),
      })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { text: '今天天气不错' })
      assert.equal(seen.toString(), 'RIFF-test-bytes', 'the body has to arrive unmodified')
    } finally {
      await close()
    }
  })

  it('reports a failed transcription as a reason, not as an empty sentence', async () => {
    const { url, close } = await serve(undefined, async () => ({ ok: false, reason: '没有识别出文字' }))
    try {
      const response = await fetch(`${url}/.dsh-orb/transcribe`, { method: 'POST', body: Buffer.from('RIFF') })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { error: '没有识别出文字' })
    } finally {
      await close()
    }
  })

  it('answers when the transcriber itself throws instead of leaving the page waiting', async () => {
    // The composer's microphone posts a WAV and waits for the words. A rejection used to end the
    // handler before a response was written, so the request hung and the button stayed busy for the
    // rest of the session; a transcriber that is not up is an answer, not a silence.
    const { url, close } = await serve(undefined, async () => { throw new Error('service down') })
    try {
      const response = await fetch(`${url}/.dsh-orb/transcribe`, { method: 'POST', body: Buffer.from('RIFF') })
      assert.equal(response.status, 500)
      assert.deepEqual(await response.json(), { error: '语音识别服务没有响应' })
    } finally {
      await close()
    }
  })

  it('keeps the composer beacon where a missing switch can be diagnosed', async () => {
    const file = join(root, 'client-report.json')
    const { url, close } = await serve(file)
    try {
      const posted = await fetch(`${url}/.dsh-orb/client-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: 'apply', ready: 'complete', mics: 1 }),
      })
      assert.equal(posted.status, 200)
      assert.deepEqual(readReport(file), { phase: 'apply', ready: 'complete', mics: 1 })
    } finally {
      await close()
    }
  })

  it('replaces the previous beacon rather than appending to it', async () => {
    const file = join(root, 'client-report.json')
    const { url, close } = await serve(file)
    try {
      for (const mics of [0, 2]) {
        await fetch(`${url}/.dsh-orb/client-report`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ phase: 'apply', mics }),
        })
      }
      assert.deepEqual(readReport(file), { phase: 'apply', mics: 2 })
    } finally {
      await close()
    }
  })

  it('appends a page report to the rolling log the ball traces into', async () => {
    // The voice hand-off has no visible half: a press that does nothing and a press that never
    // happened look identical from outside. Every step writes a line beside the ball's own
    // tracing, because the beacon file keeps only the last one.
    const home = mkdtempSync(join(tmpdir(), 'orb-home-'))
    const savedProfile = process.env.USERPROFILE
    const savedHome = process.env.HOME
    process.env.USERPROFILE = home
    process.env.HOME = home
    const { url, close } = await serve()
    try {
      const posted = await fetch(`${url}/.dsh-orb/client-report`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ phase: 'voice', note: 'pressing "开始录音"' }),
      })
      assert.equal(posted.status, 200)
      const log = readFileSync(join(home, '.dsh', 'dsh-orb', 'stream.log'), 'utf8')
      assert.match(log, /page: pressing "开始录音"/, 'the step must survive in the rolling log')
    } finally {
      process.env.USERPROFILE = savedProfile
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      await close()
      rmSync(home, { recursive: true, force: true })
    }
  })
})

function readReport(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8')) as unknown
}
