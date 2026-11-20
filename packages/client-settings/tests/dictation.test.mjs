import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Load the page in a vm and drive the composer's dictation button.
 *
 * The recorder is the one piece of this plugin that cannot be unit-tested by reading a value: it
 * opens a device, decides from the samples it receives whether a sentence started and ended, and
 * hands the result to a host route. Everything below stands in for the browser — the audio context
 * is a stub whose `ScriptProcessorNode` this test drives frame by frame, so "the room was quiet,
 * then somebody spoke, then they stopped" is a scenario rather than a hope.
 */
function loadPage(options = {}) {
  const notes = []
  const posted = []
  const calls = []
  const events = []
  const contexts = []
  const cues = []
  const draft = { value: '' }
  const dictation = {
    silenceMs: 120,
    maxSeconds: 5,
    autoSend: false,
    noSpeechMs: 300,
    ...(options.dictation ?? {}),
  }
  let transcript = options.transcript ?? { text: '你好' }
  let mediaCalls = 0
  // How long the device takes to open. A press that lands inside this window is the one case the
  // recorder cannot see by itself: the button is already red, and there is not a frame yet.
  const mediaDelayMs = options.mediaDelayMs ?? 0
  // How long the limits take to arrive, which is the window between "a turn was asked for" and
  // "the device opens".
  const dictationDelayMs = options.dictationDelayMs ?? 0

  class FakeContext {
    constructor(settings) {
      this.sampleRate = settings && settings.sampleRate ? settings.sampleRate : 48_000
      this.state = 'running'
      this.destination = {}
      this.processor = null
      this.openedAt = Date.now()
      contexts.push(this)
    }
    get currentTime() { return (Date.now() - this.openedAt) / 1000 }
    createMediaStreamSource() { return { connect() {}, disconnect() {} } }
    createScriptProcessor() {
      this.processor = { onaudioprocess: null, connect() {}, disconnect() {} }
      return this.processor
    }
    createGain() { return { gain: new FakeParam(1), connect() {}, disconnect() {} } }
    // Every cue is a handful of sine oscillators through one gain. Recording them is how a test can
    // say what the page sounded like — the cues are the button's only feedback, so "two sounds
    // where there should be one" has to be provable here or not at all.
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: new FakeParam(440),
        began: 0,
        ended: undefined,
        gain: undefined,
        connect(target) { osc.gain = target },
        start(at) { osc.began = at },
        stop(at) { osc.ended = osc.ended === undefined ? at : Math.min(osc.ended, at) },
      }
      cues.push(osc)
      return osc
    }
    async resume() {}
    async close() { this.state = 'closed' }
  }

  class FakeParam {
    constructor(value) {
      this.value = value
      this.history = []
    }
    setValueAtTime(value) { this.value = value; this.history.push(value); return this }
    exponentialRampToValueAtTime(value) { this.value = value; this.history.push(value); return this }
    linearRampToValueAtTime(value) { this.value = value; this.history.push(value); return this }
    cancelScheduledValues() { return this }
    cancelAndHoldAtTime() { return this }
  }

  class FakeTextArea {
    constructor() { this._value = '' }
    get value() { return this._value }
    set value(next) { this._value = next; draft.value = next }
    dispatchEvent(event) {
      events.push(event)
      // A composer that submits on Enter empties its box when the key is pressed; the page reads the
      // box back to know whether a send actually took, so the fake has to behave the same way.
      if (event.type === 'keydown' && event.key === 'Enter') this.value = ''
      return true
    }
    focus() {}
  }

  class FakeEvent {
    constructor(type, init) {
      this.type = type
      this.bubbles = Boolean(init && init.bubbles)
      this.key = init && init.key
    }
  }

  class FakeBlob {
    constructor(parts, settings) {
      this.parts = parts
      this.type = settings && settings.type
    }
  }

  const area = new FakeTextArea()
  const sandbox = {
    window: {},
    document: {
      documentElement: { lang: 'zh-CN' },
      getElementById: () => null,
      head: { append() {} },
      createElement: (tag) => ({ tag, id: '', textContent: '' }),
      querySelector: (selector) => (selector === 'textarea' ? area : null),
      // No buttons anywhere: the fallback send path is the textarea's Enter key, which this test
      // records as an event rather than a submission.
      querySelectorAll: () => [],
    },
    navigator: {
      language: 'zh-CN',
      mediaDevices: {
        async getUserMedia(constraints) {
          mediaCalls += 1
          sandbox.__constraints = constraints
          if (mediaDelayMs > 0) await new Promise((done) => setTimeout(done, mediaDelayMs))
          return { getTracks: () => [{ stop() {} }] }
        },
        async enumerateDevices() { return [] },
      },
    },
    AudioContext: FakeContext,
    Blob: FakeBlob,
    Event: FakeEvent,
    KeyboardEvent: FakeEvent,
    HTMLTextAreaElement: FakeTextArea,
    console,
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (id) => clearTimeout(id),
    fetch: async (path, request = {}) => {
      // The wake hand-off polls this page for as long as it is open. Real timers would keep this
      // process alive after the last test, so the first poll parks on a promise that never
      // settles: the recorder under test needs no wake word, and nothing here waits on the loop.
      if (path === '/.dsh-orb/main-voice') return new Promise(() => {})
      if (path === '/.dsh-orb/client-report') {
        if (request.body) notes.push(JSON.parse(request.body).note)
        return json({ ok: true })
      }
      if (path === '/.dsh-orb/dictation') {
        if (dictationDelayMs > 0) await new Promise((done) => setTimeout(done, dictationDelayMs))
        return json(dictation)
      }
      if (path === '/.dsh-orb/transcribe') {
        posted.push(request.body)
        calls.push({ path, request })
        return json(transcript)
      }
      calls.push({ path, request })
      return { ok: false, status: 404, async text() { return '{}' } }
    },
  }
  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type(props ?? {})
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((child) => child != null) }
    },
    useState(initial) { return [initial, () => {}] },
    useEffect() {},
  }
  let plugin
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      plugin = spec.factory((id) => {
        if (id === 'react') return React
        throw new Error(id)
      })
      return plugin
    },
  }
  runInContext(readFileSync(join(here, '../client.js'), 'utf8'), createContext(sandbox))
  // The page registers slot occupants; this test presses the recorder directly, which is the
  // function the button calls, so the slot scaffolding only has to exist.
  plugin.apply({
    slots: { inject: (_name, register) => register(), register: () => {} },
  })

  return { sandbox, draft, events, posted, notes, dictation, contexts, cues, get mediaCalls() { return mediaCalls } }
}

