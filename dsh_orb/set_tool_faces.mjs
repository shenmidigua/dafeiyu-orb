/**
 * Set the per-tool face mapping in the live config to exactly the tools asked for.
 *
 * Written from Node rather than through a shell, and assertively rather than incrementally: a shell already
 * mangled these Chinese file names once, writing UTF-8 bytes it then read back as the system code page, and the
 * result was a mapping that looked right in an editor and named no file on disk.
 *
 * Usage: `node dsh_orb/set_tool_faces.mjs pwsh="记录 2.gif" …` (with no arguments, prints the current mapping)
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const PACK = 'C:/Users/digua/Desktop/dsh-orb-cordis/大肥鱼表情包整合/大肥鱼表情包整合'
const path = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')

const assignments = process.argv.slice(2)
const config = JSON.parse(readFileSync(path, 'utf8'))

if (assignments.length === 0) {
  console.log(`tool: ${JSON.stringify(config.tool, null, 2)}`)
  process.exit(0)
}

const wanted = {}
for (const assignment of assignments) {
  const at = assignment.indexOf('=')
  if (at === -1) {
    console.error(`bad argument (expected name=file.gif): ${assignment}`)
    process.exit(1)
  }
  const tool = assignment.slice(0, at).trim()
  const file = assignment.slice(at + 1).trim()
  const full = join(PACK, file)
  if (!existsSync(full)) {
    console.error(`no such clip in the pack: ${file}`)
    process.exit(1)
  }
  wanted[tool] = file
}

const backup = `${path}.bak-before-toolfaces`
copyFileSync(path, backup)
config.tool = { ...config.tool, enabled: true, tools: wanted }
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

const written = JSON.parse(readFileSync(path, 'utf8'))
console.log(`backup: ${backup}`)
console.log(`tool.tools: ${JSON.stringify(written.tool.tools, null, 2)}`)
for (const [tool, file] of Object.entries(written.tool.tools)) {
  console.log(`  ${tool.padEnd(8)} ${file}  exists=${existsSync(join(PACK, file))}`)
}
