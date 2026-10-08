/**
 * Change one tool's face in the live config, leaving every other mapping alone.
 *
 * The eight-tool set was installed in one go, so the thing that changes from here is one line at a time. Written
 * from Node because a shell already turned these Chinese file names into bytes that named no file, and asserts the
 * clip exists before writing, because a mapping to a missing file fails by doing nothing at all.
 *
 * Usage: `node dsh_orb/set_tool_face.mjs pwsh="打字(恼怒).gif"`
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACK = 'C:/Users/digua/Desktop/dsh-orb-cordis/大肥鱼表情包整合/大肥鱼表情包整合'
const CONFIG = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')

if (process.argv.length < 3) {
  console.error('usage: set_tool_face.mjs tool=file.gif')
  process.exit(1)
}

const config = JSON.parse(readFileSync(CONFIG, 'utf8'))
const tools = { ...(config.tool?.tools ?? {}) }

for (const assignment of process.argv.slice(2)) {
  const at = assignment.indexOf('=')
  if (at === -1) {
    console.error(`expected tool=file.gif, got: ${assignment}`)
    process.exit(1)
  }
  const tool = assignment.slice(0, at).trim()
  const file = assignment.slice(at + 1).trim()
  if (!existsSync(join(PACK, file))) {
    console.error(`no such clip in the pack: ${file}`)
    process.exit(1)
  }
  console.log(`  ${tool}: ${tools[tool] ?? '(unset)'}  ->  ${file}`)
  tools[tool] = file
}

copyFileSync(CONFIG, `${CONFIG}.bak-before-one-face`)
config.tool = { ...config.tool, enabled: true, tools }
writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

const written = JSON.parse(readFileSync(CONFIG, 'utf8'))
console.log('\ntool.tools now:')
for (const [tool, file] of Object.entries(written.tool.tools)) {
  console.log(`  ${tool.padEnd(11)} ${file}  ${existsSync(join(PACK, file)) ? '' : '  <-- MISSING'}`)
}
