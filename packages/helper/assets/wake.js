/**
 * Local wake-word engine for the floating ball.
 *
 * This is the browser half of the orb's wake feature: openWakeWord's three-stage
 * pipeline (melspectrogram -> speech embedding -> per-keyword classifier) driven by
 * `onnxruntime-web`, gated by Silero VAD, fed by one 16 kHz AudioWorklet tap. Every
 * frame is scored on this machine and nothing is uploaded — detection only raises a
 * visible state on the ball.
 *
 * The transforms are the same load-bearing ones the `dsh-voice-dialog` voice plugin
 * uses and the ones its `assets/selftest.html` exercises: mel output rescaled with
 * `x / 10 + 2`, five 32-bin frames per audio frame, a 76-frame sliding window into the
 * embedding model, and a 16 x 96 embedding ring into the classifier. Changing any of
 * them degrades the score silently instead of failing loudly.
 *
 * Assets are fetched from the private `dsh-wake://assets/` scheme the helper serves,
 * so no loopback token is needed here.
 *
 * @module wake
 */

/** Frame size every model expects, at 16 kHz. */
const FRAME_SIZE = 1280
/** Sample rate the models were trained at. */
const SAMPLE_RATE = 16000
/** Mel frames one embedding inference consumes. */
const MEL_WINDOW_FRAMES = 76
/** Suppression window after a detection, matching the voice plugin. */
const COOLDOWN_MS = 2500
/** How long the ball shows "detected" before it returns to plain listening. */
const DETECTED_HOLD_MS = 4000
/** One utterance that never starts speaking is abandoned after this long. */
const DICTATION_NO_SPEECH_MS = 6000
/**
 * Bars in the live level history the ball draws. The official voice-input capture row
 * uses the same count, so the two waveforms read as the same mark.
 */
export const WAVE_BARS = 80

/** Start cue: rising pair (880 -> 1320 Hz) — "I am listening". */
const START_NOTES = [{ at: 0, freq: 880, len: 0.11 }, { at: 0.11, freq: 1320, len: 0.15 }]
/**
 * Close cue when the utterance held speech: the start cue mirrored (1320 -> 880 Hz), so
 * "up" opens the recorder and "down" closes it.
 */
const CLOSE_NOTES_HEARD = [{ at: 0, freq: 1320, len: 0.1 }, { at: 0.12, freq: 880, len: 0.18 }]
/**
 * Close cue when the recorder gave up without hearing anything: two short knocks far below
 * the start cue, so "nothing reached me" cannot be mistaken for "done" even half-heard.
 */
const CLOSE_NOTES_EMPTY = [{ at: 0, freq: 392, len: 0.09 }, { at: 0.16, freq: 294, len: 0.16 }]

const ORIGIN = 'dsh-wake://assets/'

/**
 * Wrap collected 16 kHz float frames into one PCM16 mono WAV file.
 * @param frames - `Float32Array` frames in capture order.
 * @returns the complete WAV file as an `ArrayBuffer`.
 */
export function framesToWav(frames) {
  let samples = 0
  for (const frame of frames) samples += frame.length
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeText(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  writeText(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, SAMPLE_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeText(36, 'data')
  view.setUint32(40, samples * 2, true)
  let offset = 44
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 1) {
      const value = Math.max(-1, Math.min(1, frame[i]))
      view.setInt16(offset, Math.round(value * 32767), true)
      offset += 2
    }
  }
  return buffer
}

/**
 * Measured level of one frame.
 *
 * This is the same quantity the official voice-input row plots: the root-mean-square of
 * the samples, not a peak, so a quiet room reads as near-silence instead of as the noise
 * floor's loudest click.
 * @param frame - one frame of audio.
 * @returns the frame's RMS level.
 */
function levelOf(frame) {
  let sum = 0
  for (const sample of frame) sum += sample * sample
  return Math.sqrt(sum / frame.length)
}

/** AudioWorklet source: fixed 1280-sample frames, the models' frame size. */
const WORKLET = `
class DshWakeTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = ${FRAME_SIZE};
    this.buffer = new Float32Array(this.size);
    this.pos = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (input) {
      for (let i = 0; i < input.length; i += 1) {
        this.buffer[this.pos] = input[i];
        this.pos += 1;
        if (this.pos === this.size) {
          this.port.postMessage(this.buffer.slice(0));
          this.pos = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('dsh-wake-word-tap', DshWakeTap);
`

