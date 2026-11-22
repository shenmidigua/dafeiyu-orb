import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readAvatarChoice } from '../src/avatar.ts'

describe('avatar messages', () => {
  it('takes the custom avatar from the route and needs a version to refetch on', () => {
    assert.deepEqual(readAvatarChoice({ kind: 'custom', version: 1759250000000 }), {
      kind: 'custom',
      version: 1759250000000,
    })
    assert.deepEqual(readAvatarChoice({ kind: 'custom', version: 0 }), { kind: 'default' })
    assert.deepEqual(readAvatarChoice({ kind: 'custom', version: 'nope' }), { kind: 'default' })
  })

  it('falls back to the shipped GIF for the older message shape', () => {
    assert.deepEqual(readAvatarChoice({ version: 12 }), { kind: 'default' })
    assert.deepEqual(readAvatarChoice({ kind: 'default', version: 12 }), { kind: 'default' })
    assert.deepEqual(readAvatarChoice({}), { kind: 'default' })
  })

  it('ignores the deleted preset kind, including a path that looks valid', () => {
    // `kind: 'preset'` used to name a shipped GIF by relative path. The gallery is gone, so the
    // helper must not turn one into a source the page would then try to load: the files are not in
    // the bundle any more and the host's route that served them is deleted too.
    assert.deepEqual(readAvatarChoice({ kind: 'preset', src: 'avatars/heart.gif', version: 7 }), {
      kind: 'default',
    })
    assert.deepEqual(readAvatarChoice({ kind: 'preset', src: '../../etc/passwd' }), { kind: 'default' })
  })
})
