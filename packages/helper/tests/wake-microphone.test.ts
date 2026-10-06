import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WakeEngine } from '../assets/wake.js'

/**
 * Opening the microphone.
 *
 * `openMicrophone` is where the wake engine stops being a set of models and becomes a listener:
 * the microphone opens, the worklet is installed, the graph is wired, and only then is a note
 * returned for the status line. Every one of those steps has to finish.
 *
 * The bug this file exists for was a `ReferenceError` on the last line of that function — a name
 * that was left behind when the status note was refactored — which threw *after* the graph was
 * live and *before* the caller learned anything. `start()` caught it and reported the engine as
 * dead, so the ball said "wake word unavailable" and no amount of fixing the configuration could
 * change that. Nothing about the configuration was wrong.
 *
 * The engine is driven as a real instance with stubbed browser objects, because the failure was
 * only reachable by executing the function: reading its source shows a plausible line.
 */

/** `getSettings()` as a browser reports it, with the two interesting values overridden. */
function track(settings: Record<string, unknown>) {
  return { kind: 'audio', stop() {}, getSettings: () => settings }
}

/**
 * Put a value on `globalThis` and hand back the way to take it off again.
 *
 * `navigator` is a getter-only accessor on the global object in Node, so a plain assignment
 * throws `Cannot set property navigator`. Defining the property works around that and is undone
 * exactly — the descriptor is restored, not just the value, so a test that replaced the accessor
 * itself is not left behind.
 */
function stash(host: Record<string, unknown>, name: string, value: unknown): () => void {
  const before = Object.getOwnPropertyDescriptor(host, name)
  Object.defineProperty(host, name, { value, configurable: true, writable: true })
  return () => {
    if (before === undefined) delete host[name]
    else Object.defineProperty(host, name, before)
  }
}

/**
 * A browser whose microphone and audio graph behave, recording what was asked of it.
 *
 * `sampleRateAccepted` decides whether the graph is created at 16 kHz or has to fall back, which
 * is what makes the sampling-rate note appear — so both branches are reachable here.
 */
function browser({ echoCancellation = true, sampleRateAccepted = true } = {}) {
  const asked: Array<Record<string, unknown>> = []
  const created: Array<{ sampleRate?: number }> = []
  const gains: number[] = []

  // A plain function, not an arrow: the page calls `new AudioContext(...)`, and an arrow is not
  // a constructor — the stub would fail with "is not a constructor" rather than reaching the bug.
  function context(this: unknown, options?: { sampleRate?: number }): unknown {
    created.push(options ?? {})
    if (!sampleRateAccepted && options?.sampleRate !== undefined) {
      throw new Error('this device cannot open at 16 kHz')
    }
    return {
      state: 'running',
      sampleRate: options?.sampleRate ?? 48000,
      resume: async () => {},
      close: async () => {},
      createMediaStreamSource: () => ({ connect() {} }),
      createGain: () => {
        const gain = {
          gain: { value: 1 },
          // Recorded rather than returned: the gain must be zero, or the graph echoes the room
          // back out of the speakers it just captured.
          connect(dest: { kind: string }) { gains.push(gain.gain.value); void dest },
        }
        return gain
      },
      audioWorklet: { addModule: async () => {} },
      destination: { kind: 'destination' },
    }
  }

  const host = globalThis as unknown as Record<string, unknown>
  const undos = [
    stash(host, 'navigator', {
      mediaDevices: {
        getUserMedia: async (constraints: Record<string, unknown>) => {
          asked.push(constraints)
          // `getAudioTracks`, not `getTracks`: the page asks for the audio ones specifically, so
          // a stub that only offers the generic accessor fails for a reason that is not the bug.
          return { getAudioTracks: () => [track({ echoCancellation })], getTracks: () => [] }
        },
      },
    }),
    stash(host, 'AudioContext', context),
    // The tap node is what actually carries frames to the engine, so it has to exist for the
    // graph to be complete. `port` is a bare object because the test never posts through it.
    stash(host, 'AudioWorkletNode', class {
      port = { postMessage() {}, onmessage: null as unknown }
      connect() {}
    }),
  ]
  if (host.Blob === undefined) undos.push(stash(host, 'Blob', class {}))
  if (typeof (host.URL as { createObjectURL?: unknown } | undefined)?.createObjectURL !== 'function') {
    // The page is the only place that has these; Node has enough of `URL` to answer them.
    undos.push(stash(host, 'URL', Object.assign(Object.create(null) as object, {
      createObjectURL: () => 'blob:stub',
      revokeObjectURL: () => {},
    })))
  }

  return {
    asked,
    created,
    gains,
    restore() {
      for (const undo of undos.reverse()) undo()
    },
  }
}

