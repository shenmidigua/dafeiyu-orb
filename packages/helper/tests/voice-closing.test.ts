/**
 * The phrases that end a continuous voice exchange ("先这样", "没你事了").
 *
 * Two things have to hold, and they pull in opposite directions: the phrases a user actually says
 * have to be recognized however they wrap them ("嗯，那先这样吧"), and an ordinary sentence must never
 * be mistaken for one — the failure is silent and very visible when it happens, because the ball
 * stops listening and answers nothing while the user was still talking.
 *
 * The matching is equality after normalization, so the interesting cases are the ones either side of
 * that line: a filler or a particle around the phrase, versus a longer sentence that merely contains
 * it. Both are pinned below.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CLOSING_PHRASES, isClosingPhrase } from '../assets/voice-closing.js'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')

describe('the closing-phrase list', () => {
  it('has no single character in it', () => {
    // The one rule that cannot be relaxed: a single syllable is ordinary speech ("先", "好"), and a
    // table that fired on one would end a conversation in the middle of a sentence.
    for (const phrase of CLOSING_PHRASES) {
      assert.ok([...phrase].length >= 2, `${phrase} is too short to be a phrase`)
    }
    assert.equal(CLOSING_PHRASES.includes('先'), false)
    assert.equal(CLOSING_PHRASES.includes('好'), false)
  })

  it('is a frozen list, so it can be extended but not rewritten at runtime', () => {
    assert.equal(Object.isFrozen(CLOSING_PHRASES), true)
  })
})

describe('ending the exchange in words', () => {
  it('recognizes the phrases the user named, with and without their wrapping', () => {
    const hits = [
      // The examples from the request itself.
      '先这样',
      '没你事了',
      '你退一下吧',
      '就先这么办',
      // As the speech service returns them: full stops, commas, spaces.
      '先这样。',
      '没你事了！',
      '你退下吧。',
      '先，这样',
      // Fillers and particles around the same phrase.
      '嗯，先这样吧',
      '那先这样。',
      '好，就先这么办吧',
      '嗯那先这样',
      '没你事儿了',
      // Others in the same family.
      '收工',
      '散会吧',
      '我走了',
      '拜拜',
      '就这样吧',
      '不需要你了',
      // English, for a page running in English.
      'That is all.',
      'ok bye',
      "we're done",
      'you can go please',
    ]
    for (const text of hits) assert.equal(isClosingPhrase(text), true, `missed: ${text}`)
  })

  it('never treats an ordinary sentence as one', () => {
    // Every one of these either contains a phrase or *ends* with one, which is exactly what an
    // equality match is for. "先这样处理" is an instruction; "就这样把它删掉" is a request.
    const misses = [
      '',
      '   ',
      '。',
      '先',
      '好',
      '先看看',
      '先这样处理一下',
      '先这样放着吧我一会儿再看',
      '这件事先这样办完之后再说',
      '就这样把它删掉',
      '没你事了吗',
      '你退下之前把窗口关掉',
      '帮我把那个文件删了',
      '今天天气怎么样',
      '把微信打开',
      '先这样吧你觉得怎么样',
      '结束这个任务以后告诉我',
      '再见这个词怎么写',
      'ok',
      'bye bye bye bye bye bye bye',
      'that is all I wanted to ask about the file',
    ]
    for (const text of misses) assert.equal(isClosingPhrase(text), false, `false positive: ${text}`)
  })

  it('does not fire on something that is not a string', () => {
    for (const value of [undefined, null, 42, {}, []]) {
      assert.equal(isClosingPhrase(value as unknown as string), false)
    }
  })
})

describe('the page wires the phrases into the transcript', () => {
  it('checks before the transcript reaches the composer or the agent', () => {
    const apply = shell.slice(shell.indexOf('function applyTranscript'), shell.indexOf('function closeVoiceTurn'))
    assert.ok(apply.length > 0, 'the transcript handler exists')
    const closing = apply.indexOf('isClosingPhrase(text)')
    const composer = apply.indexOf('insertPlainText(prompt, text)')
    assert.notEqual(closing, -1, 'the transcript never asks whether it was a goodbye')
    assert.notEqual(composer, -1)
    assert.ok(closing < composer, 'a closing phrase would be typed into the composer before being noticed')
    // It has to leave the handler there: falling through would send the phrase to the agent.
    assert.match(apply.slice(closing), /^isClosingPhrase\(text\)\) \{\s*closeVoiceTurn\(\)\s*return\s*?\}/)
  })

  it('closes the exchange rather than answering it', () => {
    const close = shell.slice(shell.indexOf('function closeVoiceTurn'), shell.indexOf('function continuousNoSpeechMs'))
    assert.match(close, /continuousVoice\.cancel\(\)/, 'the loop would reopen the microphone for another turn')
    assert.match(close, /wake\.playShutTone\(\)/, 'the microphone closing is meant to be audible')
    assert.match(close, /status\.textContent = messages\.voiceClosing/, 'the user gets one short line')
    assert.match(close, /CLOSING_ACK_MS/, 'the line has to clear itself')
    // The acknowledgement must not be spoken: the speaker refuses anything under four characters, and
    // its audio would mute the wake word for the length of the sentence.
    assert.equal(close.includes('speaker.speak'), false)
  })

  it('has copy for the acknowledgement in both languages', () => {
    for (const marker of ['voiceClosing: \'行，先这样。\'', 'voiceClosing: \'Okay, stopping here.\'']) {
      assert.equal(shell.includes(marker), true, `${marker} is missing from the page dictionary`)
    }
  })
})
