import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const overlays = readFileSync(join(here, '../src/overlays.ts'), 'utf8')

/**
 * The coloured band that used to be drawn around whatever region the agent was working in.
 *
 * It is off by request: on every wake that touched another window it put a rainbow ribbon around
 * that window, and it read as noise rather than as "this is being observed". What must survive the
 * switch is the acknowledgement — the host gates capture and posted input on it — so this test
 * holds both halves at once: nothing painted, and the ack still sent.
 */
describe('the observation ribbon', () => {
  it('paints nothing around the observed region', () => {
    // Sliced to the branch, so a call left anywhere else in the file cannot satisfy it.
    const branch = /if \(record\.type === 'observation-frame'\) \{[\s\S]*?\n      \}/.exec(overlays)?.[0] ?? ''
    assert.notEqual(branch, '', 'the observation-frame branch is there to slice')
    const uncommented = branch
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    assert.equal(/showFrame\(/.test(uncommented), false, 'no frame is shown')
    assert.match(branch, /frame\.hide\(\)/, 'and one already on screen is taken down')
  })

  it('still answers the host, which waits for it before capturing', () => {
    const branch = /if \(record\.type === 'observation-frame'\) \{[\s\S]*?\n      \}/.exec(overlays)?.[0] ?? ''
    assert.match(branch, /ack\(record\.id\)/, 'a hidden overlay must not look like a stalled one')
  })
})
