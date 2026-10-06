/**
 * Check the poor face's wiring end to end, in the *installed* package, and that the page still parses.
 *
 * The feature crosses every layer this plugin has: the DSH account service (host), a socket message
 * (host → helper), a page event (helper → preload → page), a `memes.json` slot read by the helper, and
 * a decision inside `syncGif`. A break anywhere in that chain is silent — the ball simply keeps its
 * ordinary loop — so each hop is asserted where it actually has to exist, in the built files rather
 * than in the sources they came from.
 *
 * The parse check at the top is not ceremony. While this feature was being written, an edit to
 * `shell.js` dropped a newline inside `fetchHover` and the whole page became a syntax error: the ball
 * painted nothing at all, and *every* textual check in this file still passed, because the text was
 * all still there. Node parses the page here for the one error class that no amount of grepping finds.
 *
 * Usage: `verify_poor_slot.mjs`
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

const INSTALLED = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb')
const HELPER = join(INSTALLED, 'dist', 'helper')
const HOST = join(INSTALLED, 'dist', 'host', 'index.js')
const CONFIG = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')

const bundle = readFileSync(join(HELPER, 'lib', 'main.js'), 'utf8')
const preload = readFileSync(join(HELPER, 'preload.cjs'), 'utf8')
const shell = readFileSync(join(HELPER, 'assets', 'shell.js'), 'utf8')
const host = readFileSync(HOST, 'utf8')

let bad = 0
const report = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) bad += 1
}

// 1. The page has to parse. Importing it as a data: URL is the cheapest way to ask Node the same
//    question the renderer asks; a SyntaxError is a page that runs nothing, and any other error is
//    the module graph this check does not claim to cover. Only the error's *name* is printed: its
//    message quotes the whole URL, which is the entire page in base64.
const pageUrl = `data:text/javascript;base64,${Buffer.from(shell).toString('base64')}`
try {
  await import(pageUrl)
  report(true, 'page: the installed shell.js parses')
} catch (error) {
  const syntax = error instanceof SyntaxError
  report(!syntax, `page: the installed shell.js parses${syntax ? ` (${error.name})` : ''}`)
}

// 2. Host: the DSH account service, the client metadata, and the socket message. The patterns are
//    quote-agnostic because the bundler rewrites the sources' single quotes to double ones, and a
//    check that only matches the source's own spelling fails on a perfectly good build.
const hops = [
  ['host: reads the account service', /get\(["']deepseekAccount["']\)/],
  ['host: asks for the balance', /getBalance\(/],
  ['host: sums the wallets in CNY', /currency !== ["']CNY["']/],
  ['host: calls a failed read "not known"', /status !== ["']ready["']/],
  ['host: pushes the balance to the ball', /type: ["']balance["']/],
  ['host: re-reads it on a cadence', /BALANCE_POLL_MS/],
  // `!== void 0` rather than `!== undefined`, and the message spread over two lines by the bundler:
  // both are the same test, written the way a build tool likes it.
  ['host: answers a new helper with the reading in hand',
    /if \(this\.balance !== (?:undefined|void 0)\) this\.send\(socket, \{[^}]*type: ["']balance["']/],
  ['host: stops reading when the ball does', /this\.stopBalanceWatch\(\)/],
]
for (const [label, pattern] of hops) report(pattern.test(host), label)

// 3. Helper: the slot's channel, the balance message, and the push to a page that loaded late.
report(/ipcMain\.handle\(["']orb:meme-poor["']/.test(bundle), 'helper: the IPC channel')
report(/async poor\(\)/.test(bundle), 'helper: the picker method')
report(/poor: readPoor\(record\.poor\)/.test(bundle), 'helper: the config field')
report(/if \(record\.type === ["']balance["']\)/.test(bundle), 'helper: handles the balance message')
report(/webContents\.send\(["']orb:balance["']/.test(bundle), 'helper: hands it to the page')
report(/pushBalance\(\)/.test(bundle), 'helper: re-pushes it when the page loads')

// 4. Preload and page.
report(/memePoor\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\(['"]orb:meme-poor['"]\)/.test(preload), 'preload: the renderer bridge')
report(/onBalance\(callback\)/.test(preload), 'preload: the balance listener')
report(/api\.memePoor\(\)/.test(shell), 'page: asks for the frame and its line')
report(/api\.onBalance\(/.test(shell), 'page: listens for the balance')
report(/function brokeNow\(\)/.test(shell), 'page: has one place that decides')
report(/balanceCny === null\) return false/.test(shell), 'page: an unknown balance is not a zero')
report(/const mode = broke \? 'poor' : 'idle'/.test(shell), 'page: the two faces are distinct modes')

// 5. The configuration, and the asset it names.
const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const slot = config.poor
const usable = slot?.enabled === true && typeof slot.file === 'string' && slot.file !== ''
  && typeof slot.below === 'number' && slot.below > 0
if (usable) {
  console.log(`ok    memes.json: poor -> ${slot.file} below ${slot.below}`)
} else {
  console.log(`FAIL  memes.json: poor is not a usable slot (${JSON.stringify(slot)})`)
  bad += 1
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

if (usable) {
  const hit = imagesUnder(config.dir).find((path) => basename(path) === basename(slot.file))
  if (hit === undefined) {
    console.log(`FAIL  pack: ${slot.file} is not in ${config.dir}`)
    bad += 1
  } else {
    const bytes = readFileSync(hit)
    const gif = bytes.subarray(0, 3).toString('latin1') === 'GIF'
    console.log(`${gif && bytes.length > 0 ? 'ok  ' : 'FAIL'}  pack: ${basename(hit)} `
      + `(${bytes.length.toLocaleString()} bytes, header ${JSON.stringify(bytes.subarray(0, 6).toString('latin1'))})`)
    if (!gif || bytes.length === 0) bad += 1
    // The face has to be a loop the ball can *rest* in, so a still image or a one-shot would be the
    // wrong asset even though every check above would pass.
    const loops = bytes.includes(Buffer.from('NETSCAPE2.0', 'latin1'))
    console.log(`${loops ? 'ok  ' : 'FAIL'}  pack: it loops, which is what a resting face needs`)
    if (!loops) bad += 1
  }
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
