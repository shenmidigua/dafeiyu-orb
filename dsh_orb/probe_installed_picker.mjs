/**
 * Ask the installed helper bundle — not the repository — which face each tool resolves to.
 *
 * The repository says one thing and the installed copy says another, and the installed copy is what runs.
 * Everything in this session that looked correct in the source and did nothing on the machine turned out to be
 * a difference between the two: a key in the wrong place, a file name in the wrong encoding, a bundle without
 * the change in it. So the question "does the feature work" has to be asked of this copy.
 *
 * Usage: `node dsh_orb/probe_installed_picker.mjs`
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const bundle = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-orb', 'dist', 'helper', 'lib', 'main.js')
const source = readFileSync(bundle, 'utf8')
console.log(`installed bundle: ${bundle}`)
console.log(`  mentions toolNamed: ${source.includes('toolNamed')}`)
console.log(`  mentions readToolFaces: ${source.includes('readToolFaces')}`)
console.log(`  mentions tools. get: ${/tools\[/.test(source)}`)

// The bundle is a main-process module, not an importable library, so what it can be asked is what it contains
// — and whether the config's mapping survives being read by *its* copy of the reader.
const memesOnly = source.slice(source.indexOf('function readToolFaces'), source.indexOf('function readToolFaces') + 900)
console.log('\ninstalled readToolFaces:\n' + memesOnly.split('\n').slice(0, 14).join('\n'))
