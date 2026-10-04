/**
 * Speaks assistant replies through a local speech service.
 *
 * Nothing here knows which engine answers. The contract is "POST JSON to /speak, receive audio",
 * so the engine can be swapped without touching this file — and it has been: the process behind
 * `/speak` is now a proxy in front of a hosted voice rather than a local model. That is why the
 * startup wording lives in `shell.js` and not here.
 *
 * Four decisions that shape everything else:
 *
 * **Only finished replies are spoken automatically.** `block.running` flipping from true to false is
 * the moment a reply is complete, and it is the only moment the text is final. Speaking while tokens
 * are still arriving would either stutter on every token or need its own debounce, and would read
 * truncated sentences aloud. A button, by contrast, is always pressed on finished text.
 *
 * **A reply is spoken sentence by sentence, and the next one is asked for as this one starts
 * playing.** Asking for a whole answer at once means waiting for all of it before hearing any of it.
 * Measured against the service this orb currently points at, a 234-character reply comes back as one
 * piece after 42 seconds — 10 to synthesise, 32 to download at the ~20 KB/s the audio host manages —
 * which is not a wait anybody will sit through. Cut into sentences, the same reply starts playing
 * after the first one, about five seconds in. The same reasoning applies to the local model, where
 * one long request is minutes and one sentence is seconds.
 *
 * The one part of that overlap to get right is *when* the next sentence is asked for. It has to
 * start before this one finishes playing, or the gap between sentences is a whole round trip — but
 * it must not start before this one has arrived, because two syntheses in flight at once is what the
 * far side cannot do. Measured on the current service, a pair of overlapping requests took 9.1 s and
 * 21.6 s where the same two asked one after the other take about 5 s each, and the log fills with
 * `IncompleteRead` retries while the overlap lasts. So the order is: wait for sentence N, ask for
 * sentence N+1, then play N. The download of the next sentence still runs underneath the playback of
 * this one, which is the whole point, and only ever one request is in the air.
 *
 * **Requests are serialised and cancellable.** The answer to a question the user has moved past is
 * worse than no answer, so a newer request cancels the sentence in flight and abandons the queue.
 *
 * **One speaker at a time, and the page knows which.** `currentKey` is the block being read right
 * now, so the button under that message can show a stop square instead of a play triangle. Without
 * it a page with twenty replies has twenty identical buttons and no way to tell which one to cancel.
 */

/** How long to wait for one sentence before deciding the service is not there. */
const REQUEST_TIMEOUT_MS = 180000
/** Below this, a reply is probably a fragment and reading it aloud would just be noise. */
const MIN_CHARS = 4
/** Refuse text past this length rather than synthesising for minutes. */
const MAX_CHARS = 600
/**
 * Bounds on one request. Below `min` two sentences are merged, because a round trip for two words
 * wastes more time than the join costs and the joins start to be audible. Above `max` a sentence is
 * split even without punctuation, or one unpunctuated paragraph would recreate the whole-reply wait.
 */
const MIN_SENTENCE_CHARS = 20
const MAX_SENTENCE_CHARS = 120

/**
 * Markdown is read to a human with structure, but the speech model has no idea what a code fence or a
 * link target is. Stripping it here rather than in the service keeps that side dumb and lets the
 * decision be tuned without restarting anything.
 */
export function plainForSpeech(markdown) {
  if (typeof markdown !== 'string') return ''
  return markdown
    .replace(/```[\s\S]*?```/g, ' 代码块 ')          // fenced code
    .replace(/~~~[\s\S]*?~~~/g, ' 代码块 ')
    .replace(/`([^`]+)`/g, '$1')                     // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' 图片 ')      // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')        // links keep their label
    .replace(/^\s{0,3}>\s?/gm, '')                  // block quotes
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')             // headings
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')       // list markers
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')             // rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2')             // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                // italic
    .replace(/[*_~`]/g, '')                          // leftovers
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * Cut a reply into the units that are fetched and spoken one at a time.
 *
 * Boundaries are sentence ends, because that is where a pause belongs anyway and where the audio can
 * be joined without an audible seam. Sentences are accumulated until they reach `min` so a
 * back-and-forth of short lines does not become a round trip each, and split at `max` because a
 * reply with no punctuation at all would otherwise recreate the wait this exists to remove.
 */
