/**
 * Record what the elsewhere-tool branch actually sees, at the moment it decides.
 *
 * The logic is right and the helper answers correctly — `asked="grep" own-face=true` is in `tools.log` — so the
 * disagreement has to be a value at run time: a window that was already shut, or a cache that did not hold the
 * frame yet. Neither is visible from outside, and both produce the same non-event. This writes the two values
 * every repaint, so "the branch never ran" and "the branch ran with nothing in hand" stop looking alike.
 *
 * Temporary, installed into the running copy; the next build erases it.
 *
 * Usage: `node dsh_orb/probe_elsewhere_branch.mjs add|remove`
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHELL = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'assets', 'shell.js')
const PRELOAD = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'preload.cjs')
const MAIN = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'lib', 'main.js')
const action = process.argv[2] ?? 'add'
const MARK = 'orb:probe-branch'

/** The branch's own line, which is where the two values have to be read. */
const BRANCH = `    if (Date.now() - (streamAt.get('tool') ?? 0) < holdWork) {\n`
const HOOK = `      noteBranch('elsewhere-tool window=' + Math.round(Date.now() - (streamAt.get('tool') ?? 0)) + 'ms name=' + JSON.stringify(namedOtherTool) + ' cached=' + (typeof namedToolFaces !== 'undefined' && namedToolFaces !== null ? namedToolFaces.has(namedOtherTool) : 'no-map') + ' own=' + JSON.stringify(agentState === 'tooling' ? agentTool : ''))\n`

const COLLECTOR = `  const probeBranchLines = []
  let probeBranchTimer
  function noteBranch(line) {
    probeBranchLines.push(new Date().toISOString().slice(11, 23) + ' ' + line)
    if (probeBranchTimer !== undefined) return
    probeBranchTimer = setTimeout(() => {
      probeBranchTimer = undefined
      const batch = probeBranchLines.splice(0)
      try { if (typeof api.probeBranch === 'function') void api.probeBranch(batch) } catch {}
    }, 250)
  }

`

/** Strip whatever this probe contributed, so `--remove` works from any state. */
function strip(text) {
  const lines = text.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes('noteBranch(') || line.includes('probeBranch') || line.includes(MARK)) {
      if (/^\s*function noteBranch\(/.test(line)) {
        while (index < lines.length && !/^\s{2}\}/.test(lines[index])) index += 1
      }
      if (/^\s*const probeBranchLines/.test(line) || /^\s*let probeBranchTimer/.test(line)) continue
      if (/^\s*ipcMain\.handle\(["']?orb:probe-branch/.test(line)) {
        while (index < lines.length && !/^\s*\}\);?$/.test(lines[index])) index += 1
      }
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}

if (action === 'remove') {
  for (const file of [SHELL, PRELOAD, MAIN]) {
    if (existsSync(file)) writeFileSync(file, strip(readFileSync(file, 'utf8')), 'utf8')
  }
  console.log('probe removed')
  process.exit(0)
}

// --- the page -------------------------------------------------------------------------------------------

const shell = strip(readFileSync(SHELL, 'utf8'))
const anchor = '  function syncGif() {\n'
if (!shell.includes(anchor)) {
  console.error('syncGif anchor missing')
  process.exit(1)
}
if (!shell.includes(BRANCH)) {
  console.error('the elsewhere-tool branch is not in the shape this expects')
  process.exit(1)
}
let next = shell.replace(anchor, COLLECTOR + anchor).replace(BRANCH, BRANCH + HOOK)
writeFileSync(SHELL, next, 'utf8')
console.log('page instrumented')

// --- the preload ----------------------------------------------------------------------------------------

const preload = strip(readFileSync(PRELOAD, 'utf8'))
if (!preload.includes('probeBranch')) {
  const preloadAnchor = '  memeTool() {\n'
  if (!preload.includes(preloadAnchor)) {
    console.error('preload anchor missing')
    process.exit(1)
  }
  writeFileSync(PRELOAD, preload.replace(preloadAnchor, `  probeBranch(lines) {\n    return ipcRenderer.invoke('${MARK}', lines)\n  },\n` + preloadAnchor), 'utf8')
  console.log('preload instrumented')
}

// --- the helper -----------------------------------------------------------------------------------------

const main = strip(readFileSync(MAIN, 'utf8'))
if (!main.includes(MARK)) {
  const handlers = ['ipcMain.handle("orb:meme-tool-named",', "ipcMain.handle('orb:meme-tool-named',"]
  const mainAnchor = handlers.find((candidate) => main.includes(candidate))
  if (mainAnchor === undefined) {
    console.error('helper anchor missing')
    process.exit(1)
  }
  const handler = `ipcMain.handle("${MARK}", (event, lines) => {
  if (!fromBall(event)) return null
  try {
    appendFileSync(join(app.getPath("home"), ".dsh", "dsh-orb", "branch.log"), (Array.isArray(lines) ? lines : []).join("\\n") + "\\n")
  } catch {}
  return null
})
`
  writeFileSync(MAIN, main.replace(mainAnchor, handler + mainAnchor), 'utf8')
  console.log('helper instrumented')
}
console.log('\nbranch decisions land in ~/.dsh/dsh-orb/branch.log')
