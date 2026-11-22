/**
 * sherpa-onnx keyword spotting, owned by this process.
 *
 * The ball already runs its own engine in the page: openWakeWord's mel -> embedding -> classifier
 * chain, all `onnxruntime-web`, one model per keyword. This module is a *second* engine beside it,
 * never a replacement for it, and the menu picks one at a time.
 *
 * It lives in the main process because sherpa-onnx is a native addon (`assets/sherpa`), not a wasm
 * build: the page cannot load it. Audio is captured in the page — that is the only place with a
 * microphone — and handed here as raw 16 kHz frames over one IPC call per frame.
 *
 * The engine is a transducer decoder over the wenetspeech 3.3M checkpoint: the keyword file is a
 * token sequence per phrase, and the decoder boosts those tokens as it goes, so "did the user say
 * the phrase" is answered by the decoder rather than by a per-word binary classifier. That is the
 * whole reason it was worth adding: the measurement that started this work was `xiaodi` scoring 1.00
 * on the user's own voice while still not firing, because a classifier has to agree with itself
 * across a ring of frames and a decoder does not.
 *
 * Everything here is best effort in the sense the rest of this file means it: a load failure returns
 * a string for the ball to show instead of throwing at a user who only right-clicked a menu.
 *
 * @module wake-sherpa
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

/** Sample rate both the feature extractor and the models were built for. */
const SAMPLE_RATE = 16000
/** Folder inside the helper's own assets holding the three KWS models. */
const KWS_DIRECTORY = 'kws'
/** Folder holding the vendored native addon and its DLLs. */
const SHERPA_DIRECTORY = 'sherpa'
/**
 * Decoder operating point, taken from the measurements rather than guessed.
 *
 * `score` is the boost added to a keyword's next token; `threshold` is the average per-token score a
 * detection must reach. On the user's own 45 s recording these gave 3/3 on the three spoken
 * `小弟小弟` and no trigger on 4 minutes of room speech and filler. The sherpa defaults are the ones
 * that reproduce the python harness exactly — passing `numTrailingBlanks` or `maxActivePaths` at 4
 * silently dropped the middle repetition of the same recording (2 hits instead of 3), so neither is
 * set here.
 */
const KEYWORDS_SCORE = 1.0
const KEYWORDS_THRESHOLD = 0.25

/** The addon's own result object, of which only these fields are read. */
interface KeywordResult {
  readonly keyword?: string
  readonly start_time?: number
  readonly tokens?: readonly string[]
}

/** One stream from the spotter; only `acceptWaveform` is called on it. */
interface KeywordStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void
}

/** The spotter class the vendored addon exports. */
interface KeywordSpotter {
  createStream(): KeywordStream
  isReady(stream: KeywordStream): boolean
  decode(stream: KeywordStream): void
  reset(stream: KeywordStream): void
  getResult(stream: KeywordStream): KeywordResult
}

interface SpotterClass {
  new (config: unknown): KeywordSpotter
}

/** What the caller does with a detection. */
export type KeywordListener = (keyword: string, detail: { score: number; startTime: number }) => void

/**
 * One running spotter, or the reason there is none.
 *
 * `start()` is idempotent and cheap after the first call: the addon and its three sessions are
 * loaded once per process, because loading them costs ~0.4 s and re-reading 12 MB of ONNX on every
 * menu click would be the difference between "the ball listens" and "the ball seems hung".
 */
export class SherpaKws {
  private readonly directory: string
  private readonly onKeyword: KeywordListener
  private spotter: KeywordSpotter | undefined
  private stream: KeywordStream | undefined
  private spotterClass: SpotterClass | undefined
  private loadedFor: string | undefined
  private lastDetail = ''

  /**
   * @param assetDirectory - the helper's own asset folder, which holds `sherpa` and `kws`.
   * @param onKeyword - called once per detection, from inside `feed()`.
   */
  constructor(assetDirectory: string, onKeyword: KeywordListener) {
    this.directory = assetDirectory
    this.onKeyword = onKeyword
  }

  /** Where the model folder is, for the availability check the menu and the page both ask. */
  modelDirectory(): string {
    return join(this.directory, KWS_DIRECTORY)
  }

  /** The keyword file for one stem, whether or not it exists. */
  keywordFile(keyword: string): string {
    return join(this.modelDirectory(), `keywords-${keyword}.txt`)
  }

