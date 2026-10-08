/**
 * Ask the picker what it holds, by writing the answer to a file instead of to a pipe.
 *
 * Repeated stderr probes into this module came back empty or crashed, and a diagnostic that shares a pipe
 * with the thing it is diagnosing is one more thing to distrust. A file has no such problem.
 *
 * Usage: `node dsh_orb/probe_picker_state.mjs <config path>`
 */

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { createMemePicker } from '../packages/helper/src/memes.ts'

const path = process.argv[2] ?? join(homedir(), '.dsh', 'dsh-orb', 'memes.json')
const out = join(mkdtempSync(join(tmpdir(), 'picker-')), 'state.json')

const lines = []
const say = (line) => lines.push(line)

const raw = JSON.parse(readFileSync(path, 'utf8'))
say(`config: ${path}`)
say(`parsed tool.tools: ${JSON.stringify(raw.tool?.tools ?? null)}`)
say(`parsed top-level keys: ${Object.keys(raw).join(', ')}`)

const picker = createMemePicker(path)
const shared = await picker.tool()
say(`tool(): ${shared === null ? 'null' : `${shared.length} chars`}`)
for (const name of ['pwsh', 'edit', 'read', 'grep', '']) {
  const src = await picker.toolNamed(name)
  say(`toolNamed(${JSON.stringify(name)}): ${src === null ? 'null' : `${src.length} chars`}`)
}

writeFileSync(out, lines.join('\n'), 'utf8')
console.log(out)
