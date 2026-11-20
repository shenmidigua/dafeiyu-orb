import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { WakeEngine, WAKE_VOICES } from '../assets/wake.js'

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
 */
function stubPage({ missing = [] as number[], refuse = false } = {}) {
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
