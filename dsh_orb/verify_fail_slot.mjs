/**
 * Check the failure face's wiring end to end, in the *installed* package.
 *
 * The face crosses every layer this plugin has: the host reads DSH's `turn/end` reason, says `failed`
 * on the socket message that already ends a turn, the helper turns that into a page event, the page
 * plays a clip it read from `memes.json`, and `syncGif` puts it on the ball. Every break in that chain
 * is silent — the ball simply rings its bell at a failure, or shows nothing — so each hop is asserted
 * where it has to exist, in the built files rather than in the sources they came from.
 *
 * The parse check at the top is not ceremony: while this repo's greeting was being written, one dropped
 * newline in `shell.js` made the whole page a syntax error, the ball painted nothing at all, and every
 * textual check in this file still passed because the text was all still there.
 *
 * Usage: `verify_fail_slot.mjs`
 */

import { readFileSync, readdirSync } from 'node:fs'
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

// 1. The page has to parse. Importing it as a data: URL asks Node the same question the renderer asks;
//    only the error's *name* is printed, because its message quotes the whole page in base64.
try {
  await import(`data:text/javascript;base64,${Buffer.from(shell).toString('base64')}`)
  report(true, 'page: the installed shell.js parses')
} catch (error) {
  const broken = error instanceof SyntaxError
  report(!broken, `page: the installed shell.js parses${broken ? ` (${error.name})` : ''}`)
}

