// Dump what the orb's own splitter does to a reply, so the timing bench measures the real division
// instead of a guess. The splitter lives in speech.js as an ES module, which Python cannot import,
// so the two halves of the measurement meet at this JSON file.
import { writeFileSync } from 'node:fs'
import { sentencesForSpeech } from '../packages/helper/assets/speech.js'

const REPLY =
  '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。' +
  '你要是还想继续测别的内容，直接说一声就行。' +
  '另外朗读的后端已经换掉了，现在这句话是新的服务合成的。'

const pieces = sentencesForSpeech(REPLY)
const out = process.argv[2] ?? new URL('reply_sentences.json', import.meta.url)
writeFileSync(out, JSON.stringify({ reply: REPLY, pieces }, null, 2), 'utf8')
console.log(`${pieces.length} pieces from ${REPLY.length} chars`)
for (const [i, p] of pieces.entries()) console.log(`  ${i + 1}. ${p.length} chars  ${p.slice(0, 24)}…`)
