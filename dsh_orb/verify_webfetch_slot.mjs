/**
 * Check the two things that have to hold for the fetch face to appear, and that neither a unit
 * test nor a glance at the JSON can establish on its own.
 *
 * 1. The *installed* bundle carries the slot end to end. Unit tests read the source tree, so a
 *    build that silently dropped the channel — or an install that never happened — passes them
 *    all and leaves the ball showing the shared tool face forever.
 * 2. The configured file name resolves to a real image *through the resolver's own rule*. The
 *    configured `dir` points at the folder above the pack, so a bare name like `打字(恼怒).gif`
 *    only resolves by the recursive basename search. A name that reads correctly in the config can
 *    still resolve to nothing, and the failure is a blank `<img>`, not an error.
 *
 * The picker itself is exercised by `tests/memes.test.ts` against a fixture pack; what matters
 * here is that *this* pack, on *this* machine, still has the file the config names.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const INSTALLED = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb',
  'dist', 'helper')
const CONFIG = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')

const bundle = readFileSync(join(INSTALLED, 'lib', 'main.js'), 'utf8')
const preload = readFileSync(join(INSTALLED, 'preload.cjs'), 'utf8')
const shell = readFileSync(join(INSTALLED, 'assets', 'shell.js'), 'utf8')

const hops = [
  ['helper bundle: the IPC channel', bundle, /ipcMain\.handle\("orb:meme-webfetch"/],
  ['helper bundle: the picker method', bundle, /async webfetch\(\)/],
  ['helper bundle: the config field', bundle, /webfetch: readNamed\(record\.webfetch\)/],
  ['preload: the renderer bridge', preload, /memeWebfetch\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-webfetch'\)/],
  ['page: asks for the frame', shell, /api\.memeWebfetch\(\)/],
  ['page: wears it only for a fetch', shell, /agentTool === WEB_FETCH_TOOL && webfetchSrc !== undefined/],
]

let bad = 0
for (const [label, text, pattern] of hops) {
  const ok = pattern.test(text)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) bad += 1
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const slot = config.webfetch
if (slot?.enabled !== true || typeof slot.file !== 'string' || slot.file === '') {
  console.log(`FAIL  memes.json: webfetch is not a usable slot (${JSON.stringify(slot)})`)
  bad += 1
} else {
  console.log(`ok    memes.json: webfetch -> ${slot.file}`)
}

/** Every image under `dir`, by basename — the resolver's own rule, applied to this pack. */
function imagesUnder(dir, depth = 0, out = []) {
  if (depth > 4) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) imagesUnder(path, depth + 1, out)
    else if (entry.isFile() && /\.(gif|png|jpe?g|webp)$/i.test(entry.name)) out.push(path)
  }
  return out
}

const files = imagesUnder(config.dir)
const hit = files.find((path) => basename(path) === basename(slot.file))
if (hit === undefined) {
  console.log(`FAIL  pack: ${slot.file} is not in ${config.dir} (${files.length} images searched)`)
  bad += 1
} else {
  const bytes = statSync(hit).size
  const head = readFileSync(hit).subarray(0, 6).toString('latin1')
  const gif = head.startsWith('GIF')
  console.log(`${gif && bytes > 0 ? 'ok  ' : 'FAIL'}  pack: ${basename(hit)}`
    + ` (${bytes.toLocaleString()} bytes, header ${JSON.stringify(head)})`)
  if (!gif || bytes === 0) bad += 1
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
