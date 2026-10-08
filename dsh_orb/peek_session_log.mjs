/**
 * Inspect one shape of the session store: how the log is compressed and what a record looks like.
 *
 * Usage: `node dsh_orb/peek_session_log.mjs <path to session.v4.jsonl.zstd>`
 */

import { createReadStream, readFileSync } from 'node:fs'
import { createZstdDecompress, zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: peek_session_log.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}
const raw = readFileSync(file)
console.log(`compressed: ${raw.length} bytes, magic ${raw.subarray(0, 4).toString('hex')}`)
console.log(`zstdDecompressSync (one frame only): ${typeof zstdDecompressSync}`)

/**
 * The whole log.
 *
 * `zstdDecompressSync` reads one frame and stops — 211 bytes of a 2MB file — because the store appends a
 * frame per write. The stream keeps going through every frame, which is the only way to read a session.
 */
function readAll(path) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = createReadStream(path).pipe(createZstdDecompress())
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })
}

try {
  const out = await readAll(file)
  const text = out.toString('utf8')
  console.log(`decompressed (all frames): ${out.length} bytes, ${(text.match(/\n/g) ?? []).length} newlines`)
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  console.log(`non-empty lines: ${lines.length}`)
  let parsed = 0
  const types = new Map()
  for (const line of lines) {
    try {
      const record = JSON.parse(line)
      parsed += 1
      types.set(record.type, (types.get(record.type) ?? 0) + 1)
    } catch {
      // A partial tail line is normal for a log being written to.
    }
  }
  console.log(`lines that parse as JSON: ${parsed}`)
  console.log('record types:')
  for (const [type, count] of [...types.entries()].sort((left, right) => right[1] - left[1]).slice(0, 14)) {
    console.log(`  ${String(count).padStart(5)}  ${type}`)
  }
} catch (error) {
  console.log(`streaming read threw: ${error.message}`)
}
