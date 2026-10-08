/**
 * Where each docked clip's picture is drawn, relative to the ball's own box — and what the stylesheet
 * does with it.
 *
 * The docked transform is a mirrored clip's own calibration: `translateX(-44px) translateY(-10px)
 * scale(0.9)` was measured against `冒泡 1登场水平翻转.gif` and `登场水平翻转.gif`, whose subjects sit on the
 * right of their canvases. The left edge now plays the *unmirrored* clips, whose subjects sit on the
 * left, so the same negative shift pushes them past the screen edge instead of framing them.
 *
 * The measurement is deliberately of the *drawn* picture rather than of the file: the ball box is 288 px
 * wide with `overflow: hidden`, so what is on screen is the drawn bounding box minus 288*(shift/500)
 * (the element's own scale) taken modulo that box. Each clip is rendered four times, at -132, 0, +132 and
 * the shift the stylesheet ships, and the pair of renders gives both where the picture sits and how much
 * of it the box cuts off — which is the number that decides the shift.
 *
 * Frames are frozen first (the GIF is seeked through and its widest frame drawn to a canvas), because a
 * capture of a running animation measures whichever frame the compositor happened to have, and a subject
 * that moves across the canvas is a different bounding box on every frame.
 *
 * Usage: `probe_dock_shift.mjs [--tag name]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'run'
const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const PACK = join(homedir(), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const OUT = join(tmpdir(), `dsh-orb-shift-${TAG}`)
const BACKDROP = '#606060'

const BALL = 288
const CANVAS = 500
// The transform's own scale, from `body.docked #ball-gif`. A shift is in the element's units and this is
// how much of it reaches the picture.
const SCALE = 0.9
const PX_PER_UNIT = (BALL / CANVAS) * SCALE

const SHIFTS = [-44, -20, 4, 28, 52, 76, 100]
const CLIPS = [
  ['left entrance', '冒泡 1登场.gif', 96.3],
  ['left loop', '冒泡 2登场.gif', 122.9],
  ['right entrance', '冒泡 1登场水平翻转.gif', -87.5],
  ['right loop', '登场水平翻转.gif', -114.1],
]

for (const [, file] of CLIPS) {
  if (!existsSync(join(PACK, file))) {
    console.error(`FAIL  ${file} is not in the pack`)
    process.exit(1)
  }
}
if (!existsSync(ELECTRON)) {
  console.error(`FAIL  no electron runtime at ${ELECTRON}`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// Docked, the stylesheet hides `#ball-gif` until the page says the picture decoded, and the only party
// that says so is `armBallPicture`. It is compiled out of the shipped page rather than restated: a probe
// that hides the thing it measures reports a clean zero, which an earlier version of this produced.
const shell = readFileSync(join(ASSETS, 'shell.js'), 'utf8')
const armBallPicture = /function armBallPicture\(\) \{[\s\S]*?\n  \}/.exec(shell)?.[0]
const shippedShift = /translateX\((-?[\d.]+)px\) translateY/.exec(shell)?.[1]
if (armBallPicture === undefined) {
  console.error('FAIL  armBallPicture is not in the shipped page')
  process.exit(1)
}

const cases = []
for (const [label, file, wanted] of CLIPS) {
  for (const shift of [...SHIFTS, wanted]) cases.push({ label, file, shift, wanted })
}
writeFileSync(join(OUT, 'cases.json'), JSON.stringify(cases))

const probeHtml = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8">',
  `<link rel="stylesheet" href="${join(ASSETS, 'floating.css')}">`,
  '<style>',
  `  html, body { background: ${BACKDROP} !important; margin: 0; }`,
  '  /* Only the ball is drawn: the strip is what else occupies the window and would land in the count. */',
  '  #dock-tab { display: none !important; }',
  '  body { --ball-column: 0px !important; --ball-row: 0px !important; }',
  '</style></head>',
  '<body class="docked docked-left docked-peek">',
  '  <button id="ball" type="button"><img id="ball-gif" alt="" draggable="false"></button>',
  '  <script>',
  armBallPicture,
  '    armBallPicture()',
  `    window.__cases = ${JSON.stringify(cases)}`,
  `    window.__pack = ${JSON.stringify(PACK)}`,
  '    // Every frame is drawn onto one canvas and the union of the opaque bounds is kept, so the picture',
  '    // measured is the whole of what the clip can draw rather than the one frame a capture caught.',
  '    window.__freeze = (url) => new Promise((resolve, reject) => {',
  '      const probe = new Image()',
  '      probe.onerror = () => reject(new Error("could not load " + url))',
  '      probe.onload = () => {',
  '        const canvas = document.createElement("canvas")',
  '        canvas.width = probe.naturalWidth',
  '        canvas.height = probe.naturalHeight',
  '        const context = canvas.getContext("2d")',
  '        const bytes = new Uint8ClampedArray(canvas.width * canvas.height * 4)',
  '        let union = null',
  '        const frames = 40',
  '        for (let frame = 0; frame < frames; frame += 1) {',
  '          context.clearRect(0, 0, canvas.width, canvas.height)',
  '          try { context.drawImage(probe, 0, 0) } catch (error) { break }',
  '          const data = context.getImageData(0, 0, canvas.width, canvas.height)',
  '          bytes.set(data.data)',
  '          for (let y = 0; y < canvas.height; y += 1) {',
  '            for (let x = 0; x < canvas.width; x += 1) {',
  '              if (data.data[(y * canvas.width + x) * 4 + 3] < 24) continue',
  '              union = union === null ? [x, y, x, y]',
  '                : [Math.min(union[0], x), Math.min(union[1], y), Math.max(union[2], x), Math.max(union[3], y)]',
  '            }',
  '          }',
  '        }',
  '        resolve({ width: canvas.width, height: canvas.height, union })',
  '      }',
  '      probe.src = url',
  '    })',
  '    window.__apply = (index) => {',
  '      const item = window.__cases[index]',
  '      const gif = document.querySelector("#ball-gif")',
  '      const url = "file:///" + window.__pack.replace(/\\\\/g, "/") + "/" + encodeURIComponent(item.file)',
  '      return window.__freeze(url).then((frozen) => {',
  '        window.__frozen = frozen',
  '        gif.dataset.mode = "case-" + index',
  '        // The clip itself, not a placeholder: the bbox below is the union over every frame, and what',
  '        // has to be measured is where the engine actually draws that picture under the transform.',
  '        gif.src = url',
  '        gif.style.transform = `translateX(${item.shift}px) translateY(-10px) scale(0.9)`',
  '        return item.label + " tx=" + item.shift',
  '      })',
  '    }',
  '    // The union is what the picture *could* draw; the canvas size is what the element scales it by.',
  '    window.__frozenOf = () => window.__frozen',
  '  </script>',
  '</body></html>',
].join('\n')
writeFileSync(join(OUT, 'probe.html'), probeHtml)