  /**
   * Load the addon and start listening for one phrase.
   *
   * Reloading for a *different* phrase replaces the stream but not the addon: the keyword file is
   * read by the C++ spotter's constructor, so a new phrase means a new spotter, while the native
   * module itself is the expensive part and stays loaded.
   * @param keyword - the phrase stem, e.g. `xiaodi`.
   * @returns `''` when listening started, else a one-line reason for the page to display.
   */
  start(keyword: string): string {
    if (this.spotter !== undefined && this.loadedFor === keyword) return ''
    this.stop()
    try {
      const spots = this.spotterClass ?? this.loadAddon()
      this.spotterClass = spots
      const spotter = new spots(this.config(keyword))
      this.spotter = spotter
      this.stream = spotter.createStream()
      this.loadedFor = keyword
      this.lastDetail = ''
      return ''
    } catch (error) {
      this.spotter = undefined
      this.stream = undefined
      this.loadedFor = undefined
      this.lastDetail = messageOf(error)
      return this.lastDetail
    }
  }

  /** Stop decoding. The native module stays loaded, so a later `start()` is instant. */
  stop(): void {
    this.spotter = undefined
    this.stream = undefined
    this.loadedFor = undefined
  }

  /** Whether a spotter is currently decoding. */
  running(): boolean {
    return this.spotter !== undefined && this.stream !== undefined
  }

  /** The reason the last `start()` failed, or `''`. */
  detail(): string {
    return this.lastDetail
  }

  /**
   * Hand one frame of audio to the decoder.
   *
   * The frame is 1280 samples at 16 kHz — the same size the page's worklet emits — and the decoder
   * runs as soon as it has a full chunk of 16 fbank frames, so a call usually returns without doing
   * any work. On a detection the stream is reset immediately: a wake should fire once per utterance,
   * and leaving the decoder's matched state in place made a single phrase fire twice in a row.
   * @param samples - 16 kHz mono float samples.
   */
  feed(samples: Float32Array): void {
    const spotter = this.spotter
    const stream = this.stream
    if (spotter === undefined || stream === undefined) return
    try {
      stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
      while (spotter.isReady(stream)) {
        spotter.decode(stream)
        const result = spotter.getResult(stream)
        const keyword = result?.keyword ?? ''
        if (keyword === '') continue
        spotter.reset(stream)
        this.onKeyword(keyword, {
          // The addon reports the matched phrase and where it started in the stream; the score is
          // not exposed by this result type, so the operating point is what stands in for it.
          score: KEYWORDS_THRESHOLD,
          startTime: typeof result.start_time === 'number' ? result.start_time : 0,
        })
        // One detection per frame, then let the next frames start a fresh match.
        break
      }
    } catch (error) {
      const detail = messageOf(error)
      if (detail !== this.lastDetail) {
        this.lastDetail = detail
        console.error(`dsh-orb helper: keyword spotter stopped decoding: ${detail}`)
      }
      this.stop()
    }
  }

  /**
   * Drop the decoder's state without stopping it.
   *
   * The page calls this wherever it drops its own buffers — the moment the ball starts speaking, and
   * the end of an utterance — so the audio of a phrase already heard cannot be matched again from a
   * stale context.
   */
  reset(): void {
    const spotter = this.spotter
    const stream = this.stream
    if (spotter === undefined || stream === undefined) return
    try {
      spotter.reset(stream)
    } catch {
      // A reset that throws is a dead stream; dropping it is the only recovery and costs one start.
      this.stop()
    }
  }

  /** Load the native module once; `require` is dynamic because the path is a runtime asset path. */
  private loadAddon(): SpotterClass {
    const require = createRequire(import.meta.url)
    const entry = join(this.directory, SHERPA_DIRECTORY, 'keyword-spotter.cjs')
    const module = require(entry) as { KeywordSpotter?: SpotterClass }
    const spots = module.KeywordSpotter
    if (spots === undefined) throw new Error(`${entry} exports no KeywordSpotter`)
    return spots
  }

  /**
   * The spotter's configuration object, matching what `kws_test.py` and `kws_sweep.py` measured.
   *
   * Nothing optional is set: see {@link KEYWORDS_SCORE} for why the two knobs that look tunable are
   * deliberately absent.
   */
  private config(keyword: string): unknown {
    const models = this.modelDirectory()
    const base = 'epoch-12-avg-2-chunk-16-left-64'
    return {
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: join(models, `encoder-${base}.onnx`),
          decoder: join(models, `decoder-${base}.onnx`),
          joiner: join(models, `joiner-${base}.onnx`),
        },
        tokens: join(models, 'tokens.txt'),
        numThreads: 1,
        provider: 'cpu',
        debug: 0,
        modelType: 'zipformer2',
      },
      keywordsFile: this.keywordFile(keyword),
      keywordsScore: KEYWORDS_SCORE,
      keywordsThreshold: KEYWORDS_THRESHOLD,
    }
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}