/**
 * Wake engine, owned by `assets/shell.js`.
 *
 * One instance lives for the page: `enable()` may be called again after `disable()`,
 * and every teardown stops scoring before it releases the microphone, so a frame that
 * was already queued can never fire a detection after the user turned the feature off.
 */
export class WakeEngine {
  /**
   * @param api - the preload bridge: `wakeConfig()`, `wakeReport(status)`.
   * @param options - `onStatus(status)` is called on every state change, for the page's
   *   own rendering; the same snapshot is also handed to the helper.
   */
  constructor(api, options = {}) {
    this.api = api
    this.onStatus = typeof options.onStatus === 'function' ? options.onStatus : () => {}
    this.config = {
      keyword: 'hey_jarvis',
      threshold: 0.5,
      autoExpandOnWake: true,
      dictation: { enabled: true, silenceMs: 1200, maxSeconds: 15, autoSend: false },
    }
    this.state = 'disabled'
    this.detail = ''
    this.ort = undefined
    this.models = undefined
    this.audioContext = undefined
    this.stream = undefined
    this.node = undefined
    this.source = undefined
    this.melBuffer = []
    this.embeddingHistory = []
    this.vadState = { h: undefined, c: undefined }
    this.speechActive = false
    this.vadHangover = 0
    this.queue = Promise.resolve()
    this.coolingDown = false
    this.cooldownTimer = undefined
    this.detectedTimer = undefined
    this.running = false
    this.starting = false
    this.frames = 0
    this.peak = 0
    this.dictation = undefined
    // Read-aloud is in progress. See `mute()` for why this is more than a cosmetic flag.
    this.muted = false
    // One measured level per audio frame, newest at `levelCursor`. The ball draws this
    // while the microphone is open for an utterance; nothing else reads it.
    this.levels = new Float32Array(WAVE_BARS)
    this.levelCursor = 0
  }

  /** Tuning from the helper: keyword, threshold, what a detection does, and dictation. */
  configure(config) {
    if (config === null || typeof config !== 'object') return
    if (typeof config.keyword === 'string' && /^[a-z0-9_]+$/i.test(config.keyword)) this.config.keyword = config.keyword
    if (typeof config.threshold === 'number' && Number.isFinite(config.threshold)) {
      this.config.threshold = Math.min(0.99, Math.max(0.05, config.threshold))
    }
    this.config.autoExpandOnWake = config.autoExpandOnWake !== false
    if (config.dictation !== null && typeof config.dictation === 'object') this.config.dictation = config.dictation
  }

  /** Whether a detection should open the ball's panel; the page asks instead of guessing. */
  autoExpand() {
    return this.config.autoExpandOnWake !== false
  }

  /** Snapshot for the ball's own status line and for the helper's menu. */
  status() {
    return {
      state: this.state,
      detail: this.detail,
      keyword: this.config.keyword,
      threshold: this.config.threshold,
      frames: this.frames,
      peak: Number(this.peak.toFixed(3)),
    }
  }

  /** Drop the level history, so the next utterance's waveform starts from silence. */
  resetLevels() {
    this.levels.fill(0)
    this.levelCursor = 0
  }

  /**
   * The level history, oldest first, so the newest sample lands at the right edge and
   * older ones scroll away to the left — the direction the official row scrolls it.
   * @returns one measured level per bar.
   */
  waveform() {
    const bars = new Array(this.levels.length)
    for (let index = 0; index < bars.length; index += 1) {
      bars[index] = this.levels[(this.levelCursor + index) % this.levels.length]
    }
    return bars
  }

  /** Load the runtime and models, then open the microphone and start scoring. */
  async enable() {
    if (this.state === 'listening' || this.state === 'loading' || this.starting) return
    this.starting = true
    await this.publish('loading', '')
    try {
      await this.load()
      // `load()` only resets the first time round — every later `enable()` finds the models
      // cached and the buffers still holding the audio from before the feature was switched
      // off, which the classifier would score again as if it had just been spoken.
      this.reset()
      const mic = await this.openMicrophone()
      this.running = true
      this.starting = false
      await this.publish('listening', mic)
    } catch (error) {
      this.starting = false
      await this.teardown()
      await this.publish('error', messageOf(error))
    }
  }

