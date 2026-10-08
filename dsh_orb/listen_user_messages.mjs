/**
 * Make the host notice a message the user sends the agent from another window, and tell the ball.
 *
 * The ball's own panel already tells it: `onPrompt` runs for a message sent from the composer, and the cue is
 * wired at that call. A message typed in the DSH window never goes through it, and the transcript reader skips
 * live user messages on purpose (`if (!this.replaying) return`), so nothing today reports it.
 *
 * `session/event` is the feed that would carry it, and whether a `{ global: true }` subscription receives
 * *other* sessions' events is not something this plugin has ever proven — the note in `dsh_orb/README.md` says so
 * about `agent/assistant-stream` and says nothing about this one. So the listener is registered defensively and
 * writes down what it sees either way: if it never fires, that is the answer, and it is recorded rather than
 * assumed.
 *
 * Usage: `node dsh_orb/listen_user_messages.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const ORB = 'packages/host/src/orb.ts'
const failures = []

function patch(from, to, note) {
  const path = join(ROOT, ORB)
  const text = readFileSync(path, 'utf8')
  const at = text.indexOf(from)
  if (at === -1) {
    failures.push(`${note} — not found`)
    return
  }
  if (text.indexOf(from, at + 1) !== -1) {
    failures.push(`${note} — more than once`)
    return
  }
  writeFileSync(path, text.slice(0, at) + to + text.slice(at + from.length), 'utf8')
  console.log(`  ${note}`)
}

patch(
  `    this.listenAssistantStream()
`,
  `    this.listenAssistantStream()
    this.listenUserMessages()
`,
  'the listener registration')

patch(
  `  private listenAssistantStream(): void {
`,
  `  /**
   * Follow the user's messages so the ball can acknowledge one, whichever window it was typed in.
   *
   * A message sent from the ball's own composer is already reported by \`onPrompt\`; this is for the DSH window,
   * where nothing does. It listens defensively and records what it hears: whether a global subscription really
   * delivers other sessions' events was an open question here, and a listener that never fires looks precisely
   * like a page that never repaints.
   */
  private listenUserMessages(): void {
    try {
      this.ctx.on('session/event', (payload) => this.onAnySessionEvent(payload), { global: true })
      this.noteOtherStream('listening for user messages from any session')
    } catch (error) {
      this.noteOtherStream(\`session/event unavailable: \${error instanceof Error ? error.message : String(error)}\`)
    }
  }

  /** One event from any session: the user's own words are the only kind the ball has a cue for. */
  private onAnySessionEvent(payload: unknown): void {
    const record = asRecord(payload)
    const event = asRecord(record?.event) ?? record
    const type = typeof event?.type === 'string' ? event.type : ''
    if (!this.userMessageSeenLogged) {
      this.userMessageSeenLogged = true
      this.noteOtherStream(\`any session event reaches this plugin (first kind: \${type === '' ? 'none' : type})\`)
    }
    if (type !== 'user/message') return
    const session = asRecord(record?.session)
    const id = typeof session?.id === 'string' ? session.id : ''
    // The ball's own session is the panel's business, and \`onPrompt\` already acknowledged it — twice for one
    // message would be two nods for one hand-over.
    if (id === this.sessionId) return
    this.noteOtherStream(\`the user sent a message in \${id === '' ? 'another session' : id}\`)
    this.broadcast({ type: 'session-turn', outcome: 'user' })
  }

  private listenAssistantStream(): void {
`,
  'the listener')

patch(
  `  private otherStreamTool: string | undefined
`,
  `  private otherStreamTool: string | undefined
  /** Whether this plugin has ever seen a session event through the global subscription. Logged once. */
  private userMessageSeenLogged = false
`,
  'the field')

console.log('')
if (failures.length > 0) {
  console.error('FAILED:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}
console.log('all patches applied')
