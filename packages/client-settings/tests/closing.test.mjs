import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')

const page = readFileSync(join(root, 'packages/client-settings/client.js'), 'utf8')
const ball = readFileSync(join(root, 'packages/helper/assets/voice-closing.js'), 'utf8')

/** Read a `const NAME = [ ... ]` string array out of either file, quotes and commas and all. */
function listIn(source, name) {
  const match = source.match(new RegExp(`const ${name} = (?:Object\\.freeze\\()?\\[([^\\]]*)\\]`))
  assert.ok(match, `${name} is missing`)
  // The ball's list carries line comments, and one of them quotes "we're": strip comments first
  // or the quote inside a comment parses as an entry.
  const body = match[1].split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
  return [...body.matchAll(/'([^']*)'/g)].map((entry) => entry[1])
}

// The page cannot import the ball's module, so the list is copied. A phrase added on one side and
// not the other is a phrase that stops ending a conversation, silently and only for some users.
describe('the main window ends an exchange on the same words as the ball', () => {
  for (const name of ['CLOSING_PHRASES', 'LEADING_FILLERS', 'TRAILING_PARTICLES']) {
    it(`keeps ${name} identical`, () => {
      assert.deepEqual(listIn(page, name), listIn(ball, name))
    })
  }
})

describe('a closing phrase is matched by equality, after trimming', () => {
  // The matcher is lifted out of the page's own source: the copy that runs is the copy tested.
  const start = page.indexOf('const CLOSING_PHRASES = [')
  const end = page.indexOf('// While the agent is answering')
  assert.ok(start > 0 && end > start, 'the closing block moved')
  const isClosingPhrase = new Function(`${page.slice(start, end)}\nreturn isClosingPhrase`)()

  it('accepts the phrases a person actually says', () => {
    for (const said of ['先这样', '先这样吧', '嗯，那先这样吧', '没你事了。', '你可以退了', 'That\'s all.', 'ok bye']) {
      assert.equal(isClosingPhrase(said), true, said)
    }
  })

  it('leaves ordinary speech alone', () => {
    for (const said of ['就这样把它删掉', '先', '结束了吗', '帮我把这个文件删了', '', '   ']) {
      assert.equal(isClosingPhrase(said), false, JSON.stringify(said))
    }
  })
})
