/**
 * Record every `session-turn` payload the page receives, to a file the helper writes.
 *
 * The host proves it broadcasts, the helper proves it forwards, and the face does not appear — so the one step
 * nobody has observed is the page receiving anything at all. This logs each payload on arrival, before any
 * branch decides what to do with it, which separates "the message never came" from "the message came and the
 * page did nothing".
 *
 * Temporary, and installed into the running copy: the next `tsdown` build erases it. `--remove` takes it out.
 *
 * Usage: `node dsh_orb/probe_session_turn.mjs add|remove`
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'assets', 'shell.js')
const PRELOAD = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'preload.cjs')
const MAIN = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'lib', 'main.js')
const action = process.argv[2] ?? 'add'
const MARK = 'orb:probe-session-turn'

const HANDLER = `ipcMain.handle("${MARK}", (event, lines) => {
  if (!fromBall(event)) return null
  try {
    appendFileSync(join(app.getPath("home"), ".dsh", "dsh-orb", "session-turn.log"), (Array.isArray(lines) ? lines : []).join("\\n") + "\\n")
  } catch {}
  return null
})
`

if (action === 'remove') {
  for (const [file, needles] of [
    [SHELL, ['probeOnSessionTurn', 'probeTurnLines']],
    [PRELOAD, ['probeSessionTurn']],
    [MAIN, [MARK]],
  ]) {
    if (!existsSync(file)) continue
    const text = readFileSync(file, 'utf8')
    const kept = []
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (needles.some((needle) => line.includes(needle))) {
        // A function declaration goes with its body.
        if (/^\s*(async )?function probeOnSessionTurn\(/.test(line)) {
          while (index < lines.length && !/^\s{2}\}/.test(lines[index])) index += 1
        }
        continue
      }
      kept.push(line)
    }
    writeFileSync(file, kept.join('\n'), 'utf8')
  }
  console.log('probe removed')
  process.exit(0)
}

// --- the page -------------------------------------------------------------------------------------------

const shell = readFileSync(SHELL, 'utf8')
if (shell.includes('probeOnSessionTurn')) {
  console.log('page already instrumented')
} else {
  copyFileSync(SHELL, `${SHELL}.bak-sessionturn`)
  const anchor = '  if (typeof api.onSessionTurn === \'function\') {\n'
  if (!shell.includes(anchor)) {
    console.error('onSessionTurn anchor missing')
    process.exit(1)
  }
  const probe = `  let probeTurnLines = []
  function probeOnSessionTurn(payload) {
    try {
      probeTurnLines.push(new Date().toISOString().slice(11, 23) + ' ' + JSON.stringify(payload))
      if (typeof api.probeSessionTurn === 'function') void api.probeSessionTurn(probeTurnLines.splice(0))
    } catch {}
  }
`
  let next = shell.replace(anchor, probe + anchor)
  // The hook goes *inside* the callback, after its parameter list — not after the `if` that owns it. There is no
  // `payload` binding on the `if` line, so putting it there throws on every message and takes the handler's body
  // down with it: a probe that breaks the feature it was measuring, which is exactly what happened.
  const callback = 'api.onSessionTurn((payload) => {\n'
  const at = next.indexOf(callback)
  if (at === -1) {
    console.error('onSessionTurn callback missing')
    process.exit(1)
  }
  const after = at + callback.length
  next = next.slice(0, after) + '      probeOnSessionTurn(payload)\n' + next.slice(after)
  writeFileSync(SHELL, next, 'utf8')
  console.log('page instrumented')
}

// --- the preload ----------------------------------------------------------------------------------------

const preload = readFileSync(PRELOAD, 'utf8')
if (!preload.includes('probeSessionTurn')) {
  const anchor = '  memeTool() {\n'
  if (!preload.includes(anchor)) {
    console.error('preload anchor missing')
    process.exit(1)
  }
  writeFileSync(PRELOAD, preload.replace(anchor, `  probeSessionTurn(lines) {\n    return ipcRenderer.invoke('${MARK}', lines)\n  },\n` + anchor), 'utf8')
  console.log('preload instrumented')
}

// --- the helper -----------------------------------------------------------------------------------------

const main = readFileSync(MAIN, 'utf8')
if (!main.includes(MARK)) {
  const handlers = ['ipcMain.handle("orb:meme-tool-named",', "ipcMain.handle('orb:meme-tool-named',"]
  const anchor = handlers.find((candidate) => main.includes(candidate))
  if (anchor === undefined) {
    console.error('main anchor missing')
    process.exit(1)
  }
  writeFileSync(MAIN, main.replace(anchor, HANDLER + anchor), 'utf8')
  console.log('helper instrumented')
}
console.log(`\npayloads land in ~/.dsh/dsh-orb/session-turn.log`)