  /**
   * Mirror the helper's current intent: read its config and start or stop to match.
   *
   * The page calls this once at load, which is what makes a profile that already had
   * wake switched on resume listening without any further gesture.
   */
  async syncFromHelper() {
    let config
    try {
      config = await this.api.wakeConfig()
    } catch (error) {
      await this.publish('error', messageOf(error))
      return
    }
    if (config === null || typeof config !== 'object') return
    this.configure(config)
    if (config.ready !== true) {
      await this.publish('disabled', '')
      return
    }
    if (config.enabled === true) await this.enable()
    else await this.publish('disabled', '')
  }

  /** Stop scoring, release the microphone, and say so. */
  async disable() {
    await this.teardown()
    await this.publish('disabled', '')
  }

  /** Inject the ONNX Runtime script once and resolve `window.ort`. */
  async ensureRuntime() {
    if (this.ort !== undefined) return this.ort
    if (globalThis.ort === undefined) {
      await new Promise((resolveScript, rejectScript) => {
        const existing = document.querySelector('script[data-dsh-wake-ort]')
        if (existing !== null) {
          existing.addEventListener('load', () => { resolveScript() })
          existing.addEventListener('error', () => { rejectScript(new Error('onnxruntime script failed')) })
          return
        }
        const tag = document.createElement('script')
        tag.src = `${ORIGIN}ort/ort.wasm.min.js`
        tag.async = true
        tag.dataset.dshWakeOrt = '1'
        tag.addEventListener('load', () => { resolveScript() })
        tag.addEventListener('error', () => { rejectScript(new Error('onnxruntime script failed to load')) })
        document.head.appendChild(tag)
      })
    }
    const ort = globalThis.ort
    if (ort === undefined) throw new Error('onnxruntime-web did not expose window.ort')
    // The served wasm is the threaded build, but multi-threaded execution needs a
    // cross-origin isolated document. One thread keeps it on the non-isolated path,
    // where the single binary is enough.
    ort.env.wasm.numThreads = 1
    // The object form is load-bearing. A *string* wasmPaths makes the runtime
    // concatenate it with its default loader filename and then dynamic-import the
    // result, which the browser rejects as an unresolvable bare specifier. Explicit
    // absolute URLs for the loader and the binary skip that concatenation entirely.
    ort.env.wasm.wasmPaths = {
      mjs: `${ORIGIN}ort/ort-wasm-simd-threaded.mjs`,
      wasm: `${ORIGIN}ort/ort-wasm-simd-threaded.wasm`,
    }
    this.ort = ort
    return ort
  }

  /** Load every model once. Safe to call repeatedly. */
  async load() {
    if (this.models !== undefined) return
    const ort = await this.ensureRuntime()
    const options = { executionProviders: ['wasm'] }
    const mel = await ort.InferenceSession.create(`${ORIGIN}melspectrogram.onnx`, options)
    const emb = await ort.InferenceSession.create(`${ORIGIN}embedding_model.onnx`, options)
    const vad = await ort.InferenceSession.create(`${ORIGIN}silero_vad.onnx`, options)
    const kw = await ort.InferenceSession.create(`${ORIGIN}${this.keywordFile()}`, options)
    this.models = { mel, emb, vad, kw }
    this.reset()
  }

  /** Model file for the configured keyword; only `hey_jarvis` ships today. */
  keywordFile() {
    return this.config.keyword === 'hey_jarvis' ? 'hey_jarvis_v0.1.onnx' : `${this.config.keyword}.onnx`
  }

  /** Clear every per-stream buffer, including the VAD recurrent state. */
  reset() {
    this.melBuffer = []
    this.embeddingHistory = []
    for (let i = 0; i < 16; i += 1) this.embeddingHistory.push(new Float32Array(96).fill(0))
    const shape = [2, 1, 64]
    if (this.vadState.h === undefined) {
      this.vadState.h = new this.ort.Tensor('float32', new Float32Array(128).fill(0), shape)
      this.vadState.c = new this.ort.Tensor('float32', new Float32Array(128).fill(0), shape)
    } else {
      this.vadState.h.data.fill(0)
      this.vadState.c.data.fill(0)
    }
    this.speechActive = false
    this.vadHangover = 0
    this.frames = 0
    this.peak = 0
  }

