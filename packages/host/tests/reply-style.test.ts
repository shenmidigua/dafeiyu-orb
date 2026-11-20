import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_REPLY_CHARS, MIN_REPLY_CHARS, ProfileStore } from '../src/preferences.ts'
import { REPLY_SECTION_ORDER, registerReplyStyle } from '../src/reply-style.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-reply-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

interface RegisteredSection {
  name: string
  order: number
  text: (context: { agent?: { session?: unknown } }) => string
}

/** A profile directory, optionally with the reply file already written. */
function profile(name: string, settings?: unknown): ProfileStore {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  if (settings !== undefined) {
    writeFileSync(join(path, 'orb-reply.json'), `${JSON.stringify(settings)}\n`)
  }
  return new ProfileStore(path)
}

/** Register the section against a fake registry and hand back what it registered. */
function register(store: ProfileStore): RegisteredSection {
  const sections: RegisteredSection[] = []
  const ctx = {
    systemPrompt: {
      section(section: RegisteredSection) {
        sections.push(section)
        return () => {}
      },
    },
  }
  registerReplyStyle(ctx, store)
  assert.equal(sections.length, 1, 'the plugin must register exactly one reply-style section')
  return sections[0] as RegisteredSection
}

/** The ball's own workspace, which is what makes a session "the ball's". */
const orbCwd = dshHomePath('dsh_orb')

const overlaySession = { header: { agentPreset: 'computer-use', cwd: join(orbCwd, 'task-two') } }
const backgroundSession = { header: { agentPreset: 'standard', cwd: join(orbCwd, 'task-three') } }
const windowSession = { header: { agentPreset: 'computer-use', cwd: join(root, 'elsewhere') } }

describe('reply style', () => {
  it('constrains the ball by default, without a profile file', () => {
    const section = register(profile('default'))
    assert.equal(section.order, REPLY_SECTION_ORDER)
    const text = section.text({ agent: { session: overlaySession } })
    assert.match(text, /极简回复/)
    // Every hard constraint from the brief has to survive into the prompt text itself.
    assert.match(text, /80 字/)
    assert.match(text, /先给结论/)
    assert.match(text, /不要表格/)
    assert.match(text, /不要罗列参考链接/)
    assert.match(text, /顺带一提/)
    assert.match(text, /不要 Markdown 表格、多层列表或代码块/)
    assert.match(text, /展开/)
  })

  it('covers the background track the ball spawns', () => {
    const section = register(profile('background'))
    assert.match(section.text({ agent: { session: backgroundSession } }), /极简回复/)
  })

  it('leaves the main window and prompt diagnostics untouched', () => {
    const section = register(profile('window'))
    // Empty text is what the prompt renderer drops, so "no section" is exactly this.
    assert.equal(section.text({ agent: { session: windowSession } }), '')
    assert.equal(section.text({}), '')
    assert.equal(section.text({ agent: {} }), '')
  })

  it('turns off with "enabled": false', () => {
    const off = register(profile('off', { enabled: false }))
    assert.equal(off.text({ agent: { session: overlaySession } }), '')
    const on = register(profile('on', { enabled: true }))
    assert.match(on.text({ agent: { session: overlaySession } }), /极简回复/)
  })

  it('uses the configured cap and clamps it to the usable band', () => {
    assert.match(register(profile('cap', { maxReplyChars: 40 })).text({ agent: { session: overlaySession } }), /40 字/)
    assert.match(
      register(profile('cap-low', { maxReplyChars: 5 })).text({ agent: { session: overlaySession } }),
      new RegExp(`${String(MIN_REPLY_CHARS)} 字`),
    )
    assert.match(
      register(profile('cap-high', { maxReplyChars: 99_999 })).text({ agent: { session: overlaySession } }),
      new RegExp(`${String(MAX_REPLY_CHARS)} 字`),
    )
    assert.match(
      register(profile('cap-junk', { maxReplyChars: 'lots' })).text({ agent: { session: overlaySession } }),
      /80 字/,
    )
  })

  it('re-reads the file, so a hand edit applies on the next turn', () => {
    const store = profile('live')
    const section = register(store)
    assert.match(section.text({ agent: { session: overlaySession } }), /极简回复/)
    writeFileSync(join(root, 'live', 'orb-reply.json'), '{"enabled":false}\n')
    assert.equal(section.text({ agent: { session: overlaySession } }), '')
  })
})
