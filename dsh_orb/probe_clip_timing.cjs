/**
 * Measure the acknowledgement clips the way the page plays them.
 *
 * `whenVoiceDone()` resolves on `ended`, so the file's own length is the wait between a wake and
 * the microphone — unless the file carries silence that nobody hears. This probe plays each take
 * through a real `<audio>` element in a real Chromium, which is the only way to see the two numbers
 * that matter: how long `play()` takes to make a sound at all (decode plus output start), and how
 * long it then runs.
 *
 * Trimmed and original takes are measured side by side so the saving is a measurement, not a
 * subtraction done on paper.
 *
 * `env -u ELECTRON_RUN_AS_NODE <electron> probe_clip_timing.cjs` — prints JSON and exits.
 */
const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const clips = [
  ['c1', join(root, 'packages/helper/assets/voices/c1.wav'), join(root, 'dsh_orb/voices-orig/c1.wav.bak-orig')],
  ['c2', join(root, 'packages/helper/assets/voices/c2.wav'), join(root, 'dsh_orb/voices-orig/c2.wav.bak-orig')],
  ['c3', join(root, 'packages/helper/assets/voices/c3.wav'), join(root, 'dsh_orb/voices-orig/c3.wav.bak-orig')],
]

const payload = {}
for (const [name, trimmed, original] of clips) {
  payload[`${name}-trimmed`] = `data:audio/wav;base64,${readFileSync(trimmed).toString('base64')}`
  payload[`${name}-original`] = `data:audio/wav;base64,${readFileSync(original).toString('base64')}`
}

const page = `<!doctype html><meta charset="utf-8"><body>probe</body>`

const script = `
  (async () => {
    const clips = ${JSON.stringify(payload)}
    const out = {}
    for (const [name, url] of Object.entries(clips)) {
      const audio = new Audio(url)
      audio.preload = 'auto'
      const started = performance.now()
      let firstSound = 0
      audio.addEventListener('playing', () => { firstSound = performance.now() - started })
      const ended = new Promise((resolve) => {
        audio.addEventListener('ended', () => resolve(performance.now() - started))
        audio.addEventListener('error', () => resolve(-1))
      })
      let refused = ''
      try { await audio.play() } catch (error) { refused = String(error && error.message ? error.message : error) }
      const total = await ended
      out[name] = {
        // What the user waits before hearing anything: load plus decode plus the output device.
        startMs: Math.round(firstSound),
        // What \`whenVoiceDone\` waits for: the file's end, silence included.
        totalMs: Math.round(total),
        refused,
      }
    }
    return JSON.stringify(out, null, 2)
  })()
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 400, height: 200, show: false })
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`)
    console.log(await win.webContents.executeJavaScript(script))
  } catch (error) {
    console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
  }
  app.quit()
}).catch((error) => {
  console.log(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
  app.quit()
})
