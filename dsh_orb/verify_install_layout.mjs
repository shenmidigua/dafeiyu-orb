/**
 * Install-layout check that does not need symlinks.
 *
 * `packages/bundle/tests/install.test.mjs` proves the same things from a scratch profile, but its
 * first case builds the profile out of directory symlinks and its `before()` hook installs one into
 * the assembled copy. This machine refuses `symlinkSync` (EPERM without Developer Mode), so that
 * test cannot run here at all. The second case — unpack the tarball into a profile, resolve every
 * patch row from the profile root — needs no symlink, and it is exactly what `pack_and_install.py`
 * has just done to the real profile, so this script runs the same assertions against the live
 * install instead of a scratch copy.
 *
 * Usage: node dsh_orb/verify_install_layout.mjs [profileDir]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const profile = process.argv[2] ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')
const root = join(profile, 'node_modules', 'dsh-orb')

let failures = 0
function check(condition, label) {
  if (condition) {
    console.log(`OK   ${label}`)
    return
  }
  console.log(`FAIL ${label}`)
  failures += 1
}

/** The plugin names the patch inserts that belong to this package. */
function ownNames() {
  const patch = readFileSync(join(repo, 'packages/bundle/cordis.patch.yml'), 'utf8')
  const names = [...patch.matchAll(/^\s+name: '?(dsh-orb[^'\s]*)'?\s*$/gm)].map((match) => match[1])
  return [...new Set(names)]
}

/** The loader resolves a patch row from the profile root, the same as this. */
function resolveFromProfile(specifier) {
  return createRequire(join(profile, 'package.json')).resolve(specifier)
}

const names = ownNames().sort()
check(
  JSON.stringify(names) === JSON.stringify(['dsh-orb', 'dsh-orb/computer-use', 'dsh-orb/computer-use/code-agent', 'dsh-orb/host']),
  `the patch names the four rows: ${names.join(', ')}`,
)
for (const specifier of names) {
  const file = resolveFromProfile(specifier)
  check(existsSync(file), `${specifier} resolves from the profile root -> ${file.replace(profile, '<profile>')}`)
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check(manifest.name === 'dsh-orb', 'the installed manifest is dsh-orb')
check(manifest.dsh?.client?.platform === 'web', 'dsh.client.platform is web')
check(JSON.stringify(manifest.dsh?.client?.inject) === JSON.stringify(['@deepseek-ai/dsh-client-ui-settings']), 'dsh.client.inject')
check(manifest.exports?.['./client'] === './client.js', 'exports ./client')
check(/id: 'dsh-orb'/.test(readFileSync(join(root, 'client.js'), 'utf8')), 'client.js carries the rewritten plugin id')
check(manifest.devDependencies === undefined, 'no devDependencies in the installed manifest')
check(manifest.scripts === undefined, 'no scripts in the installed manifest')
check(
  JSON.stringify(Object.keys(manifest.dependencies ?? {}).sort()) === JSON.stringify(['koffi', 'zod']),
  `dependencies are koffi and zod: ${Object.keys(manifest.dependencies ?? {}).join(', ')}`,
)
for (const spec of Object.values(manifest.dependencies ?? {})) {
  check(!/^(file|link|workspace):/.test(String(spec)), `dependency spec is publishable: ${spec}`)
}

for (const rel of [
  'dist/helper/lib/main.js',
  'dist/helper/preload.cjs',
  'dist/helper/selection-preload.cjs',
  'dist/helper/assets/floating.html',
  'dist/helper/assets/voice-closing.js',
  'dist/helper/assets/deepseek-avatar-square.gif',
  ...readdirSync(join(repo, 'packages/helper/assets/avatars')).map((file) => `dist/helper/assets/avatars/${file}`),
  'dist/native-selection/src/index.js',
  'dist/computer-use/macos-sck-capture',
]) {
  check(statSync(join(root, rel), { throwIfNoEntry: false }) !== undefined, `reached by relative path: ${rel}`)
}

const host = readFileSync(join(root, 'dist/host/index.js'), 'utf8')
check(/new URL\("\.\.\/helper", import\.meta\.url\)/.test(host), 'the host reaches the helper relatively')
check(!host.includes('from "@dsh-orb/native-selection"'), 'the host has no workspace specifier left')
check(readdirSync(join(root, 'dist/host')).includes('index.js'), 'the host entry is installed')

// The same dynamic import the install test makes: the row has to load from the profile root.
try {
  const loaded = await import(pathToFileURL(resolveFromProfile('dsh-orb/host')).href)
  check(typeof loaded.apply === 'function', 'dsh-orb/host loads and exports apply')
  check(loaded.name === 'orb-host', `dsh-orb/host is named orb-host: ${loaded.name}`)
} catch (error) {
  check(false, `dsh-orb/host loads: ${error.message}`)
}

console.log(failures === 0 ? '\nINSTALL LAYOUT VERIFIED' : `\n${failures} PROBLEM(S)`)
process.exit(failures === 0 ? 0 : 1)
