/**
 * Ask a real Electron renderer what the composer's dictation button will be able to do.
 *
 * The unit tests cannot answer any of this: whether the device opens at all, whether an
 * `AudioContext` built at 16 kHz comes up at 16 kHz, and whether a `ScriptProcessorNode` is
 * actually pulled (it is deprecated, and an unconnected one is silent in more than one way).
 *
 * The page is served over http rather than `data:` on purpose — a media request from an opaque
 * origin is refused before the permission handler is ever consulted, which would hide the very
 * answer this probe is after.
 *
 * `env -u ELECTRON_RUN_AS_NODE <electron> probe_mic_recorder.cjs` — prints JSON and exits.
 */
const { app, BrowserWindow, session } = require('electron')
const { createServer } = require('node:http')

const page = `<!doctype html><meta charset="utf-8"><body>probe</body>`

const script = `
  (async () => {
    const out = { hasGetUserMedia: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      })
      out.device = 'open'
    } catch (error) {
      out.device = String(error && error.name ? error.name : error)
      out.detail = String(error && error.message ? error.message : '')
      return JSON.stringify(out)
    }
    let ctx
    try {
      try {
        ctx = new AudioContext({ sampleRate: 16000 })
        out.requested = 16000
      } catch (error) {
        out.sampleRateOption = String(error && error.name ? error.name : error)
        ctx = new AudioContext()
      }
      out.actualRate = ctx.sampleRate
      out.createScriptProcessor = typeof ctx.createScriptProcessor
      if (ctx.state !== 'running') {
        try { await ctx.resume() } catch (error) { out.resume = String(error) }
      }
      out.state = ctx.state
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(1024, 1, 1)
      let frames = 0
      let peak = 0
      const levels = []
      processor.onaudioprocess = (event) => {
        frames += 1
        const data = event.inputBuffer.getChannelData(0)
        let sum = 0
        for (let i = 0; i < data.length; i += 1) {
          peak = Math.max(peak, Math.abs(data[i]))
          sum += data[i] * data[i]
        }
        levels.push(Math.sqrt(sum / data.length))
      }
      source.connect(processor)
      const sink = ctx.createGain()
      sink.gain.value = 0
      processor.connect(sink)
      sink.connect(ctx.destination)
      await new Promise((resolve) => setTimeout(resolve, 2500))
      out.frames = frames
      out.peak = Number(peak.toFixed(4))
      // The threshold the recorder picks is a multiple of the floor, so the floor is the number
      // this probe exists to print: a bare rms here, not a peak scaled by a crest factor.
      levels.sort((a, b) => a - b)
      const at = (q) => Number((levels[Math.min(levels.length - 1, Math.floor(q * levels.length))] || 0).toFixed(4))
      out.rms = { p10: at(0.1), p50: at(0.5), p90: at(0.9), max: at(1) }
    } catch (error) {
      out.error = String(error && error.message ? error.message : error)
    } finally {
      try { if (ctx) await ctx.close() } catch {}
      try { for (const track of stream.getTracks()) track.stop() } catch {}
    }
    return JSON.stringify(out)
  })()
`

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  app.whenReady().then(async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => { callback(true) })
    const win = new BrowserWindow({ width: 400, height: 200, show: false })
    try {
      await win.loadURL(`http://127.0.0.1:${port}/`)
      console.log(await win.webContents.executeJavaScript(script))
    } catch (error) {
      console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
    }
    server.close()
    app.quit()
  }).catch((error) => {
    console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
    server.close()
    app.quit()
  })
})
