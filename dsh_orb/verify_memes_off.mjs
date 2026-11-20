/**
 * Reads the live `memes.json` through the real picker, to prove what the ball will (not) play.
 *
 * The config is data, so the only honest check is the code that consumes it: `schedule()` is the burst,
 * `skit()` is the idle skit, `next()` is one random frame of the pack. Run it after editing the config
 * rather than grepping the JSON, which cannot tell whether the member is honoured.
 */
import { pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'

const moduleUrl = pathToFileURL(join(import.meta.dirname, '..', 'packages', 'helper', 'src', 'memes.ts'))
const { createMemePicker } = await import(moduleUrl.href)

const configPath = join(homedir(), '.dsh', 'dsh-orb', 'memes.json')
const picker = createMemePicker(configPath)

const schedule = await picker.schedule()
const skit = await picker.skit()
const frame = await picker.next()

const failures = []
const check = (label, ok, actual) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : ` -> ${JSON.stringify(actual)}`}`)
  if (!ok) failures.push(label)
}

check('burst is off (schedule.enabled === false)', schedule.enabled === false, schedule.enabled)
check('one random frame is refused (next() === null)', frame === null, frame)
check('the idle skit is still on (skit() !== null)', skit !== null, skit && skit.times)

// The single-clip slots must be untouched: these are the ones the user configured by hand. A slot the
// picker does not expose (a config key with no reader yet) is skipped rather than counted as broken.
const stillOn = []
let exposed = 0
for (const slot of ['idle', 'typing', 'hover', 'voice', 'speak', 'reply', 'thinking', 'tool', 'click',
  'done', 'fail', 'wake', 'ask', 'drag', 'drop', 'arrive', 'dockArrive', 'poor', 'nod',
  'interrupted', 'approval', 'maxtokens', 'sleep']) {
  if (typeof picker[slot] !== 'function') {
    console.log(`skip  ${slot} (no reader in the picker)`)
    continue
  }
  exposed += 1
  const value = await picker[slot]()
  if (value !== null && value !== undefined) stillOn.push(slot)
}
check('every single-clip slot the picker reads still resolves', stillOn.length === exposed,
  { exposed, resolved: stillOn.length, stillOn })

// The nap is a timeline, not a clip: `afterMs` is how long the ball must be left alone, `stepMs` how
// long each nap frame holds. Six hours is what the config asks for, so a reader that clamps or rounds
// it shows up here rather than six hours from now.
const nap = await picker.sleep()
check('the nap waits six hours (sleep().afterMs === 21_600_000)', nap !== null && nap.afterMs === 21_600_000,
  nap && { afterMs: nap.afterMs, stepMs: nap.stepMs, count: nap.count })

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('\nrandom bursts are off; the skit and every single-clip slot are untouched')
}
