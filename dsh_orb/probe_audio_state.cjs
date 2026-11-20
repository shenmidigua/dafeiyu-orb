/**
 * Ask a real Electron renderer two questions the unit tests cannot answer:
 *
 * 1. Can a page start an `AudioContext` without a click? The cues fire on a wake word, which is
 *    speech, not a gesture — if Chromium leaves the context suspended the switch would appear to
 *    work while everything stayed silent.
 * 2. Does the context actually produce signal? An oscillator is rendered into an `AnalyserNode`
 *    and measured, so "no sound" can be told apart from "no code".
 *
 * `npx electron probe_audio_state.cjs` — prints JSON and exits.
 */
const { app, BrowserWindow } = require('electron')

const page = `<!doctype html><meta charset="utf-8"><body>probe</body>`

const script = `
  (async () => {
    const out = { hasCtor: typeof AudioContext === 'function' }
    let ctx
    try {
      ctx = new AudioContext()
      out.stateAtCreate = ctx.state
      if (ctx.state !== 'running') {
        try { await ctx.resume(); out.resumeError = null } catch (error) { out.resumeError = String(error) }
      }
      out.stateAfterResume = ctx.state

      // One cue's worth of signal through an analyser: proves the graph runs, not just exists.
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      osc.type = 'sine'
      osc.frequency.setValueAtTime(1568, ctx.currentTime)
      gain.gain.value = 0.4
      osc.connect(gain)
      gain.connect(analyser)
      analyser.connect(ctx.destination)
      osc.start()
      await new Promise((r) => setTimeout(r, 120))
      const buf = new Float32Array(analyser.fftSize)
      analyser.getFloatTimeDomainData(buf)
      let peak = 0
      for (const v of buf) peak = Math.max(peak, Math.abs(v))
      out.peak = Number(peak.toFixed(4))
      osc.stop()
      await ctx.close()
    } catch (error) {
      out.error = String(error && error.message ? error.message : error)
      try { if (ctx) await ctx.close() } catch {}
    }
    return JSON.stringify(out)
  })()
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 200, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
  const result = await win.webContents.executeJavaScript(script)
  console.log(result)
  app.quit()
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
  app.quit()
})
