/**
 * Put a host `turn` message through the real page and look at what the ball paints.
 *
 * The failure face has three layers — the host's reading of `turn/end`, the page's `setRunning`, and the
 * clip the pack names — and each is covered somewhere: `failure.test.ts` for the host's reading,
 * `turn-fail.test.ts` for the wiring, `memes.test.ts` for the slot. What none of them does is put a real
 * message through the real page and look at the picture, which is the one thing that catches a chain wired
 * correctly and still showing nothing.
 *
 * So this runs the shipped `floating.html` with the shipped `preload.cjs`, answers the IPC channels the
 * page asks about with the pack's own `fail` clip (read from the live `memes.json`), takes the page's own
 * `onTurn` callback, and hands it the message `finishTurn` broadcasts for a run that threw. The ball box is
 * captured before, during and after the hold.
 *
 * Usage: `probe_turn_face.mjs [--tag name] [--file <gif>] [--case failed|completed|aborted]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback)
const TAG = value('--tag', 'run')
const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const PACK = join(homedir(), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const OUT = join(tmpdir(), `dsh-orb-turn-${TAG}`)

// The clip the ball should wear: the live profile's `fail` slot, read from the config rather than named
// here, because "which file" is the pack's business and this probe is about the chain that reaches it.
const config = JSON.parse(readFileSync(join(homedir(), '.dsh', 'dsh-orb', 'memes.json'), 'utf8'))
const clipName = value('--file', config.fail?.file ?? '')
if (!clipName || !existsSync(join(PACK, clipName))) {
  console.error(`FAIL  the pack has no ${clipName}`)
  process.exit(1)
}
if (!existsSync(ELECTRON)) {
  console.error(`FAIL  no electron runtime at ${ELECTRON}`)
  process.exit(1)
}

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const clipUrl = `data:image/gif;base64,${readFileSync(join(PACK, clipName)).toString('base64')}`
// Through a file, not an argument: 2.4MB of base64 does not fit in a Windows command line, and the probe
// died with ENAMETOOLONG the first time it tried.
writeFileSync(join(OUT, 'clip.txt'), clipUrl)
console.log(`fail clip: ${clipName} (${Math.round(clipUrl.length / 1024)}KB as a data: URL)`)
console.log(`output:    ${OUT}`)

const main = [
  "const { app, BrowserWindow, ipcMain } = require('electron')",
  "const path = require('node:path')",
  "const fs = require('node:fs')",
  'const OUT = __dirname',
  'const ASSETS = process.argv[2]',
  "const CLIP = fs.readFileSync(path.join(OUT, 'clip.txt'), 'utf8')",
  "const CLIP_MS = Number(fs.readFileSync(path.join(OUT, 'clip-ms.txt'), 'utf8'))",
  "const CASE = fs.readFileSync(path.join(OUT, 'case.txt'), 'utf8').trim()",
  'app.disableHardwareAcceleration()',
  "app.setPath('cache', path.join(OUT, 'cache'))",
  "app.setPath('sessionData', path.join(OUT, 'session'))",
  'const wait = (ms) => new Promise((r) => setTimeout(r, ms))',
  '// Only the clip matters; every other channel answers the way an older helper does, so the page keeps its',
  '// own fallbacks. Anything not answered here is left unhandled on purpose.',
  "ipcMain.handle('orb:meme-fail', async () => ({ src: CLIP, ms: CLIP_MS, loops: true }))",
  "for (const channel of ['orb:meme-idle','orb:meme-hover','orb:meme-click','orb:meme-done','orb:meme-ask','orb:meme-wake','orb:meme-poor','orb:meme-sleep','orb:meme-yawn','orb:meme-skit','orb:meme-typing','orb:meme-reply','orb:meme-thinking','orb:meme-tool','orb:meme-webfetch','orb:meme-speak','orb:meme-voice','orb:meme-drag','orb:meme-drop','orb:meme-frame','orb:meme-arrive','orb:meme-dock-arrive','orb:meme-schedule','orb:wake-config','orb:tcc-status','orb:speech-ensure','orb:menu','orb:direction','orb:dock-peek','orb:dock-unpeek','orb:unsnap','orb:unsnap-smooth','orb:wake-enable','orb:wake-disable']) {",
  '  ipcMain.handle(channel, async () => null)',
  '}',
  'const MESSAGES = {',
  '  failed: { type: "turn", running: false, failed: true, interrupted: false, failure: { code: "PROBE", message: "the probe threw" } },',
  '  completed: { type: "turn", running: false },',
  '  aborted: { type: "turn", running: false, interrupted: true },',
  '}',
  'app.whenReady().then(async () => {',
  '  const win = new BrowserWindow({ width: 800, height: 600, x: 40, y: 40, show: true, frame: false, backgroundColor: "#202024",',
  "    webPreferences: { preload: path.join(ASSETS, '..', 'preload.cjs'), sandbox: false } })",
  `  await win.loadFile(path.join(ASSETS, 'floating.html'))`,
  '  win.webContents.on("console-message", (_e, _l, message) => console.log("  page: " + message))',
  '  const run = (e) => win.webContents.executeJavaScript(e, true)',
  '  await wait(2500)',
  '  // The page registers `onTurn` with the preload, which forwards from main. Taking the callback the page',
  '  // itself registered is what makes this a test of the page and not of a paraphrase of it.',
  '  const wired = await run(`(function () {',
  '    if (!window.dshOrb || typeof window.dshOrb.onTurn !== "function") return "no bridge"',
  '    window.__turn = null',
  '    window.dshOrb.onTurn((turn) => { window.__turn = turn })',
  '    return "wired"',
  '  })()`)',
  '  console.log("turn listener: " + wired)',
  '  const shoot = async (name) => {',
  "    const box = JSON.parse(await run('JSON.stringify(document.querySelector(\"#ball\").getBoundingClientRect())'))",
  '    const image = await win.webContents.capturePage({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) })',
  "    fs.writeFileSync(path.join(OUT, name + '.png'), image.toPNG())",
  '    const state = JSON.parse(await run(`JSON.stringify({',
  '      drawn: document.body.classList.contains("ball-drawn"),',
  '      visibility: getComputedStyle(document.querySelector("#ball-gif")).visibility,',
  '      docked: document.body.classList.contains("docked"),',
  '      src: String(document.querySelector("#ball-gif").src || "").slice(0, 26),',
  '      running: document.body.classList.contains("running"),',
  '    })`))',
  '    console.log(name + ": " + JSON.stringify(state))',
  '  }',
  '  await shoot("1-before")',
  '  // The page listens on `orb:turn` through the preload; sending on that channel is exactly what the host',
  '  // does, so the message goes through the shipped listener rather than a re-implementation.',
  '  win.webContents.send("orb:turn", MESSAGES[CASE])',
  '  console.log("sent on orb:turn: " + JSON.stringify(MESSAGES[CASE]))',
  '  await wait(300)',
  '  await shoot("2-just-after")',
  '  await wait(500)',
  '  await shoot("3-mid-hold")',
  '  await wait(1400)',
  '  await shoot("4-after-hold")',
  '  app.exit(0)',
  '})',
].join('\n')
writeFileSync(join(OUT, 'main.cjs'), main)
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'dsh-orb-turn-probe', main: 'main.cjs' }))
// The clip's own length, measured the way the helper measures it, so the hold the page arms is the hold it
// would arm in the app rather than a number this probe chose.
const gifDurationMs = (buffer) => {
  if (buffer.length < 14 || buffer.toString('latin1', 0, 3) !== 'GIF') return 1000
  let offset = 13 + ((buffer[10] & 0x80) !== 0 ? 3 * 2 ** ((buffer[10] & 0x07) + 1) : 0)
  let total = 0
  let frames = 0
  while (offset < buffer.length) {
    const block = buffer[offset]
    if (block === 0x3b) break
    if (block === 0x21) {
      if (buffer[offset + 1] === 0xf9 && buffer[offset + 2] === 0x04) {
        total += ((buffer[offset + 5] ?? 0) << 8) | (buffer[offset + 4] ?? 0)
        frames += 1
        offset += 8
        continue
      }
      offset += 2
      while (offset < buffer.length && buffer[offset] !== 0) offset += buffer[offset] + 1
      offset += 1
      continue
    }
    if (block === 0x2c) {
      const local = buffer[offset + 9] ?? 0
      offset += 10 + ((local & 0x80) !== 0 ? 3 * 2 ** ((local & 0x07) + 1) : 0) + 1
      while (offset < buffer.length && buffer[offset] !== 0) offset += buffer[offset] + 1
      offset += 1
      continue
    }
    break
  }
  return frames === 0 || total <= 0 ? 1000 : Math.min(Math.max(total * 10, 200), 600_000)
}
writeFileSync(join(OUT, 'clip-ms.txt'), String(gifDurationMs(readFileSync(join(PACK, clipName)))))
writeFileSync(join(OUT, 'case.txt'), value('--case', 'failed'))

const child = spawn(ELECTRON, [OUT, ASSETS], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
})
child.on('exit', (code) => {
  console.log(`\nPNGs are in ${OUT}`)
  process.exit(code ?? 0)
})
