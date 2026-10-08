/**
 * Run `probe_dock_empty` and print what the renderer did, with the pixels kept as PNGs.
 *
 * The probe itself is an Electron main script (`probe_dock_empty/main.js`); this is the launcher, and
 * it moves the output to a run directory so a before/after pair can be compared rather than overwritten.
 *
 * Usage: `node probe_dock_empty.mjs [--tag before|after]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const TAG = process.argv.includes('--tag') ? process.argv[process.argv.indexOf('--tag') + 1] : 'run'
const ASSETS = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'packages', 'helper', 'assets')
const ELECTRON = join(homedir(), '.dsh', 'dsh-orb', 'electron-runtime', 'electron.exe')
const HERE = join(homedir(), 'Desktop', 'dsh-orb-cordis', 'dsh_orb', 'probe_dock_empty')
const OUT = join(tmpdir(), `dsh-orb-empty-${TAG}`)

if (!existsSync(ELECTRON)) {
  console.error(`FAIL  no electron runtime at ${ELECTRON}`)
  process.exit(1)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// Electron runs a directory whose package.json names a main, the way a real app is packaged.
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ name: 'dsh-orb-empty-probe', main: 'main.js' }))
writeFileSync(join(OUT, 'main.js'), readFileSync(join(HERE, 'main.js'), 'utf8'))

console.log(`assets:  ${ASSETS}`)
console.log(`output:  ${OUT}`)
const child = spawn(ELECTRON, [OUT, ASSETS, OUT], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } })
child.on('exit', (code) => {
  const states = join(OUT, 'states.json')
  if (existsSync(states)) {
    console.log('\n--- states ---')
    for (const state of JSON.parse(readFileSync(states, 'utf8'))) {
      console.log(
        `${state.label.padEnd(46)} t=${String(state.at).padStart(5)}ms  `
        + `srcAttr=${state.hasSrcAttribute ? 'yes' : 'NO '}  complete=${state.complete ? 'yes' : 'no '}  `
        + `natW=${String(state.naturalWidth).padStart(5)}  visibility=${state.visibility.padEnd(8)}  `
        + `ball-drawn=${state.drawn ? 'YES' : 'no '}  box=${state.box.w}x${state.box.h}@${state.box.x},${state.box.y}`,
      )
    }
    console.log(`\nPNGs in ${OUT}: ${JSON.parse(readFileSync(join(OUT, 'shots.json'), 'utf8')).join(', ')}`)
  }
  process.exit(code ?? 0)
})
