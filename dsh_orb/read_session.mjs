/**
 * Read a DSH session log: many zstd frames concatenated, one per append.
 *
 * `zlib.zstdDecompressSync` reads the *first* frame and returns — 211 bytes of a 2MB file — and piping
 * through `zstdDecompress` did the same here, so neither the sync call nor the stream is the reader this
 * store needs. Each frame starts with the zstd magic `28 b5 2f fd`, so the bytes are split on it and every
 * frame is decompressed on its own. That is also what makes the walk resumable: a frame that fails to
 * decompress (an append caught mid-write) is skipped rather than ending the read.
 *
 * Usage: `node dsh_orb/read_session.mjs <session.v4.jsonl.zstd> [--types tool/,turn/] [--last 20]`
 */

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Every record in the log, in order; frames that will not decompress are skipped. */
export function readSessionRecords(file) {
  const raw = readFileSync(file)
  const starts = []
  for (let index = 0; index + 4 <= raw.length; index += 1) {
    if (raw[index] === MAGIC[0] && raw[index + 1] === MAGIC[1] && raw[index + 2] === MAGIC[2] && raw[index + 3] === MAGIC[3]) {
      starts.push(index)
    }
  }
  if (starts.length === 0) return { records: [], frames: 0, skipped: 0, bytes: raw.length }
  const records = []
  let skipped = 0
  for (const [position, start] of starts.entries()) {
    const end = position + 1 < starts.length ? starts[position + 1] : raw.length
    let text
    try {
      text = zstdDecompressSync(raw.subarray(start, end)).toString('utf8')
    } catch {
      skipped += 1
      continue
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        records.push(JSON.parse(line))
      } catch {
        // A partial trailing line inside a frame is normal for a log being written to.
      }
    }
  }
  return { records, frames: starts.length, skipped, bytes: raw.length }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (invokedDirectly || process.argv.includes('--run')) {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: read_session.mjs <session.v4.jsonl.zstd> [--types tool/,turn/] [--last 20]')
    process.exit(1)
  }
  const wanted = process.argv.includes('--types')
    ? process.argv[process.argv.indexOf('--types') + 1].split(',')
    : null
  const last = Number(process.argv.includes('--last') ? process.argv[process.argv.indexOf('--last') + 1] : 20)
  const { records, frames, skipped, bytes } = readSessionRecords(file)
  console.log(`${bytes} bytes, ${frames} frames (${skipped} unreadable), ${records.length} records`)
  const counts = new Map()
  for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1)
  console.log('types: ' + [...counts.entries()].sort((left, right) => right[1] - left[1])
    .map(([type, count]) => `${type}=${count}`).join('  '))
  const shown = wanted === null ? records : records.filter((record) => wanted.some((prefix) => String(record.type).startsWith(prefix)))
  console.log(`\n--- last ${last} of ${shown.length} matching ---`)
  for (const record of shown.slice(-last)) {
    const at = String(record.time ?? record.at ?? '').slice(11, 23)
    const data = record.data ?? {}
    const summary = JSON.stringify(data)
    console.log(`${at}  ${String(record.type).padEnd(16)} ${summary.slice(0, 220)}`)
  }
}
