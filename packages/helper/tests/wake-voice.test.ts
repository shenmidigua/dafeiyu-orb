import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { WakeEngine, WAKE_VOICES, WAKE_VOICE_TEXTS } from '../assets/wake.js'

/**
 * The spoken confirmation a wake plays instead of the old chime.
 *
 * The page's own media plumbing is replaced with fakes rather than exercised: the question here is
 * which take a detection picks, what level it gets, and — the part that matters when a package is
 * built wrong — that a missing file costs the chime and nothing else. The helper's protocol route
 * that serves the files is covered from the other side by `pack_and_install.py`, which compares the
 * installed WAVs with the sources byte for byte.
 */

const stubApi = {
  wakeConfig: async () => ({}),
  wakeReport: async () => ({}),
}

/** One `Audio` element as the page would create it. */
class FakeAudio {
  static made: FakeAudio[] = []
  src: string
  volume = 1
  paused = false

  /** Media events, so a test can end the clip the way the browser would. */
  private readonly listeners = new Map<string, Set<() => void>>()

  constructor(src: string) {
    this.src = src
    FakeAudio.made.push(this)
  }

  addEventListener(name: string, handler: () => void): void {
    const set = this.listeners.get(name) ?? new Set()
    set.add(handler)
    this.listeners.set(name, set)
  }

  removeEventListener(name: string, handler: () => void): void {
    this.listeners.get(name)?.delete(handler)
  }

  /** Fire one media event, as playback finishing or failing would. */
  emit(name: 'ended' | 'error'): void {
    for (const handler of [...(this.listeners.get(name) ?? [])]) handler()
  }

  pause(): void {
    this.paused = true
  }

  play(): Promise<void> {
    return FakeAudio.refuse
      ? Promise.reject(Object.assign(new Error('autoplay is blocked'), { name: 'NotAllowedError' }))
      : Promise.resolve()
  }

  static refuse = false
}

/**
 * Install the browser pieces `playVoice` touches and return what was observed.
 * @param options.missing - indices in `WAKE_VOICES` the fake helper does not serve.
 * @param options.refuse - whether the fake element rejects `play()`, as an autoplay gate would.
 * @param options.extra - further `voices/...` names to serve, for a pre-rendered voice set.
 */
function stubPage({ missing = [] as number[], refuse = false, extra = [] as string[] } = {}) {
  const previous = {
    fetch: globalThis.fetch,
    audio: (globalThis as { Audio?: unknown }).Audio,
    create: URL.createObjectURL,
    revoke: URL.revokeObjectURL,
    random: Math.random,
  }
  const blobs = new Map<string, Blob>()
  const revoked: string[] = []
  let next = 0
  FakeAudio.made = []
  FakeAudio.refuse = refuse

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input)
    const index = WAKE_VOICES.findIndex((name) => url.endsWith(name))
    const name = extra.find((entry) => url.endsWith(entry))
    if (name !== undefined) {
      const blob = new Blob([`take-${name}`], { type: 'audio/wav' })
      blobs.set(url, blob)
      return new Response(blob, { status: 200 })
    }
    if (index === -1 || missing.includes(index)) return new Response(null, { status: 404 })
    const blob = new Blob([`take-${index}`], { type: 'audio/wav' })
    blobs.set(url, blob)
    return new Response(blob, { status: 200 })
  }) as typeof fetch
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    next += 1
    const url = `blob:take-${next}`
    blobs.set(url, blob as Blob)
    return url
  }
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url)
  }
  ;(globalThis as { Audio?: unknown }).Audio = FakeAudio

  return {
    played: FakeAudio.made,
    revoked,
    /** Which take an element was handed, by the fake blob's own text. */
    async take(audio: FakeAudio): Promise<string> {
      const blob = blobs.get(audio.src)
      assert.ok(blob, `no blob behind ${audio.src}`)
      return await blob.text()
    },
    restore() {
      globalThis.fetch = previous.fetch
      ;(globalThis as { Audio?: unknown }).Audio = previous.audio
      URL.createObjectURL = previous.create
      URL.revokeObjectURL = previous.revoke
      Math.random = previous.random
      FakeAudio.refuse = false
    },
  }
}

/** An engine that never loads models: the confirmation is the only thing under test. */
function engine(): WakeEngine {
  return new WakeEngine(stubApi as never)
}

