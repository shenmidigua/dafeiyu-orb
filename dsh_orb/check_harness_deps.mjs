/**
 * Compare the names a compiled test body destructures with the names its `deps` object provides.
 *
 * A name that is destructured but not provided fails at run time with `x is not defined`, and a name provided
 * but not destructured is harmless. That asymmetry is what makes an over-eager edit here so hard to see: the
 * file still parses, and the failure arrives as a test that has nothing to do with the change. This reports the
 * first half of the comparison for one file, so a broken harness names itself.
 *
 * Usage: `node dsh_orb/check_harness_deps.mjs <file>`
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const text = readFileSync(file, 'utf8')

// Every `new Function('deps', \`…\`)` body in the file.
const bodies = []
let cursor = 0
for (;;) {
  const opener = text.indexOf("new Function('deps', `", cursor)
  if (opener === -1) break
  const backtick = text.indexOf('`', opener + "new Function('deps',".length)
  const start = text.indexOf('\n', backtick) + 1
  const end = text.indexOf('`)', start)
  if (end === -1) break
  bodies.push(text.slice(start, end))
  cursor = start
}

console.log(`${file}: ${bodies.length} compiled body(ies)`)
bodies.forEach((body, index) => {
  const destructure = /const\s*\{([\s\S]*?)\}\s*=\s*deps/.exec(body)
  if (destructure === null) {
    console.log(`\nbody ${index + 1}: no destructuring found`)
    return
  }
  const names = destructure[1]
    .split(',')
    .map((part) => part.trim().split(':')[0].trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
  // The `deps` object is the argument to whatever factory this body was handed to; find it by the object
  // literal that follows the body's closing delimiter.
  const after = text.slice(text.indexOf(body, 0) + body.length)
  const objectAt = after.indexOf('{')
  const provided = new Set()
  if (objectAt !== -1) {
    let depth = 0
    let index = objectAt
    for (; index < after.length; index += 1) {
      if (after[index] === '{') depth += 1
      else if (after[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    // Split the object literal on its top-level commas and take the key of each entry, including a shorthand
    // `Date,` — which is how the page's own globals are handed in. Missing that case is what made the first
    // run of this report every harness as broken.
    for (const entry of after.slice(objectAt + 1, index).split(/,(?![^(){}[\]]*[)\]}])/)) {
      const key = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?::|,|$)/.exec(entry)
      if (key !== null) provided.add(key[1])
    }
  }
  const missing = names.filter((name) => !provided.has(name))
  console.log(`\nbody ${index + 1}: ${names.length} destructured, ${provided.size} provided`)
  console.log(missing.length === 0 ? '  all destructured names are provided' : `  MISSING: ${missing.join(', ')}`)
  // The reverse direction matters here too: a name the factory provides but the body never destructures is
  // exactly what an over-eager edit leaves behind, and it is invisible — extra keys in a `deps` object are
  // harmless, so the file keeps passing with a variable in it that no longer exists in the page.
  const extra = [...provided].filter((name) => !names.includes(name))
  const suspicious = extra.filter((name) => /webfetch|WEB_FETCH|toolSrc|agentState|agentTool/.test(name))
  if (suspicious.length > 0) console.log(`  provided but NOT destructured: ${suspicious.join(', ')}`)
})
