/**
 * Record the lifecycle of every tool block on the host, so a stuck one names itself.
 *
 * A ball wearing a tool face while nothing is running means `agentPhase` is finding a tool block still marked
 * running — and the block is the host's, so the host is where the answer is. This writes one line each time a
 * tool block is written, each time a tool result is matched, and a roll-call of what is still running when a turn
 * ends. That is enough to tell "the result never came" from "the result came under a different key".
 *
 * Temporary, and installed into the running copy rather than the source: it exists to answer one question, and
 * the next `tsdown` build erases it.
 *
 * Usage: `node dsh_orb/probe_tool_blocks.mjs add|remove`
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'host', 'index.js')
const action = process.argv[2] ?? 'add'
const MARK = 'ORB_TOOL_PROBE'

if (!existsSync(FILE)) {
  console.error(`missing: ${FILE}`)
  process.exit(1)
}
let text = readFileSync(FILE, 'utf8')

/** The probe writes to the orb's own folder, beside the other runtime files. */
const HELPER = `function ${MARK}(line) {
  try {
    const fs = require('node:fs');
    const os = require('node:os');
    fs.appendFileSync(os.homedir() + '/.dsh/dsh-orb/toolblocks.log', new Date().toISOString().slice(11, 23) + ' ' + line + '\\n');
  } catch {}
}
`

if (action === 'remove') {
  const lines = text.split('\n')
  const kept = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.includes(MARK)) {
      if (/^function ORB_TOOL_PROBE\(/.test(line)) {
        while (index < lines.length && lines[index] !== '}') index += 1
      }
      continue
    }
    kept.push(line)
  }
  writeFileSync(FILE, kept.join('\n'), 'utf8')
  console.log('probe removed')
  process.exit(0)
}

if (text.includes(MARK)) {
  console.log('already instrumented')
  process.exit(0)
}

copyFileSync(FILE, `${FILE}.bak-toolprobe`)

// A roll-call of what is still marked running, printed on every tool write and at the end of a turn.
const ROLLCALL = `    ${MARK}('running=[' + [...this.blocks.entries()].filter(([, b]) => b.running === true).map(([k, b]) => k + ':' + b.kind).join(' ') + ']');`

const anchors = [
  // tool/call
  {
    from: 'this.block(key, "tool", name, true, "set", {\n        args: clip(toolArguments(data), 4000)\n      });',
    add: (match) => `${match}\n    ${MARK}('call key=' + key + ' name=' + name);\n${ROLLCALL}`,
  },
  // tool/result
  {
    from: 'this.block(key, "tool", name, false, "set", detail);',
    add: (match) => `    ${MARK}('result key=' + key + ' name=' + name + ' known=' + (existing !== undefined));\n${match}`,
  },
  // turn/end
  {
    from: 'this.turnRunning = false;\n      this.idleWarned = false;',
    add: (match) => `${ROLLCALL}\n${match}`,
  },
]

const headerAt = text.indexOf('var __defProp') === -1 ? 0 : text.indexOf('var __defProp')
text = text.slice(0, headerAt) + HELPER + text.slice(headerAt)

let applied = 0
for (const anchor of anchors) {
  const at = text.indexOf(anchor.from)
  if (at === -1) {
    console.error(`anchor not found: ${anchor.from.slice(0, 60)}…`)
    continue
  }
  text = text.slice(0, at) + anchor.add(anchor.from) + text.slice(at + anchor.from.length)
  applied += 1
}

writeFileSync(FILE, text, 'utf8')
console.log(`${applied}/${anchors.length} anchors instrumented`)
if (applied === 0) process.exit(1)
