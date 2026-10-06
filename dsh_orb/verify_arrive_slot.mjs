/**
 * Check the four things that have to hold for the greeting to appear, none of which a unit test or
 * a glance at the JSON can establish on its own.
 *
 * 1. The *installed* bundle carries the slot end to end. The unit tests read the source tree, so a
 *    build that silently dropped the channel — or an install that never happened — passes them all
 *    and leaves the ball opening on its resting loop for ever.
 * 2. The configured file name resolves to a real image *through the resolver's own rule*. The
 *    configured `dir` points at the folder above the pack, so a bare name like `到达.gif` only
 *    resolves by the recursive basename search. A name that reads correctly in the config can still
 *    resolve to nothing, and the failure is a silent startup, not an error.
 * 3. The image is a GIF the page can decode, and how long one pass of it lasts: that number is the
 *    hold the greeting gets, so a broken delay table means a greeting nobody sees.
 * 4. The greeting is not mistaken for a resting loop. It is played once per page, and the frame
 *    sweep must not be the thing that reads it — a greeting that replays on every poll is
 *    indistinguishable from a new `idle` file, which is the mistake this slot exists to avoid.
 *
 * The picker itself is exercised by `tests/memes.test.ts` against a fixture pack; what matters here
 * is that *this* pack, on *this* machine, still has the file the config names.
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

// The page has to parse before any check below means anything. A syntax error in `shell.js` — one
// dropped newline is enough — leaves the ball painting nothing at all, and every textual check in
// this file still passes, because the text is all still there. Importing the page as a data: URL asks
// Node the same question the renderer asks; only the error's name is printed, because its message
// quotes the whole URL, which is the entire page in base64.
try {
  await import(`data:text/javascript;base64,${Buffer.from(shell).toString('base64')}`)
  console.log('ok    page: the installed shell.js parses')
} catch (error) {
  const broken = error instanceof SyntaxError
  console.log(`${broken ? 'FAIL' : 'ok  '}  page: the installed shell.js parses${broken ? ` (${error.name})` : ''}`)
  if (broken) process.exitCode = 1
}

const hops = [
  ['helper bundle: the IPC channel', bundle, /ipcMain\.handle\("orb:meme-arrive"/],
  ['helper bundle: the picker method', bundle, /async arrive\(\)/],
  ['helper bundle: the config field', bundle, /arrive: readArrive\(record\.arrive\)/],
  // The slot is a list, and the helper has to answer with one: a picker that still returns a single
  // frame is a page that plays the arrival and never gets to the wave.
  ['helper bundle: the clips are resolved in order', bundle, /for \(const file of current\.arrive\.files\)/],
  ['preload: the renderer bridge', preload, /memeArrive\(\)\s*\{\s*\n\s*return ipcRenderer\.invoke\('orb:meme-arrive'\)/],
  ['page: asks for the frames', shell, /api\.memeArrive\(\)/],
  ['page: keeps the list, not one frame', shell, /if \(!Array\.isArray\(frames\)\) return null/],
  ['page: wears it while it is up', shell, /arriveShown !== undefined/],
  ['page: reads it as the page opens', shell, /void wearArriveFrame\(\)/],
  ['page: keeps it to one run per page', shell, /if \(arrivePlayed\) return/],
  // Measured, not assumed: with the hold started at page load the window came up a second later and
  // the user got the last third of the arrival's animation, so the wait for visibility is what makes
  // the greeting the first thing seen rather than the tail of something already over.
  ['page: waits until the window is on screen',
    shell, /await Promise\.all\(\[fetchArrive\(\), whenVisible\(\)\]\)/],
  ['page: plays every clip for one pass of its own animation',
    shell, /for \(const frame of frames\)[\s\S]{0,400}?oneShotHoldMs\(frame\.ms, frame\.loops\)/],
  // A greeting that is never released is the nastiest of the three: nothing looks broken, the ball
  // just never wears any other face again — no idling, no reply, no nap.
  ['page: releases it once the last clip is over',
    shell, /await wait\(oneShotHoldMs\(frame\.ms, frame\.loops\)\)\s*\n\s*\}\s*\n\s*arriveShown = undefined/],
]

let bad = 0
for (const [label, text, pattern] of hops) {
  const ok = pattern.test(text)
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) bad += 1
}

// The greeting has to be read outside the sweep that re-runs for the life of the page. Were a
// later edit to move it into `refreshFrames()`, every check above would still pass and the
// greeting would be read after a dozen other files every time. The installed file is CRLF, so the
// body is cut out of a normalised copy — matching `\n` against CRLF text silently finds nothing,
// and an empty body would pass this check for the wrong reason.
const page = shell.replace(/\r\n/g, '\n')
const sweep = page.slice(page.indexOf('async function refreshFrames()'))
const sweepBody = sweep.slice(0, sweep.indexOf('\n  }\n'))
// The cut is proved to have landed on the function's own end before it is used: a body that came
// back empty, or as the rest of the file, would make the check below answer about the wrong text.
if (!sweepBody.includes('idleSrc === undefined')) {
  console.log('FAIL  page: refreshFrames() could not be cut out of the installed page')
  bad += 1
} else if (/[Aa]rrive/.test(sweepBody)) {
  console.log('FAIL  page: the greeting is read inside refreshFrames(), behind a dozen other files')
  bad += 1
} else {
  console.log('ok    page: refreshFrames() leaves the greeting alone')
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const slot = config.arrive
const slotFiles = Array.isArray(slot?.files)
  ? slot.files.filter((file) => typeof file === 'string' && file !== '')
  : []
if (slot?.enabled !== true || slotFiles.length === 0) {
  console.log(`FAIL  memes.json: arrive is not a usable slot (${JSON.stringify(slot)})`)
  bad += 1
} else {
  console.log(`ok    memes.json: arrive -> ${slotFiles.join(' then ')}`)
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

/**
 * One pass of a GIF, from its frame delays — the rule in `src/memes.ts`, restated here because a
 * verifier that imported the thing it verifies would agree with a broken parser.
 */
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