describe('the spoken wake confirmation', () => {
  it('ships all three takes beside the helper assets', () => {
    assert.equal(WAKE_VOICES.length, 3)
    for (const name of WAKE_VOICES) {
      assert.ok(existsSync(new URL(`../assets/${name}`, import.meta.url)), `${name} is missing from assets`)
    }
  })

  it('describes every take, including the one that says 我在呢', () => {
    // One caption per clip, or the table silently captions a take it does not describe. The middle
    // take was written from the other two as "我在。", and the caption under that voice was wrong —
    // the user heard "我在呢" and read "我在". The three files were then read back through the
    // harness's own ASR, which is where these words come from; a re-recorded clip has to be heard
    // again rather than guessed.
    //
    // The third one is the lesson about reading an ASR line back: the clip says "我在，你说。" and
    // the recognizer returned it without the comma, which was then written up as "我在听你说。" —
    // a word the voice never said. The caption carries the comma now; the clip is unchanged.
    assert.equal(WAKE_VOICE_TEXTS.length, WAKE_VOICES.length)
    assert.deepEqual(WAKE_VOICE_TEXTS.map((text) => text.length > 0), [true, true, true])
    assert.equal(WAKE_VOICE_TEXTS[0], '我在。')
    assert.equal(WAKE_VOICE_TEXTS[1], '我在呢。')
    assert.equal(WAKE_VOICE_TEXTS[2], '我在，你说。')
  })

  it('plays one of the three takes, at full level, and never the chime', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      await wake.preloadVoices()
      const draws = [0, 0.34, 0.67, 0.999]
      for (const draw of draws) {
        Math.random = () => draw
        await wake.playChime()
      }
      assert.equal(page.played.length, draws.length, 'a take did not reach an audio element')
      for (const [index, draw] of draws.entries()) {
        assert.equal(await page.take(page.played[index]!), `take-${Math.floor(draw * 3)}`)
        assert.equal(page.played[index]!.volume, 1)
      }
      assert.deepEqual(page.revoked, [], 'a take that started was released before it ended')
    } finally {
      page.restore()
    }
  })

  it('falls back to the old chime when no take can be fetched', async () => {
    const page = stubPage({ missing: [0, 1, 2] })
    try {
      const wake = engine()
      const chimes: Array<{ notes: Array<{ freq: number }>; level: number }> = []
      wake.playNotes = (notes: Array<{ freq: number }>, level: number) => {
        chimes.push({ notes, level })
      }
      await wake.preloadVoices()
      await wake.playChime()
      assert.equal(page.played.length, 0, 'a missing take still reached an audio element')
      assert.equal(chimes.length, 1, 'the wake went silent instead of falling back')
      assert.equal(chimes[0]!.notes[0]!.freq, 880)
      // Cue tones are doubled with the rest of the short sounds; spoken takes stay at unity.
      assert.equal(chimes[0]!.level, 0.88)
    } finally {
      page.restore()
    }
  })

  it('falls back rather than substituting another take when the drawn one is missing', async () => {
    const page = stubPage({ missing: [1] })
    try {
      Math.random = () => 0.5
      const wake = engine()
      const chimes: unknown[] = []
      wake.playNotes = () => {
        chimes.push('chime')
      }
      await wake.preloadVoices()
      await wake.playChime()
      assert.equal(page.played.length, 0, 'another take was substituted for the missing one')
      assert.equal(chimes.length, 1)
    } finally {
      page.restore()
    }
  })

  it('falls back when the element is refused playback, so a wake is never silent', async () => {
    const page = stubPage({ refuse: true })
    try {
      const wake = engine()
      const chimes: unknown[] = []
      wake.playNotes = () => {
        chimes.push('chime')
      }
      await wake.preloadVoices()
      await wake.playChime()
      assert.equal(page.played.length, 1, 'the take was never attempted')
      assert.equal(chimes.length, 1, 'a refused take left the detection silent')
      assert.equal(page.revoked.length, 1, 'the refused blob URL was not released')
    } finally {
      page.restore()
    }
  })

  it('treats a dead fetch as a missing clip, so the next enable can retry', async () => {
    const page = stubPage()
    try {
      globalThis.fetch = (async () => {
        throw new Error('offline')
      }) as typeof fetch
      const wake = engine()
      const blobs = await wake.preloadVoices()
      assert.deepEqual(blobs, [null, null, null])
      assert.equal(wake.voiceLoad, undefined, 'a failed preload was cached as final')
    } finally {
      page.restore()
    }
  })

  it('holds the hand-off until the acknowledgement has finished talking', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      await wake.preloadVoices()
      Math.random = () => 0
      await wake.playChime()
      const clip = page.played[0]
      assert.ok(clip, 'no take reached an audio element')

      let handed = false
      const waited = wake.whenVoiceDone(2000).then(() => { handed = true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(handed, false,
        'the main window would record the greeting if the hand-off ran while the clip was talking')

      clip.emit('ended')
      await waited
      assert.equal(handed, true, 'the hand-off never came after the clip ended')
    } finally {
      page.restore()
    }
  })

  it('hands off at once when no clip is playing', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      // No preload and no wake: nothing is talking, so nothing delays the microphone.
      let handed = false
      await wake.whenVoiceDone(50).then(() => { handed = true })
      assert.equal(handed, true)
    } finally {
      page.restore()
    }
  })
})

