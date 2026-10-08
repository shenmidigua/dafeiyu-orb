/**
 * Put the `nod` slot in the live config, pointing at a clip the pack actually has.
 *
 * Written from Node for the reason that cost an hour in this session: a shell wrote Chinese file names as UTF-8
 * bytes it then read back as the system code page, so the config named files that did not exist and the feature
 * failed with no error anywhere.
 *
 * Usage: `node dsh_orb/set_nod_slot.mjs ["点头.gif"]`
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACK = 'C:/Users/digua/Desktop/dsh-orb-cordis/大肥鱼表情包整合/大肥鱼表情包整合'
const path = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')
const file = process.argv[2] ?? '点头.gif'

if (!existsSync(join(PACK, file))) {
  console.error(`no such clip: ${file}`)
  process.exit(1)
}

const config = JSON.parse(readFileSync(path, 'utf8'))
copyFileSync(path, `${path}.bak-before-nod`)
config.nod = { enabled: true, file }
writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, 'utf8')

const written = JSON.parse(readFileSync(path, 'utf8'))
console.log(`nod = ${JSON.stringify(written.nod)}`)
console.log(`exists = ${existsSync(join(PACK, written.nod.file))}`)
console.log(`top-level keys now: ${Object.keys(written).join(', ')}`)
