/**
 * State of one continuous voice exchange: "talk, hear the answer, talk again".
 *
 * The experience is a loop the page cannot see end to end: a dictated message is sent, its reply
 * is read aloud, and the microphone has to come back exactly when the reading ends — not while the
 * agent is still working, not over the last sentence, and not at all after the user stopped
 * something on purpose. Every one of those endings arrives on a different callback (speaker state,
 * turn end, dictation result, a typed send), so the decision is kept here as one small machine
 * instead of as four booleans that each have to remember what the others mean.
 *
 * States:
 *
 *   idle     — no exchange. The microphone is on the wake word, which is the resting state.
 *   armed    — a dictated message is in flight; its reply will hand the microphone back.
 *   waiting  — the reply finished reading, but the turn has not. Opening the microphone here would
 *              record the agent's next block as if the user had spoken.
 *   opening  — the microphone is due to reopen. {@link ContinuousVoice.wantsOpen} is what the
 *              page's scheduler reads; a dictation that hears speech goes back to `armed` when it
 *              is sent, and one that hears nothing goes to `idle`.
 *
 * Deliberately free of timers, DOM and audio: the page owns those, this owns "whose turn is it".
 * That is also what makes the whole loop testable without a microphone.
 */

export const VOICE_IDLE = 'idle'
export const VOICE_ARMED = 'armed'
export const VOICE_WAITING = 'waiting'
export const VOICE_OPENING = 'opening'

export class ContinuousVoice {
  /**
   * @param {{ enabled?: boolean }} [options] — enabled is the profile's continuous-conversation
   *   switch; it defaults to on, which is the shipped experience.
   */
  constructor({ enabled = true } = {}) {
    this.enabled = enabled !== false
    this.state = VOICE_IDLE
  }

  /** Apply the profile switch. Turning it off ends any exchange already in progress. */
  configure({ enabled } = {}) {
    if (typeof enabled === 'boolean') this.enabled = enabled
    if (!this.enabled) this.state = VOICE_IDLE
    return this.state
  }

  /** Whether a voice exchange is between a dictated message and the next microphone. */
  get active() {
    return this.state !== VOICE_IDLE
  }

  /** The microphone is due to reopen; the page's timer is what actually opens it. */
  get wantsOpen() {
    return this.state === VOICE_OPENING
  }

  /** A voice message was sent: the reply to it is what the next turn follows. */
  dictated() {
    this.state = this.enabled ? VOICE_ARMED : VOICE_IDLE
    return this.state
  }

  /**
   * A reply — or a piece of one — finished playing.
   *
   * `error` is the speaker's reason for not finishing a normal reading. A failed or cancelled
   * reading is not something to hand a microphone to: the user is already being told what went
   * wrong, and a recording nobody asked for would be the second surprise.
   * @param {{ running?: boolean, asking?: boolean, error?: string }} [end] — whether the turn is
   *   still writing, and why the reading did not finish normally.
   */
  spoken({ running = false, asking = false, error = '' } = {}) {
    if (!this.enabled) return this.state
    // `opening` is included so a second block finishing before the timer fires is judged on the
    // same terms as the first; moving it to `waiting` simply makes the pending timer a no-op.
    if (this.state !== VOICE_ARMED && this.state !== VOICE_WAITING && this.state !== VOICE_OPENING) {
      return this.state
    }
    if (error !== '') this.state = VOICE_IDLE
    else this.state = running || asking ? VOICE_WAITING : VOICE_OPENING
    return this.state
  }

  /**
   * The turn stopped writing, so a reply read in the middle of it can reopen the microphone now.
   * @param {{ interrupted?: boolean, failed?: boolean }} [ending] — the two endings that end the
   *   exchange instead of continuing it.
   */
  turnEnded({ interrupted = false, failed = false } = {}) {
    if (interrupted || failed) {
      this.state = VOICE_IDLE
      return this.state
    }
    if (this.state === VOICE_WAITING) this.state = VOICE_OPENING
    return this.state
  }

  /** The scheduled opening found the page busy; keep the turn for the edge that frees it. */
  wait() {
    if (this.state === VOICE_OPENING) this.state = VOICE_WAITING
    return this.state
  }

  /** End the exchange and go back to the wake word. Safe from any state. */
  cancel() {
    this.state = VOICE_IDLE
    return this.state
  }
}