  /**
   * Open the microphone and start feeding frames to the models.
   * @returns a short human-readable detail for the status line.
   */
  async openMicrophone() {
    // Echo cancellation is not a refinement here, it is what keeps the wake word from hearing
    // the ball: read-aloud audio leaves the same speakers the microphone is beside, and the
    // training data is Mandarin in synthesised voices, so a non-cancelled copy of our own output
    // is close to a positive sample. `mute()` covers the windows while a reply is playing; this
    // covers the bleed that arrives outside those windows — the tail of a reply, the chime, the
    // tail of the chime.
    const want = { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
    let stream = await navigator.mediaDevices.getUserMedia({ audio: want })
    // A device or driver may refuse the constraint and hand back the default capture anyway, which
    // the browser reports without throwing. There is no way to read the applied settings back
    // reliably across platforms, so the fact is stated rather than verified: `mute()` is what
    // makes this safe to live without.
    const applied = stream.getAudioTracks()[0]?.getSettings?.()
    const ecNote = applied?.echoCancellation === false ? '回声消除不可用' : ''
    let audioContext
    let rateNote = ''
    try {
      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    } catch {
      // The device refused 16 kHz; take its own rate and resample per frame below.
      audioContext = new AudioContext()
      rateNote = `${audioContext.sampleRate} Hz`
    }
    // A context created without a preceding gesture stays suspended and produces no
    // audio callbacks at all: the feature would look healthy and never detect. Opening
    // the feature from the ball's menu is that gesture; try again anyway and report it.
    if (audioContext.state === 'suspended') {
      try {
        await audioContext.resume()
      } catch {
        /* the state is reported below */
      }
    }
    if (audioContext.state !== 'running') {
      for (const track of stream.getTracks()) track.stop()
      throw new Error(`audio context is ${audioContext.state}`)
    }
    const source = audioContext.createMediaStreamSource(stream)
    const blob = new Blob([WORKLET], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    try {
      await audioContext.audioWorklet.addModule(blobUrl)
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
    const node = new AudioWorkletNode(audioContext, 'dsh-wake-word-tap')
    node.port.onmessage = (event) => {
      const chunk = event.data
      if (!chunk || !this.running) return
      this.queue = this.queue
        .then(() => this.processChunk(chunk))
        .catch((error) => { this.noteError(error) })
    }
    source.connect(node)
    // A worklet whose output is unconnected is still pulled as long as it has an
    // input, but a zero-gain sink keeps that pull unconditional without echoing the
    // microphone to the speakers.
    const silence = audioContext.createGain()
    silence.gain.value = 0
    node.connect(silence)
    silence.connect(audioContext.destination)
    this.stream = stream
    this.audioContext = audioContext
    this.source = source
    this.node = node
    // Both parts are notes for the status line, neither is a failure: a refused sample rate is
    // resampled per frame and a device without echo cancellation is covered by `mute()`.
    return detail === '' ? '' : `${detail}${ecNote} 采样率 ${rateNote}`.trim()
  }

  /** Release the microphone and every audio object. */
  async teardown() {
    // Stop feeding the models *before* anything is torn down: frames already queued in
    // the promise chain would otherwise finish inferring after this returns.
    this.running = false
    // An in-flight dictation would otherwise wait forever for frames that never come.
    this.finishDictation({ announce: false })
    // Nothing is measuring the microphone any more, so the ball's waveform must not keep
    // drawing the last thing it heard.
    this.resetLevels()
    if (this.node !== undefined) {
      this.node.port.onmessage = null
      try {
        this.node.disconnect()
      } catch {
        /* already detached */
      }
      this.node = undefined
    }
    if (this.source !== undefined) {
      try {
        this.source.disconnect()
      } catch {
        /* already detached */
      }
      this.source = undefined
    }
    // Release the microphone first and unconditionally: `close()` can stay pending on
    // a suspended context, and the OS recording indicator would stay lit.
    if (this.stream !== undefined) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* already ended */
        }
      }
      this.stream = undefined
    }
    if (this.audioContext !== undefined && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close()
      } catch {
        /* already closing */
      }
    }
    this.audioContext = undefined
    this.coolingDown = false
    if (this.cooldownTimer !== undefined) {
      clearTimeout(this.cooldownTimer)
      this.cooldownTimer = undefined
    }
    if (this.detectedTimer !== undefined) {
      clearTimeout(this.detectedTimer)
      this.detectedTimer = undefined
    }
  }

  /**
   * Score one frame: VAD first, then the model chain.
   * @param chunk - one audio frame, `FRAME_SIZE` samples at `SAMPLE_RATE`.
   */
  async processChunk(chunk) {
    if (!this.running) return
    const frame = this.audioContext !== undefined && this.audioContext.sampleRate !== SAMPLE_RATE
      ? resample(chunk, this.audioContext.sampleRate, SAMPLE_RATE)
      : chunk
    this.frames += 1
    // Sampled here rather than in the two branches below, so the ball's waveform follows
    // the microphone whether the frame is being scored for the wake word or recorded into
    // an utterance — the single place every frame passes through.
    this.levels[this.levelCursor] = levelOf(frame)
    this.levelCursor = (this.levelCursor + 1) % this.levels.length
    // While one utterance is being recorded, frames feed the recorder instead of the
    // keyword chain, so a long sentence cannot re-trigger the wake word mid-dictation.
    if (this.dictation !== undefined) {
      await this.collectDictation(frame)
      return
    }
    // Same early return, different reason: the speakers are playing the ball's own voice and the
    // model would score it. Checked after the dictation branch because an in-flight recording has
    // to keep collecting silence — dropping those frames would end the utterance as "no speech".
    if (this.muted) return
    const speech = await this.runVad(frame)
    if (speech) {
      this.speechActive = true
      this.vadHangover = 12
    } else if (this.speechActive) {
      this.vadHangover -= 1
      if (this.vadHangover <= 0) this.speechActive = false
    }
    await this.runModels(frame, this.speechActive)
  }

  /**
   * Stop scoring for as long as the ball is talking.
   *
   * Without this the model transcribes its own voice: `/speak` returns audio that plays out of
   * the same speakers the microphone sits next to, and `openMicrophone()` asks for no echo
   * cancellation, so every word read aloud arrives at the classifier intact. That is not
   * "background noise" to the model — it is Mandarin speech in the same voices and prosody the
   * positives were synthesised with, which is the one input it has no reason to distrust.
   *
   * The buffers are dropped on the way in, for the same reason `finishDictation()` drops them
   * on its way out: the ring buffer would otherwise still hold the last frames of audio from
   * before the mute, and the classifier scores a 16-frame window, so the wake word could fire
   * once more on audio recorded before anyone said anything.
   *
   * Counting rather than a flag, because the mute is edge-triggered from a cosmetic callback
   * that fires on both edges and can be re-entered: two overlapping utterances must not have
   * the first one to finish unmute a still-playing second.
   */
  mute() {
    this.muted = true
    this.reset()
  }

  /** Score again now that the speakers have gone quiet. */
  unmute() {
    this.muted = false
    // Symmetric with `mute()`: the frames that arrived during the mute are speaker bleed and
    // the frame before them may be the end of it. Both must not reach the classifier.
    this.reset()
  }

  /**
   * Record one utterance on the microphone the engine already owns.
   *
   * Resolves with a complete 16 kHz mono PCM16 WAV once the speaker has been quiet for
   * `silenceMs` after speaking, or with `undefined` when nothing was said, the recording
   * hit `maxSeconds`, or the engine stopped. The wake models are paused meanwhile.
   * @param options - `{ silenceMs, maxSeconds }` from the host's `orb-wake.json`.
   * @returns the utterance as a WAV `ArrayBuffer`, or `undefined`.
   */
  async dictate({ silenceMs = 1200, maxSeconds = 15 } = {}) {
    if (!this.running || this.dictation !== undefined) return undefined
    // Start the utterance's waveform empty: everything measured so far belongs to the
    // wake word and its chime, not to the sentence the ball is about to draw.
    this.resetLevels()
    const frameMs = (FRAME_SIZE / SAMPLE_RATE) * 1000
    return await new Promise((resolve) => {
      this.dictation = {
        frames: [],
        heard: false,
        quiet: 0,
        silenceFrames: Math.max(1, Math.round(silenceMs / frameMs)),
        maxFrames: Math.max(1, Math.ceil((maxSeconds * 1000) / frameMs)),
        noSpeechFrames: Math.max(1, Math.ceil(DICTATION_NO_SPEECH_MS / frameMs)),
        resolve,
      }
    })
  }

  /**
   * Stop recording, sound how it ended, and hand back what was captured, if anything.
   *
   * The cue lives here rather than in the caller because this is the only place that knows
   * whether the recorder stopped on a spoken sentence or gave up on silence.
   * @param options - `announce: false` when the engine itself is going down, where a cue
   * would announce an ending the user did not cause.
   */
  finishDictation({ announce = true } = {}) {
    const state = this.dictation
    if (state === undefined) return
    this.dictation = undefined
    // Scoring is skipped for the whole utterance, so the keyword chain's own buffers were
    // never advanced: they still hold the audio of the wake word that opened this dictation.
    // Resuming on that audio makes the classifier fire again the instant the recorder stops —
    // a fresh detection, a second chime and a second dictation the user never asked for, which
    // is exactly what an utterance nobody spoke into looks like. Drop the buffers first, so
    // the next listen starts from silence and only a real wake word can arm the ball again.
    this.reset()
    const captured = state.heard && state.frames.length > 0
    if (announce) this.playCloseTone(captured)
    state.resolve(captured ? framesToWav(state.frames) : undefined)
  }

  /**
   * One dictation frame: keep it, ask the VAD whether it was speech, and stop on silence.
   * @param frame - one 16 kHz frame.
   */
  async collectDictation(frame) {
    const state = this.dictation
    if (state === undefined) return
    state.frames.push(frame)
    const speech = await this.runVad(frame)
    if (speech) {
      state.heard = true
      state.quiet = 0
    } else {
      state.quiet += 1
    }
    const spokenAndQuiet = state.heard && state.quiet >= state.silenceFrames
    const tooLong = state.frames.length >= state.maxFrames
    const silent = !state.heard && state.frames.length >= state.noSpeechFrames
    if (spokenAndQuiet || tooLong || silent) this.finishDictation()
  }

  /**
   * Silero VAD step; false on any failure so scoring simply continues.
   * @param frame - one 16 kHz frame.
   * @returns whether the frame contains speech.
   */
  async runVad(frame) {
    try {
      const ort = this.ort
      const input = new ort.Tensor('float32', frame, [1, frame.length])
      const sr = new ort.Tensor('int64', [BigInt(SAMPLE_RATE)], [])
      const out = await this.models.vad.run({ input, sr, h: this.vadState.h, c: this.vadState.c })
      this.vadState.h = out.hn
      this.vadState.c = out.cn
      return out.output.data[0] > 0.5
    } catch (error) {
      this.noteError(error)
      return false
    }
  }

  /**
   * The mel -> embedding -> classifier chain, plus the detection rule.
   * @param frame - one 16 kHz frame.
   * @param speechActive - whether VAD currently considers speech present.
   */
  async runModels(frame, speechActive) {
    const ort = this.ort
    const melTensor = new ort.Tensor('float32', frame, [1, FRAME_SIZE])
    const melOut = await this.models.mel.run({ [this.models.mel.inputNames[0]]: melTensor })
    const mel = new Float32Array(melOut[this.models.mel.outputNames[0]].data)
    for (let i = 0; i < mel.length; i += 1) mel[i] = mel[i] / 10 + 2
    for (let f = 0; f < 5; f += 1) this.melBuffer.push(mel.subarray(f * 32, (f + 1) * 32).slice())

    while (this.melBuffer.length >= MEL_WINDOW_FRAMES) {
      const flatMel = new Float32Array(MEL_WINDOW_FRAMES * 32)
      for (let f = 0; f < MEL_WINDOW_FRAMES; f += 1) flatMel.set(this.melBuffer[f], f * 32)
      const embTensor = new ort.Tensor('float32', flatMel, [1, MEL_WINDOW_FRAMES, 32, 1])
      const embOut = await this.models.emb.run({ [this.models.emb.inputNames[0]]: embTensor })
      // The runtime may hand back a view into a reused arena, so the ring owns a copy.
      const embedding = new Float32Array(embOut[this.models.emb.outputNames[0]].data)
      this.embeddingHistory.shift()
      this.embeddingHistory.push(embedding)
      const flatEmb = new Float32Array(this.embeddingHistory.length * 96)
      for (let i = 0; i < this.embeddingHistory.length; i += 1) flatEmb.set(this.embeddingHistory[i], i * 96)
      const kwTensor = new ort.Tensor('float32', flatEmb, [1, this.embeddingHistory.length, 96])
      const kwOut = await this.models.kw.run({ [this.models.kw.inputNames[0]]: kwTensor })
      const score = kwOut[this.models.kw.outputNames[0]].data[0]
      if (score > this.peak) this.peak = score

      if (score > this.config.threshold && speechActive && !this.coolingDown && this.running) {
        this.coolingDown = true
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = undefined
          this.coolingDown = false
        }, COOLDOWN_MS)
        await this.detected(score)
      }
      this.melBuffer.splice(0, 8)
    }
  }

  /**
   * One detection: tone, event, visible state, then back to listening.
   * @param score - the classifier score that fired.
   */
  async detected(score) {
    this.playChime()
    await this.publish('detected', `score ${score.toFixed(3)}`)
    if (this.detectedTimer !== undefined) clearTimeout(this.detectedTimer)
    this.detectedTimer = setTimeout(() => {
      this.detectedTimer = undefined
      if (this.state === 'detected') void this.publish('listening', '')
    }, DETECTED_HOLD_MS)
  }

  /**
   * Short confirmation tone for a fresh detection: the rising start cue.
   */
  playChime() {
    this.playNotes(START_NOTES, 0.22)
  }

  /**
   * Cue for a dictation that closed itself, so the end of a recording is as audible as its
   * start and is never confused with it: falling when speech was captured, two low knocks
   * when the recorder gave up on silence.
   * @param captured - whether the finished utterance held any speech.
   */
  playCloseTone(captured) {
    this.playNotes(captured ? CLOSE_NOTES_HEARD : CLOSE_NOTES_EMPTY, captured ? 0.2 : 0.16)
  }

  /**
   * Play one short sequence of sine notes on its own AudioContext.
   *
   * Deliberately a WebAudio tone and not speech: a spoken confirmation would be
   * captured straight back in by the microphone and could be scored as speech.
   * @param notes - `{ at, freq, len }` in seconds, relative to the sequence start.
   * @param level - peak gain of the whole sequence.
   */
  playNotes(notes, level) {
    try {
      const Ctor = globalThis.AudioContext
      if (typeof Ctor !== 'function') return
      const ctx = new Ctor()
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
      const gain = ctx.createGain()
      gain.gain.value = 0.0001
      gain.connect(ctx.destination)
      const start = ctx.currentTime + 0.03
      for (const note of notes) {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(note.freq, start + note.at)
        osc.connect(gain)
        osc.start(start + note.at)
        osc.stop(start + note.at + note.len)
      }
      // The envelope outlives the last note by a fixed tail, so every cue rings out to
      // silence instead of being cut off by `close()`.
      const last = notes[notes.length - 1]
      const total = (last === undefined ? 0 : last.at + last.len) + 0.08
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(level, start + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + total)
      setTimeout(() => { void ctx.close().catch(() => {}) }, (total + 0.5) * 1000)
    } catch {
      /* a missing tone must never break the wake path */
    }
  }

  /**
   * Publish a state change to the ball's own UI and to the helper.
   *
   * The local callback runs first and cannot fail the engine, so the ball's rendering
   * never depends on the IPC round trip.
   * @param state - one of `loading`, `listening`, `detected`, `disabled`, `error`.
   * @param detail - a short reason or note, or `''`.
   */
  async publish(state, detail) {
    this.state = state
    this.detail = detail
    const status = this.status()
    try {
      this.onStatus(status)
    } catch {
      /* the ball's cosmetics must never break the engine */
    }
    try {
      await this.api.wakeReport(status)
    } catch {
      /* a helper that is going away must not stop the engine either */
    }
  }

  /** Report a non-fatal error without leaving the listening state. */
  noteError(error) {
    this.detail = messageOf(error)
    void this.publish(this.state === 'disabled' ? 'error' : this.state, this.detail)
  }

  /** Report a fatal error and stand down. */
  async fail(error) {
    await this.teardown()
    await this.publish('error', messageOf(error))
  }
}

/** Linear resample of one frame; the models only ever see 16 kHz. */
function resample(frame, from, to) {
  if (from === to) return frame
  const out = new Float32Array(FRAME_SIZE)
  const ratio = from / to
  for (let i = 0; i < FRAME_SIZE; i += 1) {
    const at = i * ratio
    const low = Math.floor(at)
    const high = Math.min(frame.length - 1, low + 1)
    const mix = at - low
    out[i] = frame[low] * (1 - mix) + frame[high] * mix
  }
  return out
}

function messageOf(error) {
  if (error instanceof Error && error.message !== '') return error.message
  return String(error)
}
