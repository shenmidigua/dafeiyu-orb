/**
 * What a docked clip's picture measures as, in the band a peek can show — read from the page itself.
 *
 * Screenshotting this page turned out to be the wrong instrument: the ball's window is transparent and
 * frameless, and a capture of it came back with the composited content missing, so every case read as the
 * same picture. `getBoundingClientRect()` on the image is the measurement that does not depend on the
 * compositor at all: it is the box the element actually occupies after its transform, and the ball's own
 * box is what clips it.
 *
 *   * a left-docked ball can show the ball box's trailing half — local x 144..288
 *   * a right-docked ball can show its leading half — local x 0..144
 *
 * The transform is applied identically by every case; what differs is which clip and which shift.
 *
 * Usage: `walk_dock_shift_rect.mjs [--tag name]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'rect'
const PACK = join(homedir(), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const OUT = join(tmpdir(), `dsh-orb-rect-${TAG}`)

const CLIPS = [
  ['冒泡 1登场.gif', 192, 'left entrance'],
  ['冒泡 2登场.gif', 411, 'left loop'],
  ['冒泡 1登场水平翻转.gif', 198, 'right entrance'],
  ['登场水平翻转.gif', 432, 'right loop'],
]

for (const [file] of CLIPS) {
  if (!existsSync(join(PACK, file))) {
    console.error(`FAIL  ${file} is not in the pack`)
    process.exit(1)
  }
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// One ball box per clip, each with its own shift, all in the same page: the boxes are absolutely
// positioned at the window origin by the stylesheet, so each case is measured on its own element.
const html = [
  '<!doctype html><html><head><meta charset="utf-8">',
  '<style>',
  '  body { margin: 0; background: #202024; }',
  '  .box { position: absolute; top: 0; width: 288px; height: 288px; overflow: hidden; }',
  '  .box img { width: 100%; height: 100%; object-fit: cover; }',
  '</style></head><body>',
  ...CLIPS.map(([file, , label], index) =>
    `  <div class="box" id="box-${index}" style="left:${index * 300}px">`
    + `<img id="img-${index}" src="file:///${PACK.replace(/\\/g, '/')}/${encodeURIComponent(file)}" alt=""></div>`),
  '<script>',
  `  window.__clips = ${JSON.stringify(CLIPS)}`,
  '  // Set before the first measure: the page is asked whether the pictures loaded before any shift has',
  '  // been applied, and reading an undefined list there stops the whole run.',
  '  window.__shift = window.__clips.map(() => 0)',
  '  window.__band = window.__clips.map((clip, index) => (index < 2 ? [144, 288] : [0, 144]))',
  '  window.__measure = () => window.__clips.map((clip, index) => {',
  '    const image = document.querySelector("#img-" + index)',
  '    const box = document.querySelector("#box-" + index).getBoundingClientRect()',
  '    const rect = image.getBoundingClientRect()',
  '    return {',
  '      label: clip[2], file: clip[0], opaqueWidth: clip[1],',
  '      shift: window.__shift[index],',
  '      complete: image.complete, natural: { w: image.naturalWidth, h: image.naturalHeight },',
  '      drawn: { left: Math.round(rect.left - box.left), right: Math.round(rect.right - box.left) },',
  '      band: window.__band[index],',
  '    }',
  '  })',
  '  window.__apply = (shifts, bands) => {',
  '    window.__shift = shifts; window.__band = bands',
  '    document.querySelectorAll(".box img").forEach((image, index) => {',
  '      image.style.transform = "translateX(" + shifts[index] + "px) translateY(-10px) scale(0.9)"',
  '    })',
  '    return true',
  '  }',
  '</script></body></html>',
].join('\n')
writeFileSync(join(OUT, 'probe.html'), html)

const main = [
  "const { app, BrowserWindow } = require('electron')",
  "const path = require('node:path')",
  "const fs = require('node:fs')",
  'const OUT = __dirname',
  'app.disableHardwareAcceleration()',
  "app.setPath('cache', path.join(OUT, 'cache'))",
  "app.setPath('sessionData', path.join(OUT, 'session'))",
  'const wait = (ms) => new Promise((r) => setTimeout(r, ms))',
  'const SHIFTS = [-44, -20, 4, 28, 52, 76, 100, 124, 148]',
  'app.whenReady().then(async () => {',
  '  const win = new BrowserWindow({ width: 1400, height: 320, show: true, frame: false, backgroundColor: "#202024" })',
  "  await win.loadFile(path.join(OUT, 'probe.html'))",
  '  const run = (e) => win.webContents.executeJavaScript(e, true)',
  '  for (let attempt = 0; attempt < 80; attempt += 1) {',
  "    const ready = await run('window.__measure().every((item) => item.complete && item.natural.w > 0)')",
  '    if (ready) break',
  '    await wait(100)',
  '  }',
  '  const table = []',
  '  for (const shift of SHIFTS) {',
  '    const bands = [[144, 288], [144, 288], [0, 144], [0, 144]]',
  '    await run("window.__apply(" + JSON.stringify(SHIFTS.map(() => shift)) + ", " + JSON.stringify(bands) + ")")',
  '    await wait(60)',
  "    const rows = JSON.parse(await run('JSON.stringify(window.__measure())'))",
  '    table.push({ shift, rows })',
  '  }',
  "  fs.writeFileSync(path.join(OUT, 'measure.json'), JSON.stringify(table, null, 2))",
  '  app.exit(0)',
  '})',
].join('\n')
writeFileSync(join(OUT, 'main.cjs'), main)
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'dsh-orb-rect', main: 'main.cjs' }))
console.log(`output: ${OUT}`)
const child = spawn(ELECTRON, [OUT], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
child.on('exit', (code) => {
  console.log(`\nmeasure.json is in ${OUT}`)
  process.exit(code ?? 0)
})
