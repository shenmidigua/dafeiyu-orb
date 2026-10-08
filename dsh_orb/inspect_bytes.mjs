/**
 * Log a file's real bytes around a line, so a shell's idea of what it wrote can be checked against the disk.
 *
 * Written after `Select-String` reported "not found" for text that a Node-side search found two hundred
 * characters away: the shell and the file disagreed about line endings or encoding, and the disagreement was
 * invisible. Reading the same bytes with Node is the only way to tell which of them is right.
 *
 * Usage: `node dsh_orb/inspect_bytes.mjs <file> <line>`
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const wanted = Number(process.argv[3] ?? 1)
const raw = readFileSync(file)
const text = raw.toString('utf8')
const lines = text.split('\n')

console.log(`file: ${file}`)
console.log(`bytes: ${raw.length}, CRLF: ${(text.match(/\r\n/g) ?? []).length}, LF: ${(text.match(/\n/g) ?? []).length}`)
const from = Math.max(1, wanted - 6)
const to = Math.min(lines.length, wanted + 12)
for (let n = from; n <= to; n += 1) {
  const marker = n === wanted ? '>>' : '  '
  console.log(`${marker} ${String(n).padStart(5)}: ${lines[n - 1].replace(/\r$/, '')}`)
}