/**
 * A cloned voice answers the wake itself, through the page's speech service.
 *
 * Two things change when that path is taken instead of a take: the caption comes from the hook
 * rather than from a table, and there is no audio element here to report the end of the greeting —
 * which is why the hook also hands over a promise, and why that promise has to be what the hand-off
 * waits on. Opening the microphone while "我在" was still being spoken is the whole failure.
 */
describe('the acknowledgement spoken by a cloned voice', () => {
  it('captions the line the page said, and plays no take over it', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      await wake.preloadVoices()
      wake.setSpokenAck(() => ({ line: '有何吩咐？', done: Promise.resolve() }))
      await wake.playChime()
      assert.equal(wake.voiceText(), '有何吩咐？')
      assert.equal(page.played.length, 0, 'a take was played on top of the spoken line')
    } finally {
      page.restore()
    }
  })

  it('holds the hand-off until the spoken line has finished', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      let release: () => void = () => {}
      const done = new Promise<void>((resolve) => { release = resolve })
      wake.setSpokenAck(() => ({ line: '我在。', done }))
      await wake.playChime()

      let handed = false
      const waited = wake.whenVoiceDone(2000).then(() => { handed = true })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(handed, false,
        'the microphone would open while the greeting is still being synthesised or spoken')

      release()
      await waited
      assert.equal(handed, true, 'the hand-off never came after the greeting finished')
    } finally {
      page.restore()
    }
  })

  it('caps the wait, so a greeting that never finishes cannot hold the microphone shut', async () => {
    const page = stubPage()
    try {
      const wake = engine()
      wake.setSpokenAck(() => ({ line: '我在。', done: new Promise<void>(() => {}) }))
      await wake.playChime()
      let handed = false
      await wake.whenVoiceDone(40).then(() => { handed = true })
      assert.equal(handed, true)
    } finally {
      page.restore()
    }
  })
})

/**
 * A voice whose greeting is rendered once and shipped beside the other takes.
 *
 * The point of the set is that a wake costs nothing: the clip is already in the page, so there is no
 * request at detection and no synthesis wait in front of the greeting. Everything here is about the
 * two ways that can go wrong — a set whose caption disagrees with its clip, and a set whose file the
 * helper does not serve, which has to cost the round trip rather than the answer.
 */
describe('the acknowledgement pre-rendered for one voice', () => {
  const names = ['voices/volc-S_LDHrp2Kl2-1.wav', 'voices/volc-S_LDHrp2Kl2-2.wav']
  const texts = ['我在。', '有何吩咐？']

  it('plays the shipped clip and captions the sentence it actually says', async () => {
    const page = stubPage({ extra: names })
    try {
      const wake = engine()
      wake.setVoiceSet({ names, texts })
      await wake.preloadVoices()
      Math.random = () => 0
      await wake.playChime()
      const clip = page.played[0]
      assert.ok(clip, 'the pre-rendered take never reached an audio element')
      assert.equal(await page.take(clip), 'take-voices/volc-S_LDHrp2Kl2-1.wav')
      assert.equal(wake.voiceText(), '我在。')
    } finally {
      page.restore()
    }
  })

  it('asks the service only when the clip is not there', async () => {
    const page = stubPage({ extra: [] })
    try {
      const wake = engine()
      wake.setVoiceSet({ names, texts })
      wake.setSpokenAck(() => ({ line: '有何吩咐？', done: Promise.resolve() }))
      await wake.playChime()
      assert.equal(wake.voiceText(), '有何吩咐？')
      assert.equal(page.played.length, 0, 'a take played although the set had no file')
    } finally {
      page.restore()
    }
  })

  it('goes back to the shipped takes when the set is cleared', async () => {
    const page = stubPage({ extra: names })
    try {
      const wake = engine()
      wake.setVoiceSet({ names, texts })
      await wake.preloadVoices()
      wake.setVoiceSet(undefined)
      await wake.preloadVoices()
      Math.random = () => 0
      await wake.playChime()
      const clip = page.played.at(-1)
      assert.ok(clip, 'no shipped take was played after the set was cleared')
      assert.equal(await page.take(clip), 'take-0')
      assert.equal(wake.voiceText(), '我在。')
    } finally {
      page.restore()
    }
  })
})
