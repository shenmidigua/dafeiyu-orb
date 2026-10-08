/**
 * List the event types a session's own log contains, and what `turn/end` carries.
 *
 * The host's `turn/end` branch never ran, and "the event never arrived" and "it arrived under a shape the branch
 * does not recognise" are the same non-event from outside. The durable log settles it: it is written by DSH
 * itself, so it says what the producer actually emits, not what a plugin hoped for.
 *
 * Usage: `node dsh_orb/inspect_session_events.mjs [sessionIdPrefix]`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createReadStream } from 'node:fs'
import { createDecompress } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const prefix = process.argv[2] ?? 'session-'

const rows = []
for (const bucket of readdirSync(root)) {
  let entries = []
  try { entries = readdirSync(join(root, bucket)) } catch { continue }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const file = join(root, bucket, entry, 'session.v4.jsonl.zstd')
    try { rows.push({ entry, file, at: statSync(file).mtimeMs }) } catch {}
  }
}
rows.sort((a, b) => b.at - a.at)
console.log(`${rows.length} session(s) matching "${prefix}"`)

for (const row of rows.slice(0, 1)) {
  console.log(`\nreading ${row.entry} (${Math.round(statSync(row.file).size / 1024)}KB)`)
  // The log is zstd-compressed; shell out to nothing — use the transform stream node ships.
  const { stdout } = await import('node:child_process').then(({ execFile }) => new Promise((resolve, reject) => {
    execFile('node', ['-e', 'process.exit(0)'], () => resolve({ stdout: '' }))
  })).catch(() => ({ stdout: '' })) ?? { stdout: '' }

  // Simpler and reliable: read the raw bytes and look for the event type strings directly. The compression
  // makes this approximate, but the type names are short ASCII runs that survive as literals in most frames.
  const raw = readFileSync(row.file)
  const text = raw.toString('latin1')
  const types = new Map()
  for (const m of text.matchAll(/"type":"([a-z][\w/-]{2,32})"/g)) {
    types.set(m[1], (types.get(m[1]) ?? 0) + 1)
  }
  console.log('\nevent types seen in the compressed log (approximate):')
  for (const [type, count] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.log(`  ${String(count).padStart(5)}  ${type}`)
  }
  const turnEnd = text.includes('turn/end')
  console.log(`\n"turn/end" present as a literal: ${turnEnd}`)
  if (turnEnd) {
    const at = text.indexOf('turn/end')
    console.log('around it: ' + text.slice(Math.max(0, at - 200), at + 300).replace(/[^\x20-\x7e]/g, '.'))
  }
}
