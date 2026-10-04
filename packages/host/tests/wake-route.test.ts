import { createServer, type Server } from 'node:http'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
async function serve(): Promise<{ url: string; close: () => Promise<void> }> {
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
})
