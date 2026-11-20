/**
 * Does the echo canceller mute the microphone while the page itself is making sound?
 *
 * A continuous voice turn opens the microphone about 400 ms after the reply finishes generating —
 * but read-aloud may still be speaking. If the canceller treats that playback as its own echo and
 * gates the capture, the follow-up turn records digital silence and ends with "没有听到说话",
 * which is exactly what the host log shows for every second sentence.
 *
 * This measures the microphone with and without playback, and with the canceller on and off.
 * `env -u ELECTRON_RUN_AS_NODE <electron> probe_aec.cjs`
 */
const { app, BrowserWindow, session } = require('electron')
const { createServer } = require('node:http')

const page = '<!doctype html><meta charset="utf-8"><body>probe</body>'

const script = `
  (async () => {
    const out = {}
    async function measure(cancellation) {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: cancellation, noiseSuppression: false, autoGainControl: false },
      })
      const ctx = new AudioContext({ sampleRate: 16000 })
      const source = ctx.createMediaStreamSource(stream)
      const processor = ctx.createScriptProcessor(1024, 1, 1)
      let sum = 0, samples = 0
      processor.onaudioprocess = (event) => {
        const data = event.inputBuffer.getChannelData(0)
        for (let i = 0; i < data.length; i += 1) { sum += data[i] * data[i]; samples += 1 }
      }
      source.connect(processor)
      const sink = ctx.createGain()
      sink.gain.value = 0
      processor.connect(sink)
      sink.connect(ctx.destination)
      const read = () => {
        const rms = samples ? Math.sqrt(sum / samples) : 0
        sum = 0; samples = 0
        return Number(rms.toFixed(4))
      }
      await new Promise((r) => setTimeout(r, 700))
      const quiet = read()
      // Speak through the same page: 440 Hz at a level a read-aloud would plausibly reach.
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = 440
      gain.gain.value = 0.25
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start()
      await new Promise((r) => setTimeout(r, 900))
      const during = read()
      try { osc.stop() } catch (error) {}
      await new Promise((r) => setTimeout(r, 500))
      const after = read()
      processor.onaudioprocess = null
      try { source.disconnect(); processor.disconnect(); sink.disconnect() } catch (error) {}
      for (const t of stream.getTracks()) t.stop()
      try { await ctx.close() } catch (error) {}
      return { echoCancellation: cancellation, quiet, during, after }
    }
    out.withCanceller = await measure(true)
    out.withoutCanceller = await measure(false)
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
