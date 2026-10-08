/**
 * Reproduce the docked-hover flash against the real stylesheet and the real `armBallPicture`.
 *
 * The question this exists to answer, in one line: when a peeked ball's picture is taken away with
 * `removeAttribute('src')`, what does Chromium actually paint — the element's own broken-image box, or
 * nothing? Reading the code and predicting is what has been wrong every time, so this renders it.
 *
 * The sequence walked is the page's own, in the page's own order:
 *
 *   1  the ball wears its idle loop        (the state it is in behind the strip)
 *   2  `openDockPeek`'s own line           `gif.removeAttribute('src')` with `docked-peek` on the body
 *   3  the 120 ms dwell that follows       `DOCK_ARRIVE_DWELL_MS` — this is the window under suspicion
 *   4  the entrance lands                  `gif.src = <the arrival clip>`
 *
 * The state is read from the element itself (`complete`, `naturalWidth`, computed `visibility`, and
 * whether `ball-drawn` is on the body) and a screenshot is taken at each step, because a state that
 * reads clean can still be a frame of white box.
 *
 * Usage: `electron.exe .` from this directory (see `probe_dock_empty.mjs`).
 */

const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const ASSETS = process.argv[2]
const OUT = process.argv[3]

app.disableHardwareAcceleration()
app.setPath('cache', path.join(OUT, 'cache'))
app.setPath('sessionData', path.join(OUT, 'session'))

const armBallPicture = /function armBallPicture\(\) \{[\s\S]*?\n  \}/.exec(
  readFileSync(path.join(ASSETS, 'shell.js'), 'utf8'),
)[0]

// The page, as close to the shipped one as a probe can be: the real stylesheet by its own path, the
// real image markup, and the real `armBallPicture` compiled out of the shipped script rather than
// paraphrased. `body.docked.docked-peek` is the state the strip's hover puts the page in.
const probeHtml = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="${path.join(ASSETS, 'floating.css')}">
<style>
  /* The real window is frameless and transparent over the wallpaper. A flat dark backdrop is used
     instead so a light-edged box has something to be seen against — the same choice the earlier probe
     made, and for the same reason. */
  html, body { background: #2b2b30 !important; }
</style></head>
<body class="docked docked-right">
  <button id="dock-tab" type="button"></button>
  <button id="ball" type="button"><img id="ball-gif" src="${path.join(ASSETS, 'deepseek-avatar-square.gif')}" alt="" draggable="false"></button>
  <script>
    window.__states = []
    window.__record = (label) => {
      const gif = document.querySelector('#ball-gif')
      const style = getComputedStyle(gif)
      const box = gif.getBoundingClientRect()
      window.__states.push({
        label,
        at: Math.round(performance.now()),
        hasSrcAttribute: gif.hasAttribute('src'),
        srcHead: String(gif.getAttribute('src') || '').slice(0, 48),
        complete: gif.complete,
        naturalWidth: gif.naturalWidth,
        visibility: style.visibility,
        drawn: document.body.classList.contains('ball-drawn'),
        box: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
      })
    }
  </script>
  <script>
    ${armBallPicture}
    armBallPicture()
    window.__arm = armBallPicture
  </script>
</body></html>`

writeFileSync(path.join(OUT, 'probe.html'), probeHtml)

const shots = []
const shoot = async (win, name) => {
  const image = await win.webContents.capturePage()
  writeFileSync(path.join(OUT, `${name}.png`), image.toPNG())
  shots.push(name)
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 800, height: 420, show: true, frame: false,
    backgroundColor: '#2b2b30', x: 80, y: 80,
  })
  await win.loadFile(path.join(OUT, 'probe.html'))
  const run = (expression) => win.webContents.executeJavaScript(expression, true)

  // The 7.7MB avatar has to be decoded first: that is the state the ball is really in by the time a
  // pointer arrives, and a half-decoded avatar would be a confound rather than the thing looked for.
  for (let i = 0; i < 100; i += 1) {
    const ready = await run("(() => { const g = document.querySelector('#ball-gif'); return g.complete && g.naturalWidth > 0 })()")
    if (ready) break
    await wait(100)
  }
  await wait(500)

  // 1 — the ball as the strip left it: the idle loop, drawn, hidden only because the peek is not up.
  await run("window.__record('docked: idle loop worn, no peek')")
  await shoot(win, '1-docked-idle')
  await run("document.body.classList.add('docked-peek')")
  await wait(60)
  await run("window.__record('peek up: the ball is visible, still wearing the loop')")
  await shoot(win, '2-peek-up')

  // 2 — the peek's own line, verbatim from `openDockPeek`.
  await run("document.querySelector('#ball-gif').removeAttribute('src')")
  await run("window.__record('the instant after removeAttribute(src)')")
  await shoot(win, '3-src-removed-now')

  // 3 — the dwell window. Samples are taken across it rather than at one end, because a placeholder is
  // a between state and a single late look steps straight over it.
  for (const ms of [16, 16, 16, 32, 32, 60, 120]) {
    await wait(ms)
    await run(`window.__record('dwell +${ms}ms')`)
  }
  await shoot(win, '4-during-dwell')

  // 4 — the entrance, exactly as `playDockArrive` hands it over.
  await run(`(() => {
    const gif = document.querySelector('#ball-gif')
    gif.dataset.mode = 'dock-arrive-1'
    gif.src = ${JSON.stringify(path.join(ASSETS, 'deepseek-avatar-square.gif'))}
    window.__record('the entrance was handed over')
  })()`)
  await shoot(win, '5-entrance-handover')
  await wait(120)
  await run("window.__record('entrance +120ms')")
  await shoot(win, '6-entrance-settled')

  // 5 — the *slow helper* ordering, which is the other half of the bug and the one the dwell's 120 ms is
  // really racing: the peek's round trip comes back after the dwell, so the strip happens on top of an
  // arrival that has already painted. `openDockPeek` now strips before it awaits, so this ordering should
  // no longer be reachable — but the gate has to hold for it anyway, and this renders that.
  await run("window.__record('slow peek: the arrival is on the ball, ball-drawn')")
  await shoot(win, '7-slow-peek-arrival-up')
  await run("document.querySelector('#ball-gif').removeAttribute('src')")
  await run("window.__record('slow peek: the strip lands after the arrival')")
  await shoot(win, '8-slow-peek-stripped')

  const states = await run('JSON.stringify(window.__states)')
  writeFileSync(path.join(OUT, 'states.json'), states)
  writeFileSync(path.join(OUT, 'shots.json'), JSON.stringify(shots))
  console.log(states)
  app.exit(0)
})