// 2. Host: the reason is read, the turn carries the verdict, and the texts are kept for the log.
//    Patterns are quote-agnostic and tolerate the bundler's `void 0`, because a check that only matches
//    the source's own spelling fails on a perfectly good build.
const hops = [
  ['host: reads the turn-end reason', /readTurnEnd\(/],
  ['host: only an error is a failure', /kind === ["']error["']/],
  ['host: keeps the code and the message', /failure\.code[\s\S]{0,200}failure\.message/],
  ['host: a cancellation is not a finished task',
    /kind === ["']aborted["'] \|\| kind === ["']interrupted["']/],
  ['host: the turn message says it failed', /failed: true/],
  ['host: the failure is logged where a human can read it', /turn failed /],
  ['host: hands the reason to the end-of-turn handler', /if \(type === ["']turn\/end["']\) this\.finishTurn\(data\)/],
  ['host: a fresh session does not inherit a stop', /this\.turnInterrupted = false/],
]
for (const [label, pattern] of hops) report(pattern.test(host), label)

// 3. Helper: the slot's channel and the picker method.
report(/ipcMain\.handle\(["']orb:meme-fail["']/.test(bundle), 'helper: the IPC channel')
report(/async fail\(\)/.test(bundle), 'helper: the picker method')
report(/fail: readNamed\(record\.fail\)/.test(bundle), 'helper: the config field')
report(/fail: FRAME_DEFAULTS/.test(bundle), 'helper: the factory default is off')

// 4. Preload and page.
report(/memeFail\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\(['"]orb:meme-fail['"]\)/.test(preload), 'preload: the renderer bridge')
report(/api\.memeFail\(\)/.test(shell), 'page: asks for the frame')
report(/function playFailFrame\(\)/.test(shell), 'page: plays it once, with a step')
report(/if \(failShown !== undefined\)/.test(shell), 'page: wears it while it is up')
report(/failed && !interrupted\) playFailFrame\(\)/.test(shell), 'page: a failed run gets the face')
report(/else if \(wasRunning && !interrupted\) playDoneFrame\(\)/.test(shell), 'page: a failed run does not get the bell')
report(/item\.failed === true/.test(shell), 'page: the turn message carries the flag through')

// 5. The order in `syncGif`: the failure face above the finished-task frame, and both above the
//    resting poses. A failure is the more specific fact about the same edge, and either of them
//    outranking the resting loop is what keeps a broken run visible over an idle ball. All three
//    anchors have to be found — `indexOf` answers -1 for a branch that was renamed or deleted, and -1
//    sorts below everything, so a stale anchor would otherwise pass this check for the wrong reason.
const page = shell.replace(/\r\n/g, '\n')
const failAt = page.indexOf('if (failShown !== undefined)')
const doneAt = page.indexOf('if (doneShown !== undefined)')
const idleAt = page.indexOf('if (broke || idleSrc !== undefined)')
report(failAt !== -1 && doneAt !== -1 && idleAt !== -1 && failAt < doneAt && doneAt < idleAt,
  'page: the failure face is decided above the bell, and both above the resting loop'
  + `${failAt === -1 || doneAt === -1 || idleAt === -1 ? '' : ` (${failAt} < ${doneAt} < ${idleAt})`}`)

// 6. The configuration, and the asset it names.
const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const slot = config.fail
const usable = slot?.enabled === true && typeof slot.file === 'string' && slot.file !== ''
if (usable) {
  console.log(`ok    memes.json: fail -> ${slot.file}`)
} else {
  console.log(`FAIL  memes.json: fail is not a usable slot (${JSON.stringify(slot)})`)
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

/** One pass of a GIF, from its frame delays — the rule in `src/memes.ts`, restated here. */
function passMs(body) {
  if (body.length < 14 || body.toString('latin1', 0, 3) !== 'GIF') return null
  const packed = body[10] ?? 0
  let offset = 13 + ((packed & 0x80) !== 0 ? 3 * 2 ** ((packed & 0x07) + 1) : 0)
  let total = 0
  let frames = 0
  while (offset < body.length) {
    const block = body[offset]
    if (block === 0x3b) break
    if (block === 0x21) {
      if (body[offset + 1] === 0xf9 && body[offset + 2] === 0x04) {
        total += ((body[offset + 5] ?? 0) << 8) | (body[offset + 4] ?? 0)
        frames += 1
        offset += 8
        continue
      }
      offset += 2
      offset = skip(body, offset)
      continue
    }
    if (block === 0x2c) {
      const local = body[offset + 9] ?? 0
      offset += 10 + ((local & 0x80) !== 0 ? 3 * 2 ** ((local & 0x07) + 1) : 0)
      offset = skip(body, offset + 1)
      continue
    }
    return null
  }
  return frames === 0 || total <= 0 ? null : total * 10
}

function skip(body, from) {
  let offset = from
  while (offset < body.length) {
    const size = body[offset] ?? 0
    offset += 1
    if (size === 0) return offset
    offset += size
  }
  return offset
}

if (usable) {
  const hit = imagesUnder(config.dir).find((path) => basename(path) === basename(slot.file))
  if (hit === undefined) {
    console.log(`FAIL  pack: ${slot.file} is not in ${config.dir}`)
    bad += 1
  } else {
    const bytes = readFileSync(hit)
    const loops = bytes.includes(Buffer.from('NETSCAPE2.0', 'latin1'))
    const ms = passMs(bytes)
    const ok = bytes.subarray(0, 3).toString('latin1') === 'GIF' && bytes.length > 0
    // The hold the page gives it: one pass, less a lead when the clip restarts on its own so the
    // hand-off never lands on the frame the decoder restarts from. Printed because it is the answer to
    // "how long does the ball cry".
    const hold = loops && ms !== null ? Math.max(ms - Math.max(70, Math.round(ms * 0.15)), 120)
      : ms === null ? 1200 : Math.max(ms, 900)
    console.log(`${ok ? 'ok  ' : 'FAIL'}  pack: ${basename(hit)} (${bytes.length.toLocaleString()} bytes,`
      + ` header ${JSON.stringify(bytes.subarray(0, 6).toString('latin1'))}, `
      + `${ms === null ? 'delays unreadable' : `${ms} ms per pass`}${loops ? ', restarts on its own' : ''},`
      + ` held ${hold} ms)`)
    if (!ok) bad += 1
  }
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
