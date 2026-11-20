/**
 * Does an `<img>` with no source really paint a broken-image box, and does a transparent pixel stop it?
 *
 * This is the one question left, and it is worth a picture rather than an argument. The strip's peek
 * deliberately takes the picture off the ball for the dwell between the ball appearing and the arrival
 * clip landing (`openDockPeek`), so "the element has no picture" is a state this page puts itself in on
 * purpose. Whether Chromium answers that state with *nothing* or with a white box and a glyph decides
 * whether the flash is a bug in the state or a bug in how the state is expressed.
 *
 * Two ways to express it, side by side on one element, same stylesheet, same instant of capture:
 *
 *   A. `removeAttribute('src')` — what the page does today. The element has no source at all.
 *   B. `src = <1x1 transparent GIF>` — the same "nothing to look at", but as a picture that exists.
 *
 * Both are captured in the docked+peek state with the real `floating.css`, so whatever appears is what
 * the user sees. Usage: `probe_blank_frame.mjs`
 */

import { writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const WORK = join(tmpdir(), 'dsh-orb-blank-probe')

// The smallest thing that is still a valid picture: a 1x1 fully transparent GIF.
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const html = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="floating.css">
<style>html, body { background: #2b2b30 !important; }</style></head>
<body class="docked docked-right docked-peek">
  <button id="dock-tab"></button>
  <button id="ball" type="button"><img id="ball-gif" src="deepseek-avatar-square.gif" alt=""></button>
  <script src="blank.js"></script>
</body></html>`

mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'probe.html'), html)
writeFileSync(join(WORK, 'blank.js'), `window.__blank = ${JSON.stringify(BLANK)}\n`)
copyFileSync(join(ASSETS, 'floating.css'), join(WORK, 'floating.css'))

writeFileSync(join(WORK, 'main.js'), `
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const path = require('path')

app.disableHardwareAcceleration()
app.setPath('cache', path.join(__dirname, 'cache'))
app.setPath('sessionData', path.join(__dirname, 'session'))

const shots = []
const shoot = async (win, name) => {
  shots.push({ name, b64: (await win.webContents.capturePage()).toPNG().toString('base64') })
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 800, height: 600, show: false, frame: false, backgroundColor: '#2b2b30',
    })
    await win.loadFile(path.join(__dirname, 'probe.html'))
    // Let the avatar settle so the only thing under test is the state being expressed.
    await new Promise((r) => setTimeout(r, 5000))

    const state = () => win.webContents.executeJavaScript(\`(() => {
      const b = document.querySelector('#ball-gif')
      const box = b.getBoundingClientRect()
      return JSON.stringify({
        hasSrc: b.hasAttribute('src'), complete: b.complete, naturalWidth: b.naturalWidth,
        src: String(b.getAttribute('src')).slice(0, 34),
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      })
    })()\`, true)

    // A: the page's own way of saying "no picture".
    await win.webContents.executeJavaScript("document.querySelector('#ball-gif').removeAttribute('src')", true)
    await new Promise((r) => setTimeout(r, 250))
    console.log('A removeAttribute:', await state())
    await shoot(win, 'A-removeAttribute')

    // B: a picture that is nothing.
    await win.webContents.executeJavaScript("document.querySelector('#ball-gif').src = window.__blank", true)
    await new Promise((r) => setTimeout(r, 250))
    console.log('B transparent pixel:', await state())
    await shoot(win, 'B-blank-pixel')

    // C: back to a real clip, to be sure B left the element usable.
    await win.webContents.executeJavaScript("document.querySelector('#ball-gif').src = 'deepseek-avatar-square.gif'", true)
    await new Promise((r) => setTimeout(r, 1200))
    console.log('C restored:', await state())
    await shoot(win, 'C-restored')

    writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(shots))
    app.exit(0)
  } catch (error) {
    console.log('FAILED:', error && error.message ? error.message : String(error))
    app.exit(1)
  }
})
`)

writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: 'dsh-orb-blank-probe', main: 'main.js' }))
console.log(`work dir: ${WORK}`)
const child = spawn(ELECTRON, ['.'], { cwd: WORK, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
child.on('exit', (code) => process.exit(code ?? 0))
