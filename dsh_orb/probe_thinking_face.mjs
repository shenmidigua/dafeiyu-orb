/**
 * Record, on every repaint that matters, which face won and what the two windows looked like.
 *
 * The branch order is right and the host sends `thinking`, so the disagreement has to be a value at run time —
 * most likely the thinking frame never being in hand, which would leave `thinkingSrc` undefined and hand the ball
 * to whichever other window is open. That is invisible from outside, and "no picture" and "lost the race" produce
 * the same screen.
 *
 * Only the faces that compete for reasoning are logged, so the file stays short enough to read.
 *
 * Usage: `node dsh_orb/probe_thinking_face.mjs add|remove`
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'assets', 'shell.js')
const PRELOAD = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'preload.cjs')
const MAIN = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'lib', 'main.js')
const action = process.argv[2] ?? 'add'
const MARK = 'orb:probe-thinking'

/** Strip whatever this probe contributed, so `--remove` works from any state. */
function strip(text) {
  const lines = text.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes('noteFaceWhy') || line.includes('faceWhyLines') || line.includes('probeThinking') || line.includes(MARK)) {
      if (/^\s*(async )?function noteFaceWhy\(/.test(line)) {
        while (index < lines.length && !/^\s{2}\}/.test(lines[index])) index += 1
      }
      if (/^\s*(const|let) faceWhy/.test(line)) continue
      if (/^\s*ipcMain\.handle\(["']?orb:probe-thinking/.test(line)) {
        while (index < lines.length && !/^\s*\}\);?$/.test(lines[index])) index += 1
      }
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

if (action === 'remove') {
  for (const f of [SHELL, PRELOAD, MAIN]) if (existsSync(f)) writeFileSync(f, strip(readFileSync(f, 'utf8')), 'utf8')
  console.log('probe removed')
  process.exit(0)
}

// --- the page -----------------------------------------------------------------------------------------

const COLLECTOR = `  const faceWhyLines = []
  let faceWhyTimer
  function noteFaceWhy(line) {
    faceWhyLines.push(new Date().toISOString().slice(11, 23) + ' ' + line)
    if (faceWhyTimer !== undefined) return
    faceWhyTimer = setTimeout(() => {
      faceWhyTimer = undefined
      const batch = faceWhyLines.splice(0)
      try { if (typeof api.probeThinking === 'function') void api.probeThinking(batch) } catch {}
    }, 300)
  }

`
const shell = strip(readFileSync(SHELL, 'utf8'))
const anchor = '  function syncGif() {\n'
if (!shell.includes(anchor)) {
  console.error('syncGif anchor missing')
  process.exit(1)
}
// Log once per repaint, at the point where the reasoning faces have all been considered.
const THINKING = "    if (thinkingSrc !== undefined && Date.now() - (streamAt.get('thinking') ?? 0) < holdWork) {"
if (!shell.includes(THINKING)) {
  console.error('the thinking-elsewhere branch is not in the shape this expects')
  process.exit(1)
}
const HOOK = `    noteFaceWhy('own=' + JSON.stringify(agentState) + ' thinkingSrc=' + (thinkingSrc === undefined ? 'none' : 'yes')
      + ' wThinking=' + Math.round(Date.now() - (streamAt.get('thinking') ?? 0)) + ' wTyping=' + Math.round(Date.now() - (streamAt.get('typing') ?? 0))
      + ' wTool=' + Math.round(Date.now() - (streamAt.get('tool') ?? 0)) + ' replySrc=' + (replySrc === undefined ? 'none' : 'yes'))
`
let next = shell.replace(anchor, COLLECTOR + anchor).replace(THINKING, HOOK + THINKING)
writeFileSync(SHELL, next, 'utf8')
console.log('page instrumented')

// --- the preload -------------------------------------------------------------------------------------

const preload = strip(readFileSync(PRELOAD, 'utf8'))
if (!preload.includes('probeThinking')) {
  const a = '  memeTool() {\n'
  if (!preload.includes(a)) {
    console.error('preload anchor missing')
    process.exit(1)
  }
  writeFileSync(PRELOAD, preload.replace(a, `  probeThinking(lines) {\n    return ipcRenderer.invoke('${MARK}', lines)\n  },\n` + a), 'utf8')
  console.log('preload instrumented')
}

// --- the helper --------------------------------------------------------------------------------------

const main = strip(readFileSync(MAIN, 'utf8'))
if (!main.includes(MARK)) {
  const handlers = ['ipcMain.handle("orb:meme-tool-named",', "ipcMain.handle('orb:meme-tool-named',"]
  const a = handlers.find((c) => main.includes(c))
  if (a === undefined) {
    console.error('helper anchor missing')
    process.exit(1)
  }
  const handler = `ipcMain.handle("${MARK}", (event, lines) => {
  if (!fromBall(event)) return null
  try {
    appendFileSync(join(app.getPath("home"), ".dsh", "dsh-orb", "thinking.log"), (Array.isArray(lines) ? lines : []).join("\\n") + "\\n")
  } catch {}
  return null
})
`
  writeFileSync(MAIN, main.replace(a, handler + a), 'utf8')
  console.log('helper instrumented')
}
console.log('\nrepaints land in ~/.dsh/dsh-orb/thinking.log')
