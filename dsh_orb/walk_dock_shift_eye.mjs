/**
 * The two transforms, rendered side by side as the eye sees them.
 *
 * The numbers above say `+44` frames both left clips and `-44` frames both right ones; this is the check
 * that the framing is the *intended* one rather than merely a box inside a box. Each case is the ball box
 * with the band a peek can show marked, at the hands' own scale, on the real clips.
 *
 * Usage: `walk_dock_shift_eye.mjs [--tag name]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'eye'
const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const PACK = join(homedir(), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const OUT = join(tmpdir(), `dsh-orb-eye-${TAG}`)

const CASES = [
  { side: 'left', shift: -44, file: '冒泡 1登场.gif', note: 'left entrance, the shipped transform' },
  { side: 'left', shift: 44, file: '冒泡 1登场.gif', note: 'left entrance, +44' },
  { side: 'left', shift: -44, file: '冒泡 2登场.gif', note: 'left loop, the shipped transform' },
  { side: 'left', shift: 44, file: '冒泡 2登场.gif', note: 'left loop, +44' },
  { side: 'right', shift: -44, file: '冒泡 1登场水平翻转.gif', note: 'right entrance (reference)' },
  { side: 'right', shift: -44, file: '登场水平翻转.gif', note: 'right loop (reference)' },
]

for (const item of CASES) {
  if (!existsSync(join(PACK, item.file))) {
    console.error(`FAIL  ${item.file} is not in the pack`)
    process.exit(1)
  }
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'cases.json'), JSON.stringify(CASES))

// Docked, the stylesheet hides the picture until the page says it decoded, and the page says so only
// through `armBallPicture` — compiled out of the shipped script, as the other probes do.
const shell = readFileSync(join(ASSETS, 'shell.js'), 'utf8')
const armBallPicture = /function armBallPicture\(\) \{[\s\S]*?\n  \}/.exec(shell)?.[0]
if (armBallPicture === undefined) {
  console.error('FAIL  armBallPicture is not in the shipped page')
  process.exit(1)
}

const html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  `<link rel="stylesheet" href="${join(ASSETS, 'floating.css')}">`,
  '<style>',
  '  html, body { margin: 0; background: rgba(0,0,0,0); }',
  '  #ball { display: none; }',
  '  body.show #ball { display: block; }',
  '  /* Where the display edge is, drawn for the eye only: nothing in the page draws it. */',
  '  #edge { position: absolute; top: 0; bottom: 0; width: 2px; background: #e04040; z-index: 5; }',
  '</style></head>',
  '<body class="docked docked-left docked-peek show">',
  '  <button id="ball" type="button"><img id="ball-gif" alt="" draggable="false"></button>',
  '  <div id="edge"></div>',
  '<script>',
  armBallPicture,
  '  armBallPicture()',
  `  window.__cases = ${JSON.stringify(CASES)}`,
  `  window.__pack = ${JSON.stringify(PACK)}`,
  '  window.__apply = (index) => {',
  '    const item = window.__cases[index]',
  '    const gif = document.querySelector("#ball-gif")',
  '    document.body.classList.toggle("docked-left", item.side === "left")',
  '    document.body.classList.toggle("docked-right", item.side === "right")',
  '    gif.dataset.mode = "case-" + index',
  '    gif.src = "file:///" + window.__pack.replace(/\\\\/g, "/") + "/" + encodeURIComponent(item.file)',
  '    gif.style.transform = `translateX(${item.shift}px) translateY(-10px) scale(0.9)`',
  '    // The band a peek can show, in the ball box: the trailing half on the left edge, the leading half',
  '    // on the right. The window is the ball box, so the red line stands at the ball\'s own middle.',
  '    document.querySelector("#edge").style.left = (item.side === "left" ? 144 : 144) + "px"',
  '    return item.note',
  '  }',
  '</script></body></html>',
].join('\n')
writeFileSync(join(OUT, 'probe.html'), html)

const main = [
  "const { app, BrowserWindow } = require('electron')",
  "const path = require('node:path')",
  "const fs = require('node:fs')",
  'const OUT = __dirname',
  "const cases = JSON.parse(fs.readFileSync(path.join(OUT, 'cases.json'), 'utf8'))",
  'app.disableHardwareAcceleration()',
  "app.setPath('cache', path.join(OUT, 'cache'))",
  "app.setPath('sessionData', path.join(OUT, 'session'))",
  'const wait = (ms) => new Promise((r) => setTimeout(r, ms))',
  'app.whenReady().then(async () => {',
  "  const win = new BrowserWindow({ width: 288, height: 288, x: 0, y: 0, show: true, frame: false, transparent: true })",
  "  await win.loadFile(path.join(OUT, 'probe.html'))",
  '  const run = (e) => win.webContents.executeJavaScript(e, true)',
  '  for (let index = 0; index < cases.length; index += 1) {',
  "    const note = await run('window.__apply(' + index + ')')",
  '    await wait(600)',
  "    fs.writeFileSync(path.join(OUT, 'case-' + index + '.png'), (await win.webContents.capturePage()).toPNG())",
  "    console.log('rendered: ' + note)",
  '  }',
  '  app.exit(0)',
  '})',
].join('\n')
writeFileSync(join(OUT, 'main.cjs'), main)
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'dsh-orb-eye', main: 'main.cjs' }))
console.log(`output: ${OUT}`)
const child = spawn(ELECTRON, [OUT], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
child.on('exit', (code) => process.exit(code ?? 0))
