/**
 * What the host recorded about a subagent call: did its tool block settle with an error?
 *
 * The ball's new failure face is driven by `detail.isError` on the block, not by the subagent's own
 * session — so the question "did the ball play it" is answered in the *parent* session's log, at the
 * `tool/result` for the `subagent` call. Four `tool` events in one turn are the flow this watches for:
 *
 *   status success   the subagent ran
 *     …its own events, if the log carries them…
 *   status error     it stopped
 *   turn/end         the reason for its turn
 *
 * This reads the session store directly (`session.v4.jsonl.zstd`, a zstd stream of JSON lines). The
 * session named on the command line is the one walked; the newest by default.
 *
 * Usage: `node dsh_orb/read_session_tail.mjs [--dir <session dir>] [--grep subagent] [--turns 2]`
 */

import { spawnSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const value = (flag, fallback) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback)
const SESSIONS = join(homedir(), '.dsh', 'sessions')

/** Every session directory under the store, newest first. */
function sessionDirs() {
  const found = []
  for (const bucket of readdirSync(SESSIONS)) {
    const path = join(SESSIONS, bucket)
    let entries
    try {
      entries = readdirSync(path)
    } catch {
      continue
    }
    for (const entry of entries) {
      const file = join(path, entry, 'session.v4.jsonl.zstd')
      try {
        found.push({ dir: join(path, entry), file, at: statSync(file).mtimeMs, size: statSync(file).size })
      } catch {
        // Not a session directory.
      }
    }
  }
  return found.sort((left, right) => right.at - left.at)
}

/** The session log as text. `zstd` is used when the machine has it; the library is the fallback. */
async function readSession(file) {
  const zstd = spawnSync('zstd', ['-d', '-c', file], { maxBuffer: 1 << 30 })
  if (zstd.status === 0 && zstd.stdout && zstd.stdout.length > 0) {
    return zstd.stdout.toString('utf8')
  }
  const module = await import('node:zlib')
  if (typeof module.zstdDecompressSync === 'function') {
    return module.zstdDecompressSync(await (await import('node:fs/promises')).readFile(file)).toString('utf8')
  }
  throw new Error('no zstd available: neither the `zstd` command nor node:zlib.zstdDecompressSync')
}

const filtered = args.includes('--dir')
  ? sessionDirs().filter((session) => session.dir.includes(value('--dir', '')))
  : sessionDirs()
if (filtered.length === 0) {
  console.error('no session logs found')
  process.exit(1)
}
const session = filtered[0]
console.log(`session: ${session.dir.replace(homedir(), '~')}`)
console.log(`  ${(session.size / 1024 / 1024).toFixed(2)} MB, modified ${new Date(session.at).toISOString()}`)

const text = await readSession(session.file)
const lines = text.split('\n').filter((line) => line.trim() !== '')
console.log(`  ${lines.length} records`)

const events = []
for (const line of lines) {
  try {
    events.push(JSON.parse(line))
  } catch {
    // A partial tail line is normal for a log being written to.
  }
}

const wanted = value('--grep', 'subagent')
const turns = Number(value('--turns', '2'))
const interesting = events.filter((event) => {
  const type = String(event.type ?? '')
  if (type === 'turn/end' || type === 'turn/start') return true
  const text = JSON.stringify(event.data ?? event).slice(0, 4000)
  return type.startsWith('tool/') && (wanted === '' || text.includes(wanted))
})

console.log(`\n--- the last ${turns} turn(s), tool events and endings ---`)
const shown = interesting.slice(-Math.max(turns * 12, 24))
for (const event of shown) {
  const data = event.data ?? {}
  const at = String(event.time ?? event.timestamp ?? '').slice(11, 23)
  if (String(event.type) === 'turn/end') {
    console.log(`${at}  turn/end      ${JSON.stringify(data.reason ?? data).slice(0, 300)}`)
    continue
  }
  if (String(event.type) === 'turn/start') {
    console.log(`${at}  turn/start`)
    continue
  }
  const name = data.name ?? data.toolName ?? data.message?.name ?? '?'
  const error = data.error ?? data.message?.error
  const isError = data.isError ?? data.message?.isError
  const status = data.status ?? data.message?.status
  const line = `${at}  ${String(event.type).padEnd(12)} ${String(name).slice(0, 24).padEnd(24)}`
    + ` status=${status ?? '-'} isError=${isError ?? '-'}`
    + `${error === undefined ? '' : ` error=${JSON.stringify(error).slice(0, 160)}`}`
    + `${data.toolCallId ?? data.id ? ` id=${data.toolCallId ?? data.id}` : ''}`
  console.log(line)
}