function json(body) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(body) },
    async json() { return body },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Push one frame of a constant level through the recorder's tap. */
function feed(context, level, frames = 1) {
  const processor = context.processor
  assert.ok(processor !== null, 'the recorder has to have created a processor')
  for (let index = 0; index < frames; index += 1) {
    const data = new Float32Array(1024)
    if (level > 0) data.fill(level)
    processor.onaudioprocess({ inputBuffer: { getChannelData: () => data } })
  }
}

/** Wait until the recorder's processor exists, then push the frames the scenario describes. */
async function speak(page, { quiet = 8, loud = 3, tail = 0 } = {}) {
  const started = Date.now()
  // The cue is played through a context of its own, so "the last context" is not the recorder —
  // the one with a processor is.
  let context
  while (Date.now() - started < 3000) {
    context = page.contexts.find((candidate) => candidate.processor !== null)
    if (context !== undefined) break
    await sleep(5)
  }
  assert.ok(context !== undefined, 'the recorder never opened a processor')
  feed(context, 0.0005, quiet)
  feed(context, 0.08, loud)
  if (tail > 0) await sleep(tail)
}

/**
 * One entry per cue played: the notes it was made of, and the window it was scheduled to sound in.
 *
 * A cue is one gain node with a note or two behind it, so the gain is what tells two cues apart.
 * The end of a window is the last scheduled stop, which is exactly what drops when a cue is cut
 * short — a cue that overlapped nothing and a cue that was silenced both end early, and only the
 * second one ends before its own notes were over.
 */
function cueWindows(page) {
  const windows = new Map()
  for (const osc of page.cues) {
    const window = windows.get(osc.gain) ?? { notes: [], start: Infinity, end: -Infinity }
    window.notes.push(osc.frequency.history[0])
    window.start = Math.min(window.start, osc.began)
    window.end = Math.max(window.end, osc.ended ?? osc.began)
    windows.set(osc.gain, window)
  }
  return [...windows.values()].sort((left, right) => left.start - right.start)
}

