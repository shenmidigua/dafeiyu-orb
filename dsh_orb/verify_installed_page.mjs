/**
 * Compare the page the ball is *running* against the page in the working tree.
 *
 * This exists because three fixes in a row were verified against the source and then reported as done,
 * while the installed package still held the build from before them: every checker in this folder reads
 * `packages/helper/assets/shell.js`, and none of them read
 * `~/.dsh/profiles/desktop/node_modules/dsh-orb/dist/helper/assets/shell.js` — the file the helper
 * actually loaded. "The walk says OK" and "the ball does it" were not the same claim, and only the
 * first one was ever tested.
 *
 * So this is the check that connects them: it hashes both files and then asks the *behavioural*
 * questions — is each guard present, in the copy that is live? A walk that passes against the source
 * while this fails means the fix has not been installed, however green the walk is.
 *
 * Usage: `verify_installed_page.mjs [--installed-only]`
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const repo = join(homedir(), 'Desktop', 'dsh-orb-cordis')
const SOURCE = join(repo, 'packages', 'helper', 'assets', 'shell.js')
const INSTALLED = join(
  homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'assets', 'shell.js',
)

const read = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    return null
  }
}

const md5 = (text) => createHash('md5').update(text).digest('hex').slice(0, 10)
const brief = (path) => path.replace(homedir(), '~')

const source = read(SOURCE)
const installed = read(INSTALLED)

if (source === null) {
  console.error(`FAIL  the working tree has no page: ${brief(SOURCE)}`)
  process.exit(1)
}
if (installed === null) {
  console.error(`FAIL  no installed package to compare against: ${brief(INSTALLED)}`)
  console.error('      the orb has never been installed on this machine, or the profile moved')
  process.exit(1)
}

// The questions that matter, each a thing a fix was made of. A guard is a line that has to exist in the
// copy the ball runs; listing them by name is what makes the output say *which* fix is missing rather
// than only that something is.
//
// Each question is scoped to a function body, because "does this line exist anywhere" is the wrong
// question: two of these guards are a single `if (...) return` whose meaning comes entirely from where
// it sits, and a page-wide search finds the same text in an unrelated function and calls it a pass.
const body = (text, name) => {
  const start = text.indexOf(`function ${name}(`)
  if (start === -1) return null
  const open = text.indexOf('{', start)
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

const GUARDS = [
  {
    name: 'a docked ball arms no collapse',
    of: 'scheduleCollapse',
    find: (text) => text.includes('if (docked !== undefined) return'),
    note: 'scheduleCollapse must bail out for a docked ball, or a leave arms a timer that ends the peek',
  },
  {
    name: 'the collapse frame does not close a docked ball',
    of: 'setExpanded',
    find: (text) => text.includes('if (docked === undefined) void api.setExpanded(false)'),
    note: "the collapseFrame timer must not tell the helper to collapse a ball that is docked",
  },
  {
    name: 'a hover already being served is not entered again',
    of: 'beginDockArrive',
    find: (text) => /dockHoverTimer !== undefined\s*\|\|\s*dockArriveShown !== undefined/.test(text),
    note: 'beginDockArrive must not re-arm the dwell while a clip is already up',
  },
]

let bad = 0
const say = (ok, label, detail = '') => {
  if (!ok) bad += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

console.log(`source     ${brief(SOURCE)}`)
console.log(`  ${source.length} bytes, md5 ${md5(source)}`)
console.log(`installed  ${brief(INSTALLED)}`)
console.log(`  ${installed.length} bytes, md5 ${md5(installed)}`)

const identical = source === installed
if (!args.includes('--installed-only')) {
  say(identical, 'the ball is running the page in the working tree',
    identical ? '' : `${source.length - installed.length} bytes of difference`)
}

console.log('\nwhat the live copy actually does:')
for (const guard of GUARDS) {
  const ask = (text) => {
    const found = body(text, guard.of)
    if (found === null) return 'no such function'
    return guard.find(found) ? 'yes' : 'no'
  }
  const inSource = ask(source)
  const inInstalled = ask(installed)
  const ok = inSource === 'yes' && inInstalled === 'yes'
  const detail = ok ? '' : inSource === 'yes' && inInstalled !== 'yes'
    ? `in the source, MISSING from the ball (${guard.of} → ${inInstalled})`
    : `source says "${inSource}", ball says "${inInstalled}" (${guard.of})`
  say(ok, `${guard.name}${ok ? '' : ' — MISSING'}`, detail === '' ? guard.note : detail)
}

if (bad > 0) {
  console.log(`\n${bad} PROBLEM(S): the running ball is not the code that was checked.`)
  console.log('  Every walk in this folder reads the source, so a green walk says nothing about the ball')
  console.log('  until the build is installed and the helper has been restarted. Install, then re-run:')
  console.log('    node packages/bundle/scripts/assemble.mjs --out <stage>')
  console.log('    python dsh_orb/pack_and_install.py')
} else {
  console.log('\nOK  the ball is running exactly what the checks read')
}

process.exit(bad === 0 ? 0 : 1)