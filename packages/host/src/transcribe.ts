/**
 * Speech-to-text bridge for the floating ball.
 *
 * The ball records one utterance locally and hands the Host a 16 kHz mono PCM16 WAV; this
 * module forwards it to the Harness's own speech service (`ctx.speechToText`, served by the
 * profile's voice-input bundle and its local SenseVoice provider). Audio never leaves the
 * machine, and the orb plugin only needs the service when a transcript is actually asked for,
 * so a profile without voice input still loads the ball.
 *
 * @module transcribe
 */

/** One transcription attempt: text on success, a short Chinese reason on failure. */
export type TranscriptionResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: string }

/** What the host context has to offer; only `get` is used so the service stays optional. */
export interface TranscribeContext {
  get(name: string): unknown
}

/** The subset of the speech service the ball uses. */
interface SpeechService {
  snapshot?(): unknown
  prepare?(providerId: string, options?: unknown): unknown
  resolve?(request: { audio: Buffer; providerId?: string; language?: string }): unknown
  transcribe?(spec: unknown, signal: AbortSignal): Promise<unknown>
}

/** Longest single utterance the service accepts by default. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024
/**
 * How long an *actively preparing* provider may block one utterance. Loading the verified
 * int8 SenseVoice weights takes a couple of seconds on this machine; anything approaching
 * this cap is a real problem, and the transcription that follows reports it.
 */
const READY_TIMEOUT_MS = 20_000
const READY_POLL_MS = 250

/**
 * Wrap the Harness speech service.
 * @param ctx - host context used to look the service up lazily.
 * @returns an object with one `transcribe` method that never throws.
 */
export function createTranscriber(ctx: TranscribeContext): {
  transcribe(audio: Buffer, language?: string, signal?: AbortSignal): Promise<TranscriptionResult>
} {
  let providerId: string | undefined
  let prepared = false

  function service(): SpeechService | undefined {
    const found = ctx.get('speechToText')
    if (typeof found !== 'object' || found === null) return undefined
    const candidate = found as SpeechService
    return typeof candidate.transcribe === 'function' ? candidate : undefined
  }

  /** Provider id from the readiness snapshot, or `undefined` when the shape is unfamiliar. */
  function pickProvider(speech: SpeechService): string | undefined {
    if (providerId !== undefined) return providerId
    let snapshot: unknown
    try {
      snapshot = speech.snapshot?.()
    } catch {
      snapshot = undefined
    }
    const value = snapshot as { default?: unknown; providers?: unknown } | undefined
    const fromDefault = value?.default
    if (typeof fromDefault === 'string') providerId = fromDefault
    else if (typeof (fromDefault as { id?: unknown } | undefined)?.id === 'string') {
      providerId = (fromDefault as { id: string }).id
    } else if (Array.isArray(value?.providers)) {
      const first = value.providers.find((item) => typeof (item as { id?: unknown })?.id === 'string')
      if (first !== undefined) providerId = (first as { id: string }).id
    }
    return providerId
  }

  /**
   * Wait for the provider to report ready after a cold `prepare`.
   *
   * A verified cache reports `ready`, and `standby` means the resources are on disk and the
   * first recording wakes the worker (the SenseVoice provider's documented behaviour), so both
   * end the wait immediately. Only an actively working preparation is worth waiting for, and a
   * worker that never gets there returns `false` instead of blocking the utterance: the
   * transcription call right after this reports the real failure to the user.
   */
  async function waitReady(speech: SpeechService, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      if (signal.aborted) return false
      let snapshot: unknown
      try {
        snapshot = speech.snapshot?.()
      } catch {
        return true
      }
      const providers = (snapshot as { providers?: unknown } | undefined)?.providers
      if (!Array.isArray(providers) || providers.length === 0) return true
      const match = providers.find((item) => {
        const id = (item as { id?: unknown })?.id
        return providerId === undefined ? true : id === providerId
      })
      if (match === undefined) return true
      const phase = (match as { preparation?: { phase?: unknown } } | undefined)?.preparation?.phase
      if (phase === undefined || phase === 'ready' || phase === 'standby') return true
      if (phase === 'failed' || phase === 'cancelled' || phase === 'unprepared') return false
      if (Date.now() >= deadline) return false
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
    }
  }

  /** Turn whatever the provider returns into plain text. */
  function readText(result: unknown): string {
    if (typeof result === 'string') return result.trim()
    const record = result as { text?: unknown; transcript?: unknown } | undefined
    if (typeof record?.text === 'string') return record.text.trim()
    if (typeof record?.transcript === 'string') return record.transcript.trim()
    return ''
  }

  return {
    async transcribe(audio, language, signal = new AbortController().signal) {
      const speech = service()
      if (speech === undefined) return { ok: false, reason: '宿主里没有语音转文字服务' }
      if (audio.length === 0) return { ok: false, reason: '没有录到声音' }
      if (audio.length > MAX_AUDIO_BYTES) return { ok: false, reason: '录音太长' }
      const id = pickProvider(speech)
      try {
        if (!prepared && id !== undefined && typeof speech.prepare === 'function') {
          // Warming the recognizer is an optimisation, never a requirement: if the
          // service does not answer the way this wrapper expects, transcription below
          // still gets its chance and reports its own error.
          try {
            speech.prepare(id, {})
            prepared = await waitReady(speech, signal)
          } catch {
            prepared = true
          }
        }
        const spec = speech.resolve?.({ audio, ...(id === undefined ? {} : { providerId: id }), ...(language === undefined ? {} : { language }) })
        if (spec === undefined) return { ok: false, reason: '语音服务不认识这段音频' }
        const text = readText(await speech.transcribe?.(spec, signal))
        if (text === '') return { ok: false, reason: '没有识别出文字' }
        return { ok: true, text }
      } catch (error) {
        // A cold start can fail the first attempt; let the next utterance retry it.
        prepared = false
        providerId = undefined
        const reason = error instanceof Error ? error.message : String(error)
        return { ok: false, reason }
      }
    },
  }
}