export function sentencesForSpeech(text, { min = MIN_SENTENCE_CHARS, max = MAX_SENTENCE_CHARS } = {}) {
  // A run ending in its terminator, or a trailing run with none. Newlines terminate too: a list item
  // or a blank line is a place a reader stops.
  const pieces = String(text).match(/[^。！？!?；;…\n]+[。！？!?；;…\n]*/gu) ?? []
  const sentences = []
  let pending = ''

  const flush = () => {
    let rest = pending
    while (rest.length > max) {
      sentences.push(rest.slice(0, max))
      rest = rest.slice(max)
    }
    if (rest.trim() !== '') sentences.push(rest)
    pending = ''
  }

  for (const piece of pieces) {
    pending += piece
    if (pending.length >= min) flush()
  }
  if (pending.trim() !== '') flush()
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence !== '')
}

/**
 * Whether a `fetch` failed because it never reached the service.
 *
 * Worth distinguishing from a service that answered badly: the first is usually just it not being
 * up yet, which the host can fix by starting it, and the second never is.
 */
function isOffline(error) {
  if (error && error.name === 'AbortError') return false
  const message = String((error && error.message) || '')
  return message.includes('Failed to fetch')
    || message.includes('NetworkError')
    || message.includes('ERR_CONNECTION')
}

