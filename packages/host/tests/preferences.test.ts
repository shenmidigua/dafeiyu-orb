import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ProfileStore,
  defaultMillifraction,
  isSpeechEndpoint,
  profileDirectory,
  sniffAvatarMime,
} from '../src/preferences.ts'

const root = mkdtempSync(join(tmpdir(), 'orb-prefs-'))
after(() => { rmSync(root, { recursive: true, force: true }) })

function dir(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

describe('profile preferences', () => {
  it('uses the shipped defaults when the profile files are missing', () => {
    const store = new ProfileStore(dir('empty'))
    assert.equal(store.permission(), 'danger-full-access')
    assert.equal(store.permissionFallback(), false)
    assert.deepEqual(store.models().overlay, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    assert.deepEqual(store.models().background, store.models().overlay)
    assert.equal(store.millifractionEnabled(), defaultMillifraction())
    assert.equal(store.coordinateMode(), defaultMillifraction() ? 'millifraction' : 'pixel')
    assert.equal(store.selectionEnabled(), false)
    assert.equal(store.ballEnabled(), true)
    assert.equal(store.avatarVersion(), 0)
    assert.equal(store.readAvatar(), undefined)
  })

  it('keeps the two model tracks and the selection language apart', () => {
    const path = dir('models')
    // The selection toolbar is disabled everywhere: a stored enabled flag is ignored.
    writeFileSync(join(path, 'selection-toolbar.json'), JSON.stringify({
      enabled: true,
      translateTargetLanguage: 'en',
    }))
    const store = new ProfileStore(path)
    assert.equal(store.selectionEnabled(), false)
    store.setOverlay({ provider: 'deepseek-official', model: 'deepseek-pro', reasoningEffort: 'high' })
    store.setBackground({ provider: 'other', model: 'background-model' })
    store.setSelectionEnabled(true)
    const models = JSON.parse(readFileSync(join(path, 'orb-agent-models.json'), 'utf8')) as {
      overlay: { model: string }
      background: { model: string; reasoningEffort?: string }
    }
    assert.equal(models.overlay.model, 'deepseek-pro')
    assert.equal(models.background.model, 'background-model')
    assert.equal(models.background.reasoningEffort, undefined)
    const selection = JSON.parse(readFileSync(join(path, 'selection-toolbar.json'), 'utf8')) as {
      enabled: boolean
      translateTargetLanguage: string
    }
    assert.equal(selection.enabled, true)
    assert.equal(selection.translateTargetLanguage, 'en')
    // The starting point is the platform default, not a hardcoded 'pixel': Windows ships
    // millifraction on, so asserting the mode name directly failed there while passing on macOS.
    assert.equal(store.coordinateMode(), defaultMillifraction() ? 'millifraction' : 'pixel')
    store.setMillifractionEnabled(true)
    assert.equal(store.coordinateMode(), 'millifraction')
    assert.equal(JSON.parse(readFileSync(join(path, 'millifraction-coordinates.json'), 'utf8')).enabled, true)
  })

  it('turns the ball off in ball-enabled.json and accepts only gif, png, and webp avatars', () => {
    const path = dir('avatar')
    const store = new ProfileStore(path)
    store.setPermission('read-only')
    store.setBallEnabled(false)
    assert.equal(JSON.parse(readFileSync(join(path, 'orb-permission.json'), 'utf8')).preset, 'read-only')
    assert.equal(JSON.parse(readFileSync(join(path, 'ball-enabled.json'), 'utf8')).enabled, false)
    assert.equal(new ProfileStore(path).ballEnabled(), false)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    const gif = Buffer.from('GIF89a', 'ascii')
    const webp = Buffer.from('RIFF\0\0\0\0WEBP', 'ascii')
    assert.equal(sniffAvatarMime(png), 'image/png')
    assert.equal(sniffAvatarMime(gif), 'image/gif')
    assert.equal(sniffAvatarMime(webp), 'image/webp')
    assert.equal(sniffAvatarMime(Buffer.from('not-an-image')), undefined)
    store.writeAvatar(png, 'image/png')
    assert.equal(store.readAvatar()?.mime, 'image/png')
    assert.ok(store.avatarVersion() > 0)
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ mime: 'image/gif' }))
    assert.equal(new ProfileStore(path).readAvatar(), undefined)
    store.restoreAvatar()
    writeFileSync(join(path, 'orb-permission.json'), '{')
    const broken = new ProfileStore(path)
    assert.equal(broken.permission(), 'workspace-write')
    assert.equal(broken.permissionFallback(), true)
    writeFileSync(join(path, 'orb-permission.json'), JSON.stringify({ preset: 'nope' }))
    assert.equal(new ProfileStore(path).permissionFallback(), true)
    broken.setPermission('read-only')
    assert.equal(new ProfileStore(path).permission(), 'read-only')
    assert.equal(new ProfileStore(path).permissionFallback(), false)
    assert.equal(store.readAvatar(), undefined)
    assert.equal(store.avatarVersion(), 0)
  })

  it('keeps read-aloud off until asked, and persists both switches with the endpoint', () => {
    const path = dir('speech')
    // Off is the default, not "on unless disabled": a profile that never opened these settings has
    // no TTS service behind it, and buttons that always fail are worse than no buttons.
    const store = new ProfileStore(path)
    assert.deepEqual(store.speech(), {
      enabled: false,
      autoPlay: false,
      endpoint: 'http://127.0.0.1:8765',
    })

    store.setSpeech({ enabled: true, autoPlay: false, endpoint: 'http://127.0.0.1:9000' })
    assert.deepEqual(new ProfileStore(path).speech(), {
      enabled: true,
      autoPlay: false,
      endpoint: 'http://127.0.0.1:9000',
    })
    assert.deepEqual(JSON.parse(readFileSync(join(path, 'orb-speech.json'), 'utf8')), {
      enabled: true,
      autoPlay: false,
      endpoint: 'http://127.0.0.1:9000',
    })
  })

  it('falls back per field on a half-written or hostile speech file', () => {
    const path = dir('speech-broken')
    // Each field is validated on its own, so one bad value does not discard the user's other
    // choices — and `enabled: "yes"` must not read as true.
    writeFileSync(join(path, 'orb-speech.json'), JSON.stringify({
      enabled: 'yes',
      autoPlay: true,
      endpoint: 'file:///etc/passwd',
    }))
    assert.deepEqual(new ProfileStore(path).speech(), {
      enabled: false,
      autoPlay: true,
      endpoint: 'http://127.0.0.1:8765',
    })

    writeFileSync(join(path, 'orb-speech.json'), '{')
    assert.equal(new ProfileStore(path).speech().enabled, false)
    assert.equal(new ProfileStore(path).speech().autoPlay, false)
  })

  it('accepts only http and https speech endpoints', () => {
    assert.equal(isSpeechEndpoint('http://127.0.0.1:8765'), true)
    assert.equal(isSpeechEndpoint('https://tts.example.com'), true)
    // A `file:` endpoint would turn a settings typo into a local file read by the renderer.
    assert.equal(isSpeechEndpoint('file:///C:/secret.wav'), false)
    assert.equal(isSpeechEndpoint('javascript:alert(1)'), false)
    assert.equal(isSpeechEndpoint('127.0.0.1:8765'), false)
    assert.equal(isSpeechEndpoint(''), false)
    assert.equal(isSpeechEndpoint(undefined), false)
    assert.equal(isSpeechEndpoint(`http://${'x'.repeat(300)}`), false, 'a runaway value is refused')
  })

  it('keeps one avatar per profile: a built-in pick replaces the upload and the other way round', () => {
    const path = dir('avatar-preset')
    const store = new ProfileStore(path)
    assert.deepEqual(store.avatarSelection(), { kind: 'default' })

    store.selectAvatarPreset('heart')
    assert.deepEqual(store.avatarSelection(), { kind: 'preset', id: 'heart' })
    assert.equal(store.readAvatar(), undefined)
    assert.ok(store.avatarVersion() > 0)

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
    store.writeAvatar(png, 'image/png')
    assert.deepEqual(store.avatarSelection(), { kind: 'custom', mime: 'image/png' })

    store.selectAvatarPreset('point')
    assert.equal(existsSync(join(path, 'orb-avatar')), false)
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'preset', id: 'point' })

    // A preset that this build no longer ships falls back to the shipped GIF.
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ kind: 'preset', preset: 'gone' }))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'default' })

    // Meta written by the older shape still means "uploaded image".
    writeFileSync(join(path, 'orb-avatar'), png)
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ mime: 'image/png' }))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'custom', mime: 'image/png' })

    // Half-written state: the meta claims an upload the disk does not have.
    writeFileSync(join(path, 'orb-avatar.json'), JSON.stringify({ kind: 'custom', mime: 'image/png' }))
    rmSync(join(path, 'orb-avatar'))
    assert.deepEqual(new ProfileStore(path).avatarSelection(), { kind: 'default' })

    store.restoreAvatar()
    assert.deepEqual(store.avatarSelection(), { kind: 'default' })
    assert.equal(store.avatarVersion(), 0)
  })

  it('reads the official profile directory', () => {
    assert.equal(profileDirectory({ get: () => ({ dir: '/tmp/dsh-profile' }) }), '/tmp/dsh-profile')
    const fallback = profileDirectory({ get: () => undefined })
    assert.equal(fallback, process.cwd())
    assert.equal(defaultMillifraction('win32'), true)
    assert.equal(defaultMillifraction('darwin'), false)
    assert.equal(defaultMillifraction('linux'), false)
  })
})

