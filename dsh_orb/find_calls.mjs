/**
 * Find every call site of a name in a file, with a few lines of context, read with Node.
 *
 * Usage: `node dsh_orb/find_calls.mjs <file> <name>`
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const name = process.argv[3]
if (file === undefined || name === undefined) {
  console.error('usage: find_calls.mjs <file> <name>')
  process.exit(1)
}
const lines = readFileSync(file, 'utf8').split('\n')
let found = 0
lines.forEach((line, index) => {
  if (!line.includes(name)) return
  found += 1
  console.log(`--- line ${index + 1}`)
  for (let n = Math.max(0, index - 2); n <= Math.min(lines.length - 1, index + 6); n += 1) {
    console.log(`${n === index ? '>>' : '  '} ${String(n + 1).padStart(5)}: ${lines[n].replace(/\r$/, '')}`)
  }
})
console.log(`\n${found} mention(s) of ${name}`)
