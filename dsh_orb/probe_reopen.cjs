/**
 * Does closing the microphone and opening it again straight away hand back a dead track?
 *
 * The composer now opens and closes the device for every sentence, so a continuous conversation is
 * exactly this sequence: record, close, answer, record again. If the second `getUserMedia` in a row
 * delivers digital silence, the follow-up turn hears nobody and the exchange dies with "没有听到
 * 说话" — which is what the host log showed.
 *
 * `env -u ELECTRON_RUN_AS_NODE <electron> probe_reopen.cjs` — prints JSON and exits.
 */
const { app, BrowserWindow, session } = require('electron')
const { createServer } = require('node:http')

const page = '<!doctype html><meta charset="utf-8"><body>probe</body>'

const script = `
  (async () => {
    const out = []
    async function cycle(index, shared) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
      })
      const track = stream.getAudioTracks()[0]
      let ctx = shared ? shared.ctx : undefined
      if (!ctx) {
        try { ctx = new AudioContext({ sampleRate: 16000 }) } catch (error) { ctx = new AudioContext() }
      }
      if (ctx.state === 'suspended') { try { await ctx.resume() } catch (error) {} }
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(1024, 1, 1)
      let frames = 0, peak = 0, sum = 0, samples = 0
      processor.onaudioprocess = (event) => {
        frames += 1
        const data = event.inputBuffer.getChannelData(0)
        for (let i = 0; i < data.length; i += 1) {
          const v = Math.abs(data[i])
          if (v > peak) peak = v
          sum += data[i] * data[i]
          samples += 1
        }
      }
      source.connect(processor)
      const sink = ctx.createGain()
      sink.gain.value = 0
      processor.connect(sink)
      sink.connect(ctx.destination)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      processor.onaudioprocess = null
      try { source.disconnect(); processor.disconnect(); sink.disconnect() } catch (error) {}
      out.push({
        index,
        mode: shared ? 'shared context' : 'fresh everything',
        rate: ctx.sampleRate,
        state: ctx.state,
        trackState: track.readyState,
        muted: track.muted,
        frames,
        peak: Number(peak.toFixed(4)),
        rms: samples ? Number(Math.sqrt(sum / samples).toFixed(4)) : 0,
      })
      for (const t of stream.getTracks()) t.stop()
      if (shared) shared.ctx = ctx
      else { try { await ctx.close() } catch (error) {} }
      return ctx
    }
    // A: what the page does now — a fresh context and a fresh stream per sentence.
    await cycle(1, undefined)
    await cycle(2, undefined)
    await cycle(3, undefined)
    // B: one context for the page, still a fresh stream per sentence.
    const shared = { ctx: undefined }
    await cycle(4, shared)
    await cycle(5, shared)
    await cycle(6, shared)
    return JSON.stringify(out, null, 2)
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
