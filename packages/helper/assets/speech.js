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
// There is deliberately no cap on a whole reply. There used to be one (600 characters) and it cut
// silently: a long answer was spoken up to the cap and then stopped, in the middle of a sentence,
// with the speaker reporting a normal finish — indistinguishable from the playback faults this file
// also has to survive. Length costs time, not correctness: the queue below fetches one sentence at a
// time, so the only bound that matters is on a single request, not on the reply.
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
    // A source cited in brackets is meant for the eye, not the ear: reading a URL out loud is a
    // string of English syllables that says nothing the sentence did not already say. The whole
    // bracket goes with it, separators and all, because "（ 、 ）" on its own would be read as a
    // pause in the middle of a sentence. Bracket groups first, so the bare-URL rule below cannot
    // leave the emptied brackets behind.
    .replace(/[（(][^（()）\n]*https?:\/\/[^（()）\n]*[）)]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')                 // any URL left outside brackets
    .replace(/[（(]\s*[、,，]?\s*[）)]/g, '')         // brackets emptied by either rule
    // Square brackets are read as a label, not as words: "[17173]" spoken aloud is a run of digits
    // that belongs to the page, not to the sentence. Unlike the round ones above this is
    // unconditional — a bracketed aside is a citation marker wherever it appears. It has to come
    // after the link rule, which is the one case where the bracket holds words worth reading.
    .replace(/[【\[][^【】\[\]\n]*[】\]]/g, ' ')
    .replace(/^\s{0,3}>\s?/gm, '')                  // block quotes
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')             // headings
    .replace(/^\s{0,3}([-*+]|\d+\.)\s+/gm, '')       // list markers
    .replace(/^\s*[-*_]{3,}\s*$/gm, '')             // rules
    .replace(/(\*\*|__)(.*?)\1/g, '$2')             // bold
    .replace(/(\*|_)(.*?)\1/g, '$2')                // italic
    .replace(/[*_~`]/g, '')                          // leftovers
    // A name the service reads badly in Chinese. 德拉曼 is a transliteration the voice spells out
    // syllable by syllable, and the character answers to the English one; so the words on screen
    // stay as written while the words in the air are the name itself. Only the name — a Chinese
    // sentence around it is still Chinese, and the service reads the mix the way it is written.
    .replace(/德拉曼/g, 'Delamain')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * The performance notes a reply carries, in the order they appear.
 *
 * A bracketed group of Chinese words is direction for the voice, not a word to read: the persona is
 * told to open a sentence whose tone matters with `[声音低沉下去，语速放慢]`. `plainForSpeech` drops
 * that group, which is right for the ear — and is exactly why the note has to be collected here,
 * from the markdown rather than from the stripped text, and handed to the service in a field of its
 * own. The same syntax also carries citations (`[17173]`), so a candidate has to look like a note:
 * square brackets only, Chinese words in it, and no link or image standing behind it.
 *
 * @param {string} markdown the raw assistant text
 * @returns {{ text: string, index: number }[]} each note and where it started
 */
export function stageDirections(markdown) {
  if (typeof markdown !== 'string') return []
  const found = []
  const pattern = /\[([^[\]\n]{1,60})\]/g
  let match
  while ((match = pattern.exec(markdown)) !== null) {
    const text = match[1].trim()
    // A direction is Chinese prose. A run of digits or Latin is the citation marker the same
    // syntax carries in ordinary replies, and a link's label is a word to read, not to perform.
    if (!/[\u4e00-\u9fff]/.test(text)) continue
    if (/https?:|\/\/|@/.test(text)) continue
    if (markdown.charAt(match.index - 1) === '!' || markdown.charAt(match.index + match[0].length) === '(') continue
    found.push({ text, index: match.index })
  }
  return found
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
      // Cut at the last soft break in the second half of the window, so a run with no sentence
      // punctuation is still split where a reader would pause. Hard-cutting at `max` lands mid-word
      // and each clip then sounds as if it were truncated — the same complaint as a stopped reading,
      // even though the queue is still healthy.
      const window = rest.slice(0, max)
      const soft = Math.max(
        window.lastIndexOf('，'), window.lastIndexOf('、'), window.lastIndexOf(','),
        window.lastIndexOf('：'), window.lastIndexOf(':'), window.lastIndexOf(' '),
      )
      const cut = soft >= Math.floor(max / 2) ? soft + 1 : max
      sentences.push(rest.slice(0, cut))
      rest = rest.slice(cut)
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
 * Join the sentence list into the units actually sent, two sentences at a time.
 *
 * The service chooses its own tempo for every request, and it does so visibly: one sentence asked
 * for four times came back at 5.56, 6.54, 5.99 and 5.56 characters a second — the same text, the
 * same voice, no rate asked for. One request per sentence therefore gives every sentence of a reply
 * a pace of its own, which is heard exactly as the complaint it is: "the middle sentences slow
 * down". Asking for an explicit rate centres that spread without narrowing it (the request takes
 * `audio_params.speech_rate`, and ±30 moves the whole distribution), because the spread is the
 * service choosing rather than the request failing to say.
 *
 * What narrows it is a shared utterance: two sentences in one request are read at one tempo by
 * construction. Two and not more, because both bounds are real — more sentences per request means
 * hearing fewer of them sooner, and the first sound is the thing this file exists to speed up. A
 * four-sentence reply becomes two requests, so two paces instead of four, and the wait for the first
 * one grows by one sentence rather than by three.
 *
 * A pair longer than {@link MAX_SENTENCE_CHARS} is left alone: the same request-size bound that
 * protects a long sentence from becoming a long wait applies to the pair.
 */
function pairsForSpeech(sentences, hints) {
  const units = []
  for (let index = 0; index < sentences.length; index += 2) {
    const first = sentences[index]
    const second = sentences[index + 1]
    // The note belongs to the sentence it opened, so the pair keeps the first one that exists —
    // a direction is about how that stretch of the reply should sound, and the second sentence in
    // the same breath is part of the same stretch.
    const hint = (hints[index] ?? '') !== '' ? hints[index] : (second === undefined ? '' : (hints[index + 1] ?? ''))
    if (second === undefined || first.length + second.length > MAX_SENTENCE_CHARS) {
      units.push({ text: first, hint: hints[index] ?? '' })
      if (second !== undefined) units.push({ text: second, hint: hints[index + 1] ?? '' })
      continue
    }
    units.push({ text: `${first}${second}`, hint })
  }
  return units
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
  constructor({ endpoint = 'http://127.0.0.1:8765', voice = '', onState, ensure } = {}) {
    this.endpoint = endpoint.replace(/\/+$/, '')
    /**
     * Which of the service's voices to read with. Sent per request rather than fixed at launch,
     * because the service routes on it: one URL serves every voice, so choosing one is a field
     * change and not a restart. Empty means "whatever the service was started with".
     */
    this.voice = typeof voice === 'string' ? voice.trim() : ''
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
    /**
     * How many replies have been read to the end. A counter rather than a flag because the page
     * needs the *edge* — the moment the last sentence of this reply ended — and a flag cannot say
     * which of two replies it belongs to. Only {@link settle} moves it, so a cancelled reading
     * never counts as a finished one.
     */
    this.finished = 0
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
   * Choose the voice the next sentences are asked for in.
   *
   * Not a cancel: a reading already in the air finishes in the voice it started in, and the one
   * after it is the new voice. Cutting a sentence off half-way to change timbre is the more
   * annoying half of the change.
   */
  setVoice(voice) {
    if (typeof voice !== 'string') return
    const next = voice.trim()
    if (next === this.voice) return
    this.voice = next
    this.emit()
  }

  /**
   * Apply the host's speech settings.
   *
   * Turning the feature off cancels immediately: leaving a half-read answer playing after the user
   * switched it off would be the more surprising half of that decision.
   * @param {{enabled?: unknown, autoPlay?: unknown, endpoint?: unknown, voice?: unknown}} settings
   */
  configure({ enabled, autoPlay, endpoint, voice } = {}) {
    this.setEndpoint(endpoint)
    this.setVoice(voice)
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
      finished: this.finished,
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
   * @param {object} [options] `minChars` overrides the "probably a fragment" floor; a wake
   * acknowledgement is deliberately two characters long and still has to be heard.
   */
  speak(markdown, key = '', { minChars = MIN_CHARS } = {}) {
    const text = plainForSpeech(markdown)
    if (!this.enabled || text.length < minChars) return
    const sentences = sentencesForSpeech(text)
    // Each note is attached to the sentence that sits where the note sat in the reply, measured as a
    // share rather than as a count: `sentencesForSpeech` merges short lines, so counting sentences
    // would drift by one and put a tired direction on the joke before it. The share does not drift.
    const hints = sentences.map(() => '')
    if (sentences.length > 0) {
      for (const note of stageDirections(markdown)) {
        const share = markdown.length === 0 ? 0 : note.index / markdown.length
        const target = Math.min(sentences.length - 1, Math.floor(share * sentences.length))
        if (hints[target] === '') hints[target] = note.text
      }
    }

    // Two sentences per request, so a reply is read at two paces rather than one per sentence —
    // see {@link pairsForSpeech} for what that fixes and what it costs. The queue below is
    // unchanged: it still waits for one unit, asks for the next, then plays this one.
    const units = pairsForSpeech(sentences, hints)

    // A newer request always wins. Cancelling first means the previous answer stops mid-word rather
    // than talking over the new one.
    this.cancel()
    const generation = this.generation
    this.currentKey = key
    this.lastError = ''
    this.lastDetail = ''
    this.notice = ''

    this.speaking = true
    this.emit()
    // `run` reports problems as state rather than as exceptions, so anything that reaches the handler
    // is a bug in this file — and an unhandled rejection would leave the button showing a stop square
    // for a reply nobody is reading. The whole text is handed over: `sentencesForSpeech` bounds what
    // one request may contain, and the queue's own generation check is what can stop a reading early.
    //
    // The promise goes back to the caller because one caller needs the end of the reading as an
    // edge of its own: a wake acknowledgement holds the microphone shut until it has finished
    // talking. Every other caller ignores it.
    this.pending = this.run(
      units.map((unit) => unit.text),
      generation,
      units.map((unit) => unit.hint),
    ).catch((error) => {
      this.fail('playback', String((error && error.message) || error))
    })
    return this.pending
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
  async run(sentences, generation, hints = []) {
    const inFlight = new Map()
    const request = (index) => {
      if (index >= sentences.length) return null
      if (!inFlight.has(index)) {
        inFlight.set(index, this.request(sentences[index], generation, index === 0, hints[index] ?? ''))
      }
      return inFlight.get(index)
    }

    // A sentence the service would not produce, or one the player refused, is not a reason to
    // abandon the ones after it. That is what used to happen: a single clip that did not play ended
    // the queue, so a reply stopped dead half way through, the remaining sentences were never even
    // requested, and nothing on screen said why. Every sentence now gets its turn; only a newer
    // reply taking over (the generation moving on) ends the loop early. A sentence that fails marks
    // the reading incomplete, so it is not later counted as read to its end.
    let incomplete = false
    try {
      for (let index = 0; index < sentences.length; index += 1) {
        const blob = await request(index)
        if (blob === null) {                        // cancelled, superseded, or already reported
          if (generation !== this.generation) return
          incomplete = true
          continue
        }
        request(index + 1)                          // while the next one plays, not before this one
        const played = await this.playAndWait(blob, generation)
        if (!played && generation !== this.generation) return
        if (!played) incomplete = true
      }
    } finally {
      // Whatever happened — the last sentence, a cancellation, a service that gave up half way —
      // the button has to go back to a play triangle. `fail` no longer does this itself precisely
      // because a failed sentence is survivable now.
      this.settle(generation, !incomplete)
    }
  }

  /**
   * Put the speaker back in its resting state, unless a newer reply has taken over in the meantime
   * (in which case that one owns the state and clearing it here would blank its button).
   * @param {number} generation the reading this call belongs to
   * @param {boolean} [completed] whether every sentence of it played to its end
   */
  settle(generation, completed = false) {
    if (generation !== this.generation) return
    if (!this.speaking && this.currentKey === '') return
    this.speaking = false
    this.currentKey = ''
    // Only a reading that reached the end with every clip played counts as finished. One that
    // stopped short — cancelled, superseded, or a sentence the service or the player refused — has
    // not read the reply out, and the caller must not treat it as though it had.
    if (completed) this.finished += 1
    this.emit()
  }

  /**
   * Ask the service for one sentence.
   *
   * Resolves with the audio, or `null` when the answer no longer matters — cancelled, superseded, or
   * failed, in which case {@link fail} has already reported why.
   */
  request(text, generation, allowRevive, instruct = '') {
    return new Promise((resolve) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      // The voice rides with the sentence, and the performance note rides beside it rather than in
      // it: the service reads the note as direction for how to speak the sentence, and the text it
      // reads out is the sentence alone — the note was already dropped from that by plainForSpeech.
      const payload = this.voice === '' ? { text } : { text, voice: this.voice }
      if (instruct !== '') payload.instruct = instruct
      const settle = (value) => {
        clearTimeout(timer)
        resolve(value)
      }

      fetch(`${this.endpoint}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The voice rides with the sentence: the service picks its engine from it, so leaving it out
        // would silently read everything in whatever that process was launched with.
        body: JSON.stringify(payload),
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
   * error, which is reported through {@link fail} rather than thrown, so the queue can move on to
   * the next sentence instead of treating one bad clip as the end of the reply.
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
