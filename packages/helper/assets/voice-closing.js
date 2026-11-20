/**
 * "That is all for now" — the phrases that end a continuous voice exchange.
 *
 * A voice loop has one exit the user can take without touching anything: saying so. Without this, the
 * only ways out were the ball's own menu, the stop button, or waiting out a quiet window, and a user
 * who said "先这样" was answered and then handed a microphone they no longer wanted.
 *
 * Deliberately keyword matching rather than a model call: the decision has to be made in the page,
 * on the transcript, before a turn is sent — sending "先这样" to the agent to ask whether it is a
 * closing remark is a round trip on every utterance, and a wrong answer would be acted on. The cost
 * of the choice is the list below, which is why it is a plain exported constant: this is the one
 * place to add a phrase a user actually says.
 *
 * The matching is equality, not "contains". A sentence that merely *ends* the way a closer does
 * ("就这样把它删掉") is ordinary speech, and ending a conversation on it would be the failure this
 * file exists to avoid. So the whole normalized utterance has to be one of the phrases, modulo the
 * fillers and particles a speaker wraps around it: "嗯，那先这样吧" and "先这样" are the same
 * intent, "先" on its own is not — nothing shorter than a phrase matches, and no single-character
 * entry exists.
 *
 * @module voice-closing
 */

/**
 * The closing phrases, normalized once at load.
 *
 * Chinese entries are stems: the trailing-particle list below covers 吧/啊/了/啦/呀/哈/哦/呢/嘛/呗,
 * so "先这样吧" needs no entry of its own. English entries are whole phrases; the leading
 * acknowledgements and the trailing "please" are stripped like the Chinese fillers.
 */
export const CLOSING_PHRASES = Object.freeze([
  // Dismissing the assistant itself.
  '你退下',
  '你退一下',
  '退下',
  '你可以退了',
  '你可以休息了',
  // "Nothing you need to do now".
  '没你事了',
  '没你事儿了',
  '没你的事了',
  '没你的事儿了',
  '不需要你了',
  // "Leave it here / that is all".
  '先这样',
  '就先这样',
  '先这么办',
  '就先这么办',
  '先这样办',
  '就这样',
  '到此为止',
  '先到这',
  // Ending the session.
  '结束',
  '结束吧',
  '收工',
  '收工吧',
  '散会',
  '没事了',
  '不用了',
  '我走了',
  '我先走了',
  '拜拜',
  '再见',
  // English. The page dictionary can be English, and a user may speak either. The contractions are
  // listed in their normalized form ("we're" loses its apostrophe before the comparison).
  'that is all',
  'thats all',
  'that is it',
  'thats it',
  'we are done',
  'were done',
  'im done',
  'you can go',
  'stand down',
  'nothing else',
  'done for now',
  'stop here',
  'leave it there',
  'goodbye',
  'bye',
])

/**
 * Single characters and sounds a speaker puts in front of a phrase: "嗯，那先这样" is the same
 * request as "先这样". Only one is stripped, and only when something is left after it.
 */
const LEADING_FILLERS = Object.freeze(['那', '嗯', '好', '行', '呃', '哎', '唉', '哦', '额', 'ok', 'okay', 'alright', 'well', 'so'])

/** Sentence-final particles and politeness that do not change the request. */
const TRAILING_PARTICLES = Object.freeze(['吧', '啊', '呀', '了', '啦', '哈', '哦', '嘛', '呢', '呗', '喔', '噢', 'please', 'now'])

/** Longest normalized utterance still worth testing. A full sentence is never one of these. */
const MAX_LENGTH = 24

const PHRASE_SET = new Set(CLOSING_PHRASES.map(normalize))

/**
 * Sentence punctuation, whitespace and symbols, dropped before comparing — plus the full-width
 * forms `normalize('NFKC')` already folds. "没你事了。" and "没你事了" are the same transcript with
 * and without the recognizer's full stop.
 * @param {string} text the raw utterance.
 * @returns {string} lower case, punctuation-free, whitespace-free.
 */
function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

/**
 * Every form of one normalized utterance that could be a phrase: the utterance itself, the same
 * with its trailing particles stripped, and each of those with its leading fillers stripped —
 * up to two of them, because "嗯，那先这样吧" opens with both a hesitation and a 那.
 * @param {string} text an already normalized utterance.
 * @returns {Iterable<string>} the candidates, least-trimmed first.
 */
function* candidates(text) {
  const withoutTail = new Set([text])
  let trimmed = text
  for (let round = 0; round < 2; round += 1) {
    const particle = TRAILING_PARTICLES.find((value) => trimmed.length > value.length && trimmed.endsWith(value))
    if (particle === undefined) break
    trimmed = trimmed.slice(0, -particle.length)
    withoutTail.add(trimmed)
  }
  for (const value of withoutTail) {
    yield value
    let head = value
    for (let round = 0; round < 2; round += 1) {
      const filler = LEADING_FILLERS.find((prefix) => head.length > prefix.length && head.startsWith(prefix))
      if (filler === undefined) break
      head = head.slice(filler.length)
      yield head
    }
  }
}

/**
 * Whether one transcript is the user ending the exchange.
 *
 * Equality against the list, after removing punctuation, trailing particles and one leading filler.
 * Substrings never match, so "先这样处理" is a request and "先这样" is a goodbye; nothing shorter
 * than a two-character phrase can match at all.
 * @param {string} text the transcript as the speech service returned it.
 * @returns {boolean} whether the exchange should end here.
 */
export function isClosingPhrase(text) {
  const normalized = normalize(text)
  if (normalized === '' || normalized.length > MAX_LENGTH) return false
  for (const value of candidates(normalized)) {
    if (PHRASE_SET.has(value)) return true
  }
  return false
}