export class Speaker {
  /**
   * @param {object} options
   * @param {string} options.endpoint base URL of the speech service
   * @param {(state: object) => void} [options.onState] notified when playback state changes
   * @param {() => Promise<{ ok: boolean, reason?: string }>} [options.ensure] ask the host to make
   *   sure the service is running, starting it if needed. Omitted when nothing can start it.
   */
  constructor({ endpoint = 'http://127.0.0.1:8765', onState, ensure } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '')
    this.onState = typeof onState === 'function' ? onState : () => {}
    this.ensure = typeof ensure === 'function' ? ensure : null
    /** Generation counter — every new request bumps it, and stale work checks it before continuing. */
    this.generation = 0
    this.audio = null
    /**
     * The resolver of the sentence playing right now. A sentence that is cancelled never fires
     * `ended`, so without holding this the queue would wait on it forever.
     */
    this.playingResolve = null
    /** Feature switch from the host. Off means no buttons and no automatic reading. */
    this.enabled = false
    /** Whether a finished reply starts reading itself. Independent of `enabled`. */
    this.autoPlay = false
    this.speaking = false
    /** Block key currently being read, or '' when nothing is playing. */
    this.currentKey = ''
    /**
     * A code, not a sentence: this module has no idea what language the ball is showing, so it
     * reports `offline` / `timeout` / `autoplay` / `playback` / `server` and lets the caller word it.
     */
    this.lastError = ''
    /** Raw service text to show alongside the code, when there is any. */
    this.lastDetail = ''
    /** Progress worth showing while something is being waited on, e.g. the service starting up. */
    this.notice = ''
  }

  /** Point at a different service. A no-op when unchanged, so callers can push on every sync. */
  setEndpoint(endpoint) {
    if (typeof endpoint !== 'string' || endpoint.trim() === '') return
    const next = endpoint.trim().replace(/\/+$/, '')
    if (next === this.endpoint) return
    this.endpoint = next
    // Whatever was queued was addressed to the old service; the audio is still ours to stop.
    this.cancel()
  }

  /**
   * Apply the host's speech settings.
   *
   * Turning the feature off cancels immediately: leaving a half-read answer playing after the user
   * switched it off would be the more surprising half of that decision.
   * @param {{enabled?: unknown, autoPlay?: unknown, endpoint?: unknown}} settings
   */
  configure({ enabled, autoPlay, endpoint } = {}) {
    this.setEndpoint(endpoint)
    if (typeof enabled === 'boolean' && enabled !== this.enabled) {
      this.enabled = enabled
      if (!enabled) this.cancel()
    }
    if (typeof autoPlay === 'boolean') this.autoPlay = autoPlay
    this.emit()
  }

  setEnabled(enabled) {
    this.configure({ enabled })
  }

  state() {
    return {
      enabled: this.enabled,
      autoPlay: this.autoPlay,
      speaking: this.speaking,
      key: this.currentKey,
      error: this.lastError,
      detail: this.lastDetail,
      notice: this.notice,
    }
  }

  emit() {
    this.onState(this.state())
  }

  /** Stop whatever is playing and invalidate anything in flight. */
  cancel() {
    this.generation += 1
    // Bumping the generation makes anything that arrives later a no-op, but the queue is *awaiting*
    // the sentence in flight. A cancelled sentence never fires `ended`, so settling it here is what
    // keeps that wait finite — otherwise the queue would hold the audio element forever.
    if (this.playingResolve !== null) {
      const finish = this.playingResolve
      this.playingResolve = null
      finish()
    }
    if (this.audio) {
      this.audio.pause()
      // Clearing src releases the decoded buffer; without this Chromium keeps it alive and the
      // next reply's audio can stutter for a second even though it is a different element.
      this.audio.removeAttribute('src')
      this.audio = null
    }
    if (this.speaking || this.currentKey !== '') {
      this.speaking = false
      this.currentKey = ''
      this.emit()
    }
  }

  /** Whether `key` is the reply being read right now, so its button can offer a stop. */
  isSpeaking(key) {
    return this.speaking && this.currentKey === key
  }

  /**
   * Speak a completed reply. Returns immediately; playback happens as the audio arrives.
   *
   * Called both by the finished-reply hook and by the per-message button, so it takes the block key:
   * the button needs it to know which one to turn into a stop control.
   * @param {string} markdown the raw assistant text
   * @param {string} [key] block identity, for the stop affordance
   */
  speak(markdown, key = '') {
    const text = plainForSpeech(markdown)
    if (!this.enabled || text.length < MIN_CHARS) return

    // A newer request always wins. Cancelling first means the previous answer stops mid-word rather
    // than talking over the new one.
    this.cancel()
    const generation = this.generation
    this.currentKey = key
    this.lastError = ''
    this.lastDetail = ''
    this.notice = ''

    // Tool transcripts and code dumps should not become spoken text even when they arrive as an
    // assistant block; the caller filters by kind, this is the backstop.
    if (text.length > MAX_CHARS) {
      this.onState({ ...this.state(), truncated: true })
    }

    this.speaking = true
    this.emit()
    // `run` reports problems as state rather than as exceptions, so anything that reaches the handler
    // is a bug in this file — and an unhandled rejection would leave the button showing a stop square
    // for a reply nobody is reading.
    this.run(sentencesForSpeech(text.slice(0, MAX_CHARS)), generation).catch((error) => {
      this.fail('playback', String((error && error.message) || error))
      this.settle(generation)
    })
  }

  /**
   * Fetch and speak the sentences in order, keeping one request in the air at a time.
   *
   * The ordering inside the loop is the whole design, and both sides of it are load-bearing:
   *
   *   * `request(index + 1)` comes *after* `await request(index)` because overlapping two syntheses
   *     is what the far side cannot do — see the note at the top of this file for the measurements.
   *   * It comes *before* `await this.playAndWait(blob, …)` because that is the only reason to ask
   *     early at all: the next sentence is then being synthesised and downloaded underneath this
   *     one's playback, so the gap the listener hears is the tail of a wait that has already been
   *     running rather than the whole of it.
   *
   * Deliberately not `async` in a way that can reject: a failure is reported through {@link fail} and
   * arrives as a `null`, so the loop has exactly one way out.
   */
  async run(sentences, generation) {
    const inFlight = new Map()
    const request = (index) => {
      if (index >= sentences.length) return null
      if (!inFlight.has(index)) {
        inFlight.set(index, this.request(sentences[index], generation, index === 0))
      }
      return inFlight.get(index)
    }

    // A sentence the service would not produce is not a reason to abandon the ones after it. That is
    // what used to happen, and it is why a reply could stop dead half way through with the remaining
    // sentences never spoken and nothing on screen but the reason the service gave. Two in a row is
    // a different story: at that point the service is down rather than one clip being unlucky, and
    // asking for the rest only multiplies the wait before the same message appears.
    let failures = 0
    try {
      for (let index = 0; index < sentences.length; index += 1) {
        const blob = await request(index)
        if (blob === null) {                        // cancelled, superseded, or already reported
          if (generation !== this.generation) return
          failures += 1
          if (failures >= 2) return
          continue
        }
        failures = 0
        request(index + 1)                          // while the next one plays, not before this one
        const played = await this.playAndWait(blob, generation)
        if (!played) return
      }
    } finally {
      // Whatever happened — the last sentence, a cancellation, a service that gave up half way —
      // the button has to go back to a play triangle. `fail` no longer does this itself precisely
      // because a failed sentence is survivable now.
      this.settle(generation)
    }
  }

  /**
   * Put the speaker back in its resting state, unless a newer reply has taken over in the meantime
   * (in which case that one owns the state and clearing it here would blank its button).
   */
  settle(generation) {
    if (generation !== this.generation) return
    if (!this.speaking && this.currentKey === '') return
    this.speaking = false
    this.currentKey = ''
    this.emit()
  }

  /**
   * Ask the service for one sentence.
   *
   * Resolves with the audio, or `null` when the answer no longer matters — cancelled, superseded, or
   * failed, in which case {@link fail} has already reported why.
   */
  request(text, generation, allowRevive) {
    return new Promise((resolve) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      const settle = (value) => {
        clearTimeout(timer)
        resolve(value)
      }

      fetch(`${this.endpoint}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })
        .then((response) => {
          if (generation !== this.generation) return null       // superseded, drop it
          if (!response.ok) throw new Error(`service said ${response.status}`)
          return response.blob()
        })
        .then((blob) => {
          if (!blob || generation !== this.generation) {
            settle(null)
            return
          }
          settle(blob)
        })
        .catch((error) => {
          if (generation !== this.generation) {
            settle(null)
            return
          }
          // Only the first sentence may revive the service. A failure there usually means it is not
          // up yet, and the host can start it. By a later sentence the answer is already half
          // spoken, so a retry would talk over itself; that is a real problem, not a cold start.
          if (allowRevive && this.ensure !== null && isOffline(error)) {
            this.notice = 'starting'
            this.emit()
            Promise.resolve(this.ensure()).then((result) => {
              if (generation !== this.generation) {
                settle(null)
                return
              }
              this.notice = ''
              if (result && result.ok) this.request(text, generation, false).then(settle)
              else {
                this.fail('offline')
                settle(null)
              }
            }).catch(() => {
              if (generation !== this.generation) {
                settle(null)
                return
              }
              this.fail('offline')
              settle(null)
            })
            return
          }
          // An abort is our own timeout, not a service failure, so it is not reported as one.
          if (error.name === 'AbortError') this.fail('timeout')
          else if (isOffline(error)) this.fail('offline')
          else this.fail('server', String(error.message))
          settle(null)
        })
    })
  }

  /**
   * Play one sentence and resolve when it has finished.
   *
   * Resolves `true` when it ended on its own and `false` when it did not — cancelled, or a playback
   * error, which is reported through {@link fail} rather than thrown, so the queue stops cleanly.
   */
  playAndWait(blob, generation) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      this.audio = audio

      let settled = false
      const finish = (code, detail) => {
        if (settled) return
        settled = true
        if (this.playingResolve === finish) this.playingResolve = null
        URL.revokeObjectURL(url)
        if (this.audio === audio) this.audio = null
        if (generation !== this.generation) {
          resolve(false)
          return
        }
        if (code) {
          this.fail(code, detail)
          resolve(false)
          return
        }
        resolve(true)
      }
      this.playingResolve = finish

      audio.addEventListener('ended', () => finish())
      audio.addEventListener('error', () => finish('playback'))
      audio.play().catch((error) => {
        // Autoplay policy rejects playback until the page has been interacted with. That is expected
        // for a floating window the user may never have clicked, so it is reported as a state rather
        // than an error the user has to act on.
        finish(error.name === 'NotAllowedError' ? 'autoplay' : 'playback', String(error.message))
      })
    })
  }

  /**
   * Record why something failed and put it on screen.
   *
   * Deliberately does *not* stop the run or clear the key. One sentence the service would not
   * produce is survivable — the rest of the reply still gets read — so stopping is the queue's
   * decision ({@link run}) and returning the button to rest is {@link settle}'s. `cancel` is the one
   * that has to stop playback immediately, and it does that itself.
   */
  fail(code, detail = '') {
    this.lastError = code
    this.lastDetail = String(detail).slice(0, 120)
    this.notice = ''
    this.emit()
  }
}
