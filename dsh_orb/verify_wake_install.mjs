/**
 * Confirm the two wake-word fixes are present in the *installed* host bundle.
 *
 * This checks bytes, not behaviour, and the patterns are written to survive what the bundler does
 * to the source: it reformats objects across several lines, and it rewrites `undefined` as
 * `void 0`. An earlier version of this probe matched the prettified source and reported three
 * failures on a build that was in fact correct — the lesson from the `webfetch` probe, where the
 * first three checks also "failed" for reasons that had nothing to do with the code.
 */

import { readFileSync } from 'node:fs'

const INSTALLED = `${process.env.USERPROFILE}/.dsh/profiles/desktop/node_modules/dsh-orb/dist/host/index.js`
const source = readFileSync(INSTALLED, 'utf8')

const checks = [
  // 1. `resolveWakeAssets` exists as a named function and validates before using the path.
  ['resolveWakeAssets is defined', /function resolveWakeAssets\(/],
  ['the configured directory is validated, not trusted',
    /const configured = readWakeDirectory\(preference\.assetDirectory, preference\.keyword\)/],
  // The fall-through is what makes an unusable path recoverable rather than fatal. The body is
  // short, so matching the whole of it is also the strongest form of this check.
  ['an unusable configured directory falls through to discovery',
    /function resolveWakeAssets\(preference\) \{[\s\S]*?return discoverWakeAssets\(preference\.keyword\);\n\}/],
  // 2. `setWakeEnabled` re-reads instead of writing back the startup snapshot.
  ['setWakeEnabled re-reads the file', /this\.wakeValue = \{\s*\.\.\.readWake\(this\.dir\),\s*enabled/],
  // 3. The tuning reaches the helper even with no models, so "off" and "wanted but broken" differ.
  ['tuning is sent even when no models were found', /return \{ DSH_ORB_WAKE: tuning \}/],
  ['assets and tuning travel together when models were found',
    /DSH_ORB_WAKE_ASSETS: assets,\s*DSH_ORB_WAKE: tuning/],
  // 4. The diagnostic names the directory instead of shrugging.
  ['the diagnostic names the directory', /does not hold the models for/],
]

let bad = 0
for (const [label, test] of checks) {
  const ok = test.test(source)
  if (!ok) bad += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

// Absence checks. These need `.test(source)` rather than `!/regex/`: a `RegExp` object is always
// truthy, so `!` applied to the object itself is a constant `false` and the probe reports FAIL on
// a perfectly good build. The first version of this file had exactly that, and the bundle was
// verified clean by two other tools while this one insisted the old code was still there.
const absences = [
  ['the old trust-the-path form is gone', !/resolve\(settings\.assetDirectory\)/.test(source)],
  ['setWakeEnabled no longer writes the startup snapshot', !/\.\.\.this\.wakeValue, enabled/.test(source)],
]
for (const [label, ok] of absences) {
  if (!ok) bad += 1
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}`)
}

console.log(bad === 0 ? '\ninstalled host bundle carries every wake fix' : `\n${bad} PROBLEM(S)`)
process.exit(bad === 0 ? 0 : 1)