/** No cue may start while another is still speaking. 40 ms of crossfade is the fade itself. */
function assertOneAtATime(page) {
  const cues = cueWindows(page)
  for (let index = 1; index < cues.length; index += 1) {
    assert.ok(
      cues[index].start >= cues[index - 1].end - 0.04,
      `cue ${index} (${cues[index].notes}) starts at ${cues[index].start.toFixed(3)}s, `
        + `before the previous one (${cues[index - 1].notes}) is over at ${cues[index - 1].end.toFixed(3)}s`,
    )
  }
  return cues
}

describe('composer dictation button', () => {
  it('records on the ball constraints and types what was recognised', async () => {
    const page = loadPage()
    const turn = page.sandbox.window.__dshOrbBallTurn
    assert.equal(typeof turn, 'function', 'the bridge has to publish its recorder')

    const running = turn()
    await speak(page)
    // The pause is what ends the sentence: no second button press, no DOM row to read.
    const outcome = await running
    assert.equal(outcome, 'draft', `notes: ${page.notes.join(' | ')}`)
    assert.equal(page.mediaCalls, 1)
    // Field by field: the constraint object is built inside the vm, so its prototype belongs to
    // another realm and a strict deep-equal would compare realms rather than values.
    const constraints = page.sandbox.__constraints.audio
    assert.equal(constraints.echoCancellation, true)
    assert.equal(constraints.noiseSuppression, false, 'suppression eats the first quiet syllable')
    assert.equal(constraints.autoGainControl, false, 'gain lifts the floor until a pause looks like speech')
    assert.equal(constraints.video, undefined)
    assert.equal(page.posted.length, 1, 'one recording is one transcription')
    assert.equal(page.posted[0].type, 'audio/wav')
    assert.equal(page.draft.value, '你好')
  })

  it('appends to what is already typed instead of replacing it', async () => {
    const page = loadPage()
    page.draft.value = '先记一件事'
    page.sandbox.document.querySelector('textarea').value = '先记一件事'
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    await running
    assert.equal(page.draft.value, '先记一件事 你好')
  })

  it('sends the sentence when the profile asks for it', async () => {
    const page = loadPage({ dictation: { autoSend: true } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(await running, 'sent')
    // With no send button in this page, the fallback is Enter in the composer.
    assert.ok(page.events.some((event) => event.type === 'keydown'), 'the turn has to be submitted')
  })

  // Sending takes about as long as the "heard" cue rings, so the two used to sound on top of each
  // other — one event, two tones fighting, which is what the user heard as a broken double beep.
  it('says a sent turn once instead of stacking two cues', async () => {
    const page = loadPage({ dictation: { autoSend: true } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(await running, 'sent')
    const cues = assertOneAtATime(page)
    const notes = cues.flatMap((cue) => cue.notes)
    assert.ok(notes.includes(1175), `the sent cue is the sound of a turn that left: ${JSON.stringify(cues)}`)
    assert.ok(!notes.includes(1320), 'the heard cue belongs to words that stay in the box, not to a send')
  })

  it('still says "heard" when the words stay in the box', async () => {
    const page = loadPage()
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(await running, 'draft')
    const notes = assertOneAtATime(page).flatMap((cue) => cue.notes)
    assert.ok(notes.includes(1320), 'a draft is confirmed by the heard cue')
    assert.ok(!notes.includes(1175), 'nothing was sent, so there is no sent cue')
  })

  it('drops a closing phrase instead of typing it', async () => {
    const page = loadPage({ transcript: { text: '先这样吧' } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(await running, 'closing')
    assert.equal(page.draft.value, '')
  })

  it('gives up when nobody speaks, without asking for a transcription', async () => {
    const page = loadPage({ dictation: { noSpeechMs: 150 } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    const context = page.contexts
    const started = Date.now()
    while (context.length === 0 && Date.now() - started < 3000) await sleep(10)
    feed(context[context.length - 1], 0.0004, 4)
    assert.equal(await running, 'empty')
    assert.equal(page.posted.length, 0)
    assert.equal(page.draft.value, '')
  })

  // A turn used to be unstoppable once it started: the only ways out were the pause, the ceiling
  // and the no-speech timer, so a button pressed by mistake stayed red for up to fifteen seconds.
  it('ends the turn on a second press, without waiting for the pause', async () => {
    const page = loadPage({ dictation: { silenceMs: 8000, noSpeechMs: 8000, maxSeconds: 30 } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    const askedAt = Date.now()
    assert.equal(page.sandbox.window.__dshOrbStopListening(), true, 'a listening button can be stopped')
    const outcome = await running
    assert.ok(Date.now() - askedAt < 1500, 'the press ends the turn, not the eight-second pause')
    assert.equal(outcome, 'draft', `notes: ${page.notes.join(' | ')}`)
    assert.equal(page.draft.value, '你好', 'the words that were said before the press still land')
    // Pressing within a few hundred milliseconds of the opening cue is the other way two cues end
    // up on top of each other: the "heard" one lands while the "listen" one is still ringing.
    assertOneAtATime(page)
  })

  it('drops a turn stopped before the first word, and does not transcribe it', async () => {
    const page = loadPage({ dictation: { silenceMs: 8000, noSpeechMs: 8000, maxSeconds: 30 } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page, { loud: 0 })
    assert.equal(page.sandbox.window.__dshOrbStopListening(), true)
    assert.equal(await running, 'empty')
    assert.equal(page.posted.length, 0, 'nothing was said, so there is nothing to send')
  })

  it('does nothing on a press when no turn is open', () => {
    const page = loadPage()
    assert.equal(page.sandbox.window.__dshOrbStopListening(), false, 'a quiet button must not arm a stop')
  })

  // The button turns red before the device is open, so a press inside those few hundred
  // milliseconds is a press on a red button with nothing recorded yet. Opening the device anyway
  // and then immediately closing it costs the user a turn they asked to cancel.
  it('cancels a turn pressed while the device is still opening', async () => {
    const page = loadPage({ mediaDelayMs: 300, dictation: { silenceMs: 8000, noSpeechMs: 8000, maxSeconds: 30 } })
    const running = page.sandbox.window.__dshOrbBallTurn()
    const started = Date.now()
    while (page.sandbox.window.__dshOrbListening() !== true && Date.now() - started < 2000) await sleep(5)
    assert.equal(page.sandbox.window.__dshOrbListening(), true, 'the button is red while the device opens')
    assert.equal(page.sandbox.window.__dshOrbStopListening(), true)
    assert.equal(await running, 'empty')
    assert.equal(page.mediaCalls, 1, 'the device was opened, so it is the abort that ends the turn')
    assert.ok(page.contexts.every((context) => context.processor === null), 'nothing was ever recorded')
    assert.equal(page.posted.length, 0, 'a cancelled turn is not transcribed')
  })

  it('does not carry that press into the next turn', async () => {
    const page = loadPage({ mediaDelayMs: 150 })
    const first = page.sandbox.window.__dshOrbBallTurn()
    const started = Date.now()
    while (page.sandbox.window.__dshOrbListening() !== true && Date.now() - started < 2000) await sleep(5)
    page.sandbox.window.__dshOrbStopListening()
    assert.equal(await first, 'empty')

    const second = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(await second, 'draft', `notes: ${page.notes.join(' | ')}`)
    assert.equal(page.draft.value, '你好', 'the next press records the whole pause again')
  })

  it('says a turn is in progress, so the button cannot open a second one', async () => {
    const page = loadPage()
    const running = page.sandbox.window.__dshOrbBallTurn()
    await speak(page)
    assert.equal(page.sandbox.window.__dshOrbTurnBusy(), true)
    await running
    assert.equal(page.sandbox.window.__dshOrbTurnBusy(), false)
  })

  // Between the press and the first frame there is a turn with no device: the limits are still
  // being read, or the previous reply is still being read out. A press there is still a press on a
  // live turn, and ending it before the microphone opens is the whole point.
  it('calls off a turn that has not reached the device yet', async () => {
    const page = loadPage({ dictationDelayMs: 200 })
    const running = page.sandbox.window.__dshOrbBallTurn()
    await sleep(30)
    assert.equal(page.sandbox.window.__dshOrbTurnBusy(), true)
    assert.equal(page.sandbox.window.__dshOrbListening(), false, 'the device is not open yet')
    assert.equal(page.sandbox.window.__dshOrbStopListening(), true, 'a turn is open, even without a device')
    assert.equal(await running, 'empty')
    assert.equal(page.mediaCalls, 0, 'the microphone never opens for a turn that was called off')
    assert.equal(page.posted.length, 0)
  })
})