describe('wake preferences', () => {
  it('keeps the shipped dictation defaults while nothing is configured', () => {
    const store = new ProfileStore(dir('wake-empty'))
    assert.deepEqual(store.wake().dictation, { enabled: true, silenceMs: 1200, maxSeconds: 15, autoSend: false })
  })

  it('clamps the dictation block and survives a rewrite of the switch', () => {
    const path = dir('wake-file')
    writeFileSync(join(path, 'orb-wake.json'), JSON.stringify({
      enabled: true,
      keyword: 'hey_jarvis',
      dictation: { enabled: false, silenceMs: 1, maxSeconds: 9999, autoSend: true },
    }))
    const store = new ProfileStore(path)
    assert.deepEqual(store.wake().dictation, { enabled: false, silenceMs: 300, maxSeconds: 120, autoSend: true })
    store.setWakeEnabled(false)
    const reread = new ProfileStore(path).wake()
    assert.equal(reread.enabled, false)
    assert.deepEqual(reread.dictation, { enabled: false, silenceMs: 300, maxSeconds: 120, autoSend: true })
    const written = JSON.parse(readFileSync(join(path, 'orb-wake.json'), 'utf8')) as { dictation?: unknown }
    assert.deepEqual(written.dictation, { enabled: false, silenceMs: 300, maxSeconds: 120, autoSend: true })
  })

  it('re-reads the file before flipping the switch, so an outside edit is not undone', () => {
    // The regression in one assertion. `orb-wake.json` is read once into memory at construction,
    // and `setWakeEnabled` used to write that whole snapshot back — so a field edited on disk
    // while the host was running (by hand, or by a settings page that has its own copy of the
    // state) was silently reverted by the next unrelated toggle. What made it bite in practice is
    // that the helper is launched once per host start and reads `enabled` out of its environment,
    // so a toggle written *after* launch has no effect until the next restart, while the file on
    // disk now claims the opposite. Re-reading narrows the window to the fields this call owns.
    const path = dir('wake-reread')
    const file = join(path, 'orb-wake.json')
    writeFileSync(file, JSON.stringify({
      enabled: true, keyword: 'hey_jarvis', threshold: 0.5, autoExpandOnWake: true,
    }))
    const store = new ProfileStore(path)

    // Somebody edits the file underneath the running host: a new keyword, and the switch on.
    writeFileSync(file, JSON.stringify({
      enabled: true, keyword: 'dafeiyu', threshold: 0.95, autoExpandOnWake: false,
      assetDirectory: 'C:/models/dafeiyu/assets',
    }))

    store.setWakeEnabled(false)

    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.equal(written.enabled, false, 'the switch this call owns was not written')
    // Everything else belongs to whoever wrote the file last, not to this process's snapshot.
    assert.equal(written.keyword, 'dafeiyu', 'the keyword was reverted to the value read at startup')
    assert.equal(written.threshold, 0.95, 'the threshold was reverted to the value read at startup')
    assert.equal(written.autoExpandOnWake, false, 'autoExpandOnWake was reverted')
    assert.equal(written.assetDirectory, 'C:/models/dafeiyu/assets', 'the asset directory was reverted')
  })

  it('still clamps an outside edit rather than trusting it', () => {
    // Re-reading is only safe because the same validation runs on the way in. Without it, a
    // hand-edited threshold of 5 or a negative silence would reach the engine as written, and the
    // engine would then never detect anything with no way for the user to tell why.
    const path = dir('wake-reread-clamp')
    const file = join(path, 'orb-wake.json')
    writeFileSync(file, JSON.stringify({ enabled: true, keyword: 'hey_jarvis' }))
    const store = new ProfileStore(path)
    writeFileSync(file, JSON.stringify({
      enabled: true, keyword: 'dafeiyu', threshold: 5, autoExpandOnWake: true,
      dictation: { enabled: true, silenceMs: -1, maxSeconds: 9999, autoSend: false },
    }))
    store.setWakeEnabled(false)
    const reread = new ProfileStore(path).wake()
    // 5 is above the 0.99 ceiling, so it clamps down to it rather than being taken literally.
    assert.equal(reread.threshold, 0.99, 'an out-of-range threshold survived the round trip')
    assert.deepEqual(reread.dictation, { enabled: true, silenceMs: 300, maxSeconds: 120, autoSend: false })
  })
})