if (slotFiles.length > 0) {
  const images = imagesUnder(config.dir)
  // Every clip, not just the first: the greeting is only as good as the file that failed to resolve,
  // and a missing one is silent — the sequence simply plays the rest.
  for (const name of slotFiles) {
    const hit = images.find((path) => basename(path) === basename(name))
    if (hit === undefined) {
      console.log(`FAIL  pack: ${name} is not in ${config.dir} (${images.length} images searched)`)
      bad += 1
      continue
    }
    const bytes = readFileSync(hit)
    const loops = bytes.includes(Buffer.from('NETSCAPE2.0', 'latin1'))
    const ms = passMs(bytes)
    const ok = bytes.subarray(0, 3).toString('latin1') === 'GIF' && bytes.length > 0
    // The hold the page gives a clip: one pass less a lead for a file that restarts on its own, the
    // whole pass (or a 900 ms floor) for one that ends on its own last frame. Printed because the
    // sum of them is how long the ball spends greeting before it goes back to resting.
    const hold = loops && ms !== null ? Math.max(ms - Math.max(70, Math.round(ms * 0.15)), 120)
      : ms === null ? 1200 : Math.max(ms, 900)
    console.log(`${ok ? 'ok  ' : 'FAIL'}  pack: ${basename(hit)} (${bytes.length.toLocaleString()} bytes,`
      + ` header ${JSON.stringify(bytes.subarray(0, 6).toString('latin1'))}, `
      + `${ms === null ? 'delays unreadable' : `${ms} ms per pass`}${loops ? ', restarts on its own' : ''},`
      + ` held ${hold} ms)`)
    if (!ok) bad += 1
    if (ms === null) {
      console.log('      note: the page falls back to 1200 ms for an unreadable delay table')
    }
  }
}

console.log(bad === 0 ? '\nOK' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