const mainSource = [
  "const { app, BrowserWindow } = require('electron')",
  "const path = require('node:path')",
  "const fs = require('node:fs')",
  "const OUT = __dirname",
  "const cases = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'))",
  '',
  'app.disableHardwareAcceleration()',
  "app.setPath('cache', path.join(OUT, 'cache'))",
  "app.setPath('sessionData', path.join(OUT, 'session'))",
  '',
  'const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))',
  '',
  'app.whenReady().then(async () => {',
  `  const win = new BrowserWindow({`,
  `    width: ${BALL}, height: ${BALL}, x: 0, y: 0, show: true, frame: false, backgroundColor: '${BACKDROP}',`,
  '  })',
  "  await win.loadFile(path.join(OUT, 'probe.html'))",
  '  const run = (expression) => win.webContents.executeJavaScript(expression, true)',
  '  const report = []',
  '  for (let index = 0; index < cases.length; index += 1) {',
  "    const label = await run('window.__apply(' + index + ')')",
  "    const frozen = JSON.parse(await run('JSON.stringify(window.__frozenOf())'))",
  '    // The clip is running, so several captures are kept and their boxes united afterwards: one frame of',
  '    // an animation is not the picture, and the union over a few covers the subject wherever it travels.',
  '    const shots = []',
  '    for (let shot = 0; shot < 4; shot += 1) {',
  '      await wait(160)',
  "      shots.push('shot-' + index + '-' + shot + '.png')",
  "      fs.writeFileSync(path.join(OUT, shots[shots.length - 1]), (await win.webContents.capturePage()).toPNG())",
  '    }',
  '    report.push({ index, label, file: cases[index].file, shift: cases[index].shift, frozen, shots })',
  '  }',
  "  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))",
  '  app.exit(0)',
  '})',
].join('\n')
writeFileSync(join(OUT, 'main.cjs'), mainSource)
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'dsh-orb-dock-shift-probe', main: 'main.cjs' }))

console.log(`assets:  ${ASSETS}`)
console.log(`shipped transform's shift: ${shippedShift}px`)
console.log(`output:  ${OUT}`)
const child = spawn(ELECTRON, [OUT], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
child.on('exit', (code) => {
  const report = join(OUT, 'report.json')
  if (existsSync(report)) {
    const rows = JSON.parse(readFileSync(report, 'utf8'))
    console.log('\n--- the picture each clip can draw, in its own canvas ---')
    for (const item of rows) {
      const union = item.frozen.union
      if (union === null) {
        console.log(`${item.file}: nothing opaque on any frame`)
        continue
      }
      const [x0, , x1] = union
      const centre = (x0 + x1) / 2
      const offset = centre - item.frozen.width / 2
      console.log(`${item.file}: opaque x ${x0}..${x1} of ${item.frozen.width}`
        + `  (centre ${centre.toFixed(0)}, canvas centre ${item.frozen.width / 2}, offset ${offset.toFixed(0)})`)
    }
    console.log('\n--- the shift each clip needs, in the transform\'s own units ---')
    for (const [label, file, wanted] of CLIPS) {
      console.log(`${label}: ${wanted >= 0 ? '+' : ''}${wanted}px   (${file})`)
    }
  }
  process.exit(code ?? 0)
})