/** An engine whose models are already loaded, so only the microphone half is under test. */
function engine() {
  const wake = new WakeEngine({
    wakeConfig: async () => ({}),
    wakeReport: async () => ({}),
  } as never)
  wake.loaded = true
  return wake
}

describe('opening the microphone for the wake word', () => {
  it('finishes and reports its note rather than throwing on the last line', async () => {
    const stub = browser()
    try {
      const note = await engine().openMicrophone()
      assert.equal(typeof note, 'string',
        'the function did not return the status note it promises in its doc comment')
    } finally {
      stub.restore()
    }
  })

  it('says so when echo cancellation was refused, and still returns a note', async () => {
    // The device took the default capture instead of the requested one. The browser reports that
    // without throwing, so the fact has to be read back off the track — and it has to be a note,
    // because `mute()` is what makes living without it safe.
    const stub = browser({ echoCancellation: false })
    try {
      const note = await engine().openMicrophone()
      assert.match(note, /回声消除不可用/,
        'a refused echoCancellation is not reported anywhere')
    } finally {
      stub.restore()
    }
  })

  it('notes the sample rate it settled for after the device refused 16 kHz', async () => {
    const stub = browser({ sampleRateAccepted: false })
    try {
      const note = await engine().openMicrophone()
      assert.match(note, /采样率/,
        'the resampling fallback is silent, so the status line cannot explain the score')
    } finally {
      stub.restore()
    }
  })

  it('asks for echo cancellation, because that is what keeps the ball from waking itself', async () => {
    const stub = browser()
    try {
      await engine().openMicrophone()
      assert.equal(stub.asked.length, 1)
      // The constraints live under `audio`, so the flag is one level down. Asserting on the top
      // level would read `undefined` and look like the engine had stopped asking.
      const audio = stub.asked[0]?.audio as Record<string, unknown> | undefined
      assert.equal(audio?.echoCancellation, true,
        'the microphone was opened without asking for echo cancellation')
      // The other two are deliberately off: they are tuned for speech quality, and this stream
      // is scored by a classifier rather than transcribed.
      assert.equal(audio?.noiseSuppression, false)
      assert.equal(audio?.autoGainControl, false)
    } finally {
      stub.restore()
    }
  })

  it('leaves the graph silent, so capturing the room does not play it back', async () => {
    const stub = browser()
    try {
      await engine().openMicrophone()
      assert.deepEqual(stub.gains, [0],
        'the worklet sink is not muted')
    } finally {
      stub.restore()
    }
  })

  it('closes the tracks it opened when the graph never reaches running', async () => {
    // A context created without a gesture stays suspended and produces no audio callbacks at
    // all. That has to be an error, and it has to release the microphone on the way out.
    const host = globalThis as unknown as Record<string, unknown>
    let stopped = 0
    // The teardown path reaches for `getTracks` (the generic accessor) while the settings probe
    // above uses `getAudioTracks`, so the stub answers both — one of them being absent would fail
    // this test for a reason that has nothing to do with the microphone being released.
    const undos = [
      stash(host, 'AudioContext', class {
        get state() { return 'suspended' }
        get sampleRate() { return 48000 }
        async resume() {}
        async close() {}
      }),
      stash(host, 'navigator', {
        mediaDevices: {
          getUserMedia: async () => {
            const track = { kind: 'audio', stop: () => { stopped += 1 } }
            return { getAudioTracks: () => [track], getTracks: () => [track] }
          },
        },
      }),
    ]
    try {
      await assert.rejects(() => engine().openMicrophone(), /audio context is suspended/)
      assert.equal(stopped, 1, 'the microphone was left open after a failed start')
    } finally {
      for (const undo of undos.reverse()) undo()
    }
  })
})
