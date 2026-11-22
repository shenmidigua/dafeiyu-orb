import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { MAX_PERSONA_CHARS, ProfileStore } from '../src/preferences.ts'
import { PERSONA_SECTION_ORDER, registerPersona } from '../src/persona.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-persona-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

interface RegisteredSection {
  name: string
  order: number
  text: (context: { agent?: { session?: unknown } }) => string
}

/** A profile directory with a speech voice and, optionally, a persona file already written. */
function profile(name: string, options: { voice?: string; personas?: unknown } = {}): ProfileStore {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'orb-speech.json'), `${JSON.stringify({
    enabled: true,
    autoPlay: true,
    endpoint: 'http://127.0.0.1:8765',
    voice: options.voice ?? '',
  })}\n`)
  if (options.personas !== undefined) {
    writeFileSync(join(path, 'orb-persona.json'), `${JSON.stringify(options.personas)}\n`)
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
  registerPersona(ctx, store)
  assert.equal(sections.length, 1, 'the plugin must register exactly one persona section')
  return sections[0] as RegisteredSection
}

const orbCwd = dshHomePath('dsh_orb')
const orbSession = { header: { agentPreset: 'computer-use', cwd: join(orbCwd, 'task-one') } }
const windowSession = { header: { agentPreset: 'computer-use', cwd: join(root, 'elsewhere') } }

const DELAMAIN = '## 人格：德拉曼\n\n礼貌、克制、正式。'

describe('the voice persona', () => {
  it('answers in the character of the voice that is reading', () => {
    const section = register(profile('mapped', {
      voice: 'volc-S_LDHrp2Kl2',
      personas: { voices: { 'volc-S_LDHrp2Kl2': DELAMAIN } },
    }))
    assert.equal(section.order, PERSONA_SECTION_ORDER)
    assert.equal(section.text({ agent: { session: orbSession } }), DELAMAIN)
  })

  it('finds an entry written with the console form of the id', () => {
    const section = register(profile('bare', {
      voice: 'volc-S_LDHrp2Kl2',
      personas: { voices: { S_LDHrp2Kl2: DELAMAIN } },
    }))
    assert.equal(section.text({ agent: { session: orbSession } }), DELAMAIN)
  })

  it('stays out of the main window, which never chose a voice', () => {
    const section = register(profile('window', {
      voice: 'volc-S_LDHrp2Kl2',
      personas: { voices: { 'volc-S_LDHrp2Kl2': DELAMAIN } },
    }))
    // The prompt renderer drops empty text, so "no section" is exactly this.
    assert.equal(section.text({ agent: { session: windowSession } }), '')
    assert.equal(section.text({}), '')
    assert.equal(section.text({ agent: {} }), '')
  })

  it('says nothing for a voice with no persona, or with no file at all', () => {
    const other = register(profile('other-voice', {
      voice: 'volc-S_77Ftp2Kl2',
      personas: { voices: { 'volc-S_LDHrp2Kl2': DELAMAIN } },
    }))
    assert.equal(other.text({ agent: { session: orbSession } }), '')
    assert.equal(register(profile('no-file')).text({ agent: { session: orbSession } }), '')
    // The service default is the empty voice, and it means "nobody in particular".
    assert.equal(register(profile('no-voice', {
      personas: { voices: { '': DELAMAIN } },
    })).text({ agent: { session: orbSession } }), '')
  })

  it('refuses a persona that is really a document', () => {
    const section = register(profile('huge', {
      voice: 'volc-S_LDHrp2Kl2',
      personas: { voices: { 'volc-S_LDHrp2Kl2': 'x'.repeat(MAX_PERSONA_CHARS + 1) } },
    }))
    assert.equal(section.text({ agent: { session: orbSession } }), '')
  })

  it('re-reads the file, so switching voices applies on the next turn', () => {
    const store = profile('live', {
      voice: 'volc-S_LDHrp2Kl2',
      personas: { voices: { 'volc-S_LDHrp2Kl2': DELAMAIN } },
    })
    const section = register(store)
    assert.equal(section.text({ agent: { session: orbSession } }), DELAMAIN)
    writeFileSync(join(root, 'live', 'orb-speech.json'), `${JSON.stringify({
      enabled: true, autoPlay: true, endpoint: 'http://127.0.0.1:8765', voice: 'volc-S_77Ftp2Kl2',
    })}\n`)
    store.setSpeech({ enabled: true, autoPlay: true, endpoint: 'http://127.0.0.1:8765', voice: 'volc-S_77Ftp2Kl2' })
    assert.equal(section.text({ agent: { session: orbSession } }), '')
  })
})
