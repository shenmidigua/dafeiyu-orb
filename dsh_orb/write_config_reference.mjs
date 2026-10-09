/**
 * Write the live config into the repository as a reference, with the machine-specific parts taken out.
 *
 * `~/.dsh/dsh-orb/memes.json` is not in version control — it lives outside the repo, so it has no history at all.
 * That cost real time this session: a key was found empty and the only way to learn what it had been was a pile of
 * dated `.bak` files beside it, one of which happened to predate the change. This is the copy that a repository
 * keeps instead.
 *
 * Two things are deliberately not copied:
 *
 *   * `dir`, because it is an absolute path on one machine.
 *   * the `prune`-style keys that only mean something while a specific pack is installed. What is left is the
 *     shape of the config and the choices in it, which is what a reference is for.
 *
 * Usage: `node dsh_orb/write_config_reference.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const live = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')
const out = 'C:/Users/digua/Desktop/dsh-orb-cordis/dsh_orb/memes.reference.json'

const config = JSON.parse(readFileSync(live, 'utf8'))
// The pack lives beside the repo on this machine and nowhere else.
config.dir = '<pack directory>'

const header = {
  _readme: [
    'A reference copy of the orb config as it stands on one machine, kept so that a key that goes missing has',
    'something to be compared against. The live file is ~/.dsh/dsh-orb/memes.json and is NOT in this repository.',
    '',
    '`dir` is the only value replaced; everything else is what the settings page wrote. Slots with no file are',
    'switched off on purpose — `sleep`, for instance, has a five-minute `afterMs` and a three-step nap.',
  ],
}

// The comment keys go on top, the config under them, so a reader meets the explanation first.
writeFileSync(out, `${JSON.stringify({ ...header, ...config }, null, 2)}\n`, 'utf8')

const slots = Object.keys(config).filter((k) => !['enabled', 'dir', 'gapMs', 'holdMs', 'frames'].includes(k))
console.log(`written ${out}`)
console.log(`  ${slots.length} slots: ${slots.join(', ')}`)
console.log(`  sleep.files: ${JSON.stringify(config.sleep.files)}`)
console.log(`  tool.tools: ${Object.keys(config.tool?.tools ?? {}).length} mappings`)
