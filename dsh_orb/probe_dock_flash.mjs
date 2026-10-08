/**
 * Render the real page and look at what is actually painted.
 *
 * Every guess about this flash has been wrong so far, and they were all wrong the same way: reading the
 * code and predicting what a browser would do with it. The one thing that settles it is a picture of
 * the real thing — the real stylesheet, the real GIF, the real decode — and this produces one. Chromium's
 * broken-image placeholder is painted by the engine, so nothing short of Chromium can show whether it
 * appears at all.
 *
 * Two things had to be got right for this to be worth running, and both were got wrong first:
 *
 *   - `ball-drawn` has to be on the body. The shipped stylesheet hides the picture when that class is
 *     absent, so without it every screenshot is of an empty stage — which reads as "no placeholder"
 *     when it only means "no ball". A probe that hides the thing it is looking at reports a clean
 *     result and is worse than no probe.
 *
 *   - the swap has to be a `data:` URL. The helper hands the clip over that way (`memes.ts` reads the
 *     bytes and base64s them), and a `data:` URL is new to the renderer every time, so it really does
 *     have to decode. A `file://` path would come from a cache this script had already warmed, and a
 *     cached decode is precisely the case that cannot produce a placeholder.
 *
 * Captures bracket the swap tightly — the same task, then 30ms, then settled — because a placeholder is
 * a between state and anything slower than that will step straight over it.
 *
 * Usage: `probe_dock_flash.mjs`
 */

import { writeFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const PACK = join(homedir(), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const WORK = join(tmpdir(), 'dsh-orb-flash-probe')

const CLIP = '冒泡 1登场水平翻转.gif'
const AVATAR = 'deepseek-avatar-square.gif'

if (!existsSync(join(PACK, CLIP))) {
  console.error(`FAIL  ${CLIP} is not in the pack`)
  process.exit(1)
}

// The clip the way the helper hands it over: bytes, then base64, then a `data:` URL. This is the one
// input that decides whether the probe can reproduce anything at all.
const clipUrl = `data:image/gif;base64,${readFileSync(join(PACK, CLIP)).toString('base64')}`

const probeHtml = `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="floating.css">
<style>
  /* The page runs in a frameless transparent window: no chrome, and the desktop behind it. A light
     backdrop would hide a light-edged box, which is the one thing being looked for, so it is dark. */
  html, body { background: #2b2b30 !important; }
</style></head>
<body class="docked docked-right docked-peek">
  <button id="dock-tab"></button>
  <button id="ball" type="button"><img id="ball-gif" src="${AVATAR}" alt=""></button>
  <script src="clip.js"></script>
</body></html>`

mkdirSync(WORK, { recursive: true })
writeFileSync(join(WORK, 'probe.html'), probeHtml)
copyFileSync(join(ASSETS, 'floating.css'), join(WORK, 'floating.css'))
copyFileSync(join(ASSETS, AVATAR), join(WORK, AVATAR))

// The swap happens inside the page rather than through \`executeJavaScript\`, because everything passed
// into \`executeJavaScript\` has to survive Electron's structured clone over IPC and a 1.7MB string of
// base64 on that path is fragile — in an earlier run of this probe it failed outright with \`An object
// could not be cloned\`. Loaded by a \`<script src>\` instead, so this file stays about the question
// rather than about escaping.
// \`ball-drawn\` is *not* written into the markup, and that is the point of this run. The shipped
// \`armBallPicture\` shadows \`src\` on the element: the setter removes \`ball-drawn\` before handing the new
// source on, and the element's own \`load\` puts it back. Writing the class in by hand, as an earlier
// run of this probe did, skips the only code under suspicion — and that run then reported a clean
// result, which is what sent this bug down three more wrong theories. So the real \`armBallPicture\` is
// pasted here verbatim, read out of the shipped page, rather than paraphrased: a paraphrase that drifted
// would be a worse probe than no probe.
writeFileSync(join(WORK, 'clip.js'), `
window.__clip = ${JSON.stringify(clipUrl)}

${readFileSync(join(ASSETS, 'shell.js'), 'utf8').match(/function armBallPicture\(\) \{[\s\S]*?\n  \}/)[0]}
armBallPicture()

window.__state = () => {
  const b = document.querySelector('#ball-gif')
  const box = b.getBoundingClientRect()
  const style = getComputedStyle(b)
  // A string, not an object: every value crossing back into the main process goes through the same
  // clone, and JSON is both safe to cross and easier to read in the log than an object dump.
  return JSON.stringify({
    complete: b.complete,
    naturalWidth: b.naturalWidth,
    // What is actually on screen, which is the question: an element with no bitmap still has a box.
    visibility: style.visibility,
    drawn: document.body.classList.contains('ball-drawn'),
    box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
  })
}
window.__swap = () => { document.querySelector('#ball-gif').src = window.__clip; return window.__state() }
`)

// The clip is handed to the page the way the helper hands it over — bytes, then base64, then a
// \`data:\` URL — and it is loaded by a \`<script src>\` rather than through \`executeJavaScript\`. That
// matters for a mechanical reason: everything passed into \`executeJavaScript\` has to survive Electron's
// structured clone over IPC, and a 1.7MB string of base64 on that path is both fragile and, in an
// earlier run of this probe, the direct cause of \`An object could not be cloned\`. A script tag has no
// such constraint. The clip is copied next to the page as \`clip.js\`; see above.
const mainJs = `
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('fs')
const path = require('path')

app.disableHardwareAcceleration()
// Its own cache directory. Earlier runs shared one and fought over it — several Electron instances at
// once, each logging \`Unable to move the cache\` and \`Gpu Cache Creation failed\` — and a probe whose
// disk cache is broken cannot be trusted about what did or did not decode.
app.setPath('cache', path.join(__dirname, 'cache'))
app.setPath('sessionData', path.join(__dirname, 'session'))

const shots = []
const shoot = async (win, name) => {
  shots.push({ name, b64: (await win.webContents.capturePage()).toPNG().toString('base64') })
}

const fail = (error) => {
  // A probe that dies quietly leaves a stale screenshot and a clean-looking silence, which is how the
  // earlier runs of this looked like results. Say what failed, and quit, so the log can be believed.
  console.log('FAILED:', error && error.message ? error.message : String(error))
  app.exit(1)
}

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 800, height: 600, show: false, frame: false, transparent: false,
      backgroundColor: '#2b2b30',
    })
    await win.loadFile(path.join(__dirname, 'probe.html'))

    // The 7.7MB avatar has to finish first: that is the state the page is really in by the time a
    // pointer arrives, and a half-decoded avatar is a confound rather than the thing being looked for.
    await new Promise((r) => setTimeout(r, 5000))
    const state = () => win.webContents.executeJavaScript('window.__state()', true)

    console.log('BEFORE:', await state())
    await shoot(win, '1-wearing-the-avatar')

    console.log('AT THE SWAP:', await win.webContents.executeJavaScript('window.__swap()', true))
    await shoot(win, '2-the-instant-after')

    await new Promise((r) => setTimeout(r, 30))
    console.log('AT 30ms:', await state())
    await shoot(win, '3-thirty-ms')

    await new Promise((r) => setTimeout(r, 2000))
    console.log('SETTLED:', await state())
    await shoot(win, '4-settled')

    writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify(shots))
    app.exit(0)
  } catch (error) {
    fail(error)
  }
})`

writeFileSync(join(WORK, 'main.js'), mainJs)
// Electron takes a module path as its first argument, so the directory has to look like a package.
writeFileSync(join(WORK, 'package.json'), JSON.stringify({ name: 'dsh-orb-flash-probe', main: 'main.js' }))

console.log(`clip as a data: URL: ${Math.round(clipUrl.length / 1024)} KB`)
console.log(`work dir: ${WORK}`)
console.log('starting electron...')
const child = spawn(ELECTRON, ['.'], {
  cwd: WORK,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})
child.on('exit', (code) => process.exit(code ?? 0))
