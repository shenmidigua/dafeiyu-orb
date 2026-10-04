/**
 * Reproduce exactly what the helper does when it launches the read-aloud service.
 *
 * The helper's own log only says "did not answer in time", which cannot distinguish "cmd.exe never
 * ran the batch" from "the batch ran and the model failed to load" — so this runs the same spawn and
 * then reports what the service's own log says.
 */
import { spawn } from 'node:child_process'
import { readFileSync, statSync, existsSync } from 'node:fs'

const LAUNCH = process.argv[2] ?? 'D:\\tools\\indextts\\start_server.cmd'
const CWD = process.argv[3] ?? 'D:\\tools\\indextts'
const LOG = process.argv[4] ?? 'D:\\tools\\indextts\\logs\\tts-server.log'
const WAIT_MS = Number(process.argv[5] ?? 12_000)
// `spawn('cmd.exe')` fails with ENOENT when PATH does not carry System32, which is exactly what
// happened to the helper: the error arrived as an event nobody listened for, so the launch looked
// like it simply never finished. ComSpec is the canonical absolute path.
const SHELL = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe'

const before = existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0
console.log(`log before: ${before} bytes`)
console.log(`shell     : ${SHELL}`)

const child = spawn(SHELL, ['/d', '/s', '/c', LAUNCH], {
  cwd: CWD,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
})
console.log(`spawned pid ${child.pid}`)
child.on('error', (error) => console.log(`spawn error: ${error}`))
child.unref()

await new Promise((resolve) => setTimeout(resolve, WAIT_MS))

const after = existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0
console.log(`log after : ${after} bytes  (grew by ${after - before})`)
if (after > before) {
  const added = readFileSync(LOG, 'utf8').slice(before)
  console.log('--- appended ---')
  console.log(added.slice(0, 1200))
} else {
  console.log('--- nothing was appended: the batch did not run ---')
}

try {
  console.log('launcher mtime:', statSync(LAUNCH).mtime.toISOString())
} catch (error) {
  console.log('launcher missing:', error.message)
}
process.exit(0)
