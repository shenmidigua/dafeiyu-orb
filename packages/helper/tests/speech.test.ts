import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { plainForSpeech, sentencesForSpeech } from '../assets/speech.js'

const here = dirname(fileURLToPath(import.meta.url))
const speechSource = readFileSync(join(here, '../assets/speech.js'), 'utf8')
const shellSource = readFileSync(join(here, '../assets/shell.js'), 'utf8')

/**
 * Cut one method out of the Speaker class by brace matching.
 *
 * `plainForSpeech` is a plain export and can be imported, but the interesting behaviour — when a
 * reply is spoken, and what happens when a newer one arrives — lives in methods that close over
 * `fetch`, `Audio` and timers. Reaching those by importing would mean standing up a DOM, so the
 * source is cut and run against stubs instead. An unbalanced brace ends the cut early, which fails
 * the assertions loudly rather than passing a wrong body.
 *
 * The body starts after the parameter list closes, not at the first `{`: a destructured first
 * parameter (`configure({ enabled }) = {})`) is itself a balanced brace pair, and starting there
 * would cut the signature off and return a body of `{}`.
 */
function method(name: string): string {
  // Anchored to the start of a line, and allowing the `async` modifier. Both matter: `run` calls
  // `request(index + 1)` at a deeper indent, and a bare `indexOf('  request(')` finds that call
  // instead of the method — which it did, and which made two tests read the wrong body and fail.
  const pattern = new RegExp(`^  (?:async )?${name}\\(`, 'm')
  const match = pattern.exec(speechSource)
  assert.notEqual(match, null, `${name} is missing from speech.js`)
  const head = match.index
  const open = speechSource.indexOf('{', paramListEnd(speechSource, head))
  let depth = 0
  for (let i = open; i < speechSource.length; i += 1) {
    if (speechSource[i] === '{') depth += 1
    else if (speechSource[i] === '}') {
      depth -= 1
      if (depth === 0) return speechSource.slice(head, i + 1)
    }
  }
  throw new Error(`${name} never closes`)
}

/** Index just past the `)` that closes a parameter list, skipping braces inside it. */
function paramListEnd(source: string, head: number): number {
  let depth = 0
  for (let i = source.indexOf('(', head); i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  throw new Error('parameter list never closes')
}

describe('plainForSpeech', () => {
  it('drops fenced code but says something rather than leaving a hole', () => {
    const spoken = plainForSpeech('前面\n```js\nconst x = 1\n```\n后面')
    assert.equal(spoken.includes('const'), false, 'code should not be read aloud')
    assert.ok(spoken.includes('代码块'), `expected a placeholder, got ${JSON.stringify(spoken)}`)
    assert.ok(spoken.includes('前面') && spoken.includes('后面'), 'surrounding prose must survive')
  })

  it('keeps a link label and drops its target', () => {
    const spoken = plainForSpeech('看 [这个文档](https://example.com/a/very/long/path) 就行')
    assert.ok(spoken.includes('这个文档'), 'the label is what the listener needs')
    assert.equal(spoken.includes('example.com'), false)
  })

  it('unwraps emphasis rather than leaving stray markers', () => {
    // The markers go and nothing is inserted — `**重要**的事` becomes `重要的事`, with no space
    // left behind where the asterisks were.
    assert.equal(plainForSpeech('**重要**的事'), '重要的事')
    assert.equal(plainForSpeech('这是 `代码`'), '这是 代码')
  })

  it('removes list bullets and heading hashes', () => {
    assert.equal(plainForSpeech('## 标题\n- 第一项\n- 第二项'), '标题\n第一项\n第二项')
  })

  it('returns empty for input that is not a string', () => {
    assert.equal(plainForSpeech(undefined), '')
    assert.equal(plainForSpeech(null), '')
    assert.equal(plainForSpeech(42), '')
  })
})

describe('Speaker.speak gating', () => {
  it('refuses text shorter than the minimum', () => {
    // The gate lives inside speak() rather than the caller so nothing can bypass it.
    assert.ok(method('speak').includes('MIN_CHARS'), 'speak must check MIN_CHARS')
    assert.ok(method('speak').includes('this.enabled'), 'speak must check the enabled flag')
  })

  it('cancels in-flight audio before starting a new reply', () => {
    const body = method('speak')
    const cancelAt = body.indexOf('this.cancel()')
    // The request itself now goes out from `request()`, one sentence at a time, so what has to
    // follow the cancel is the queue rather than a single fetch.
    const queueAt = body.indexOf('this.run(')
    assert.ok(cancelAt !== -1, 'speak must cancel the previous reply')
    assert.ok(queueAt !== -1, 'speak must hand the sentences to the queue')
    assert.ok(cancelAt < queueAt, 'cancel has to happen before the new queue starts')
  })

  it('checks the generation before touching audio, so a stale reply cannot play', () => {
    // Every stage that can outlive the request it belongs to has to check. The queue, the fetch and
    // the playback each wait on something slow, and any of the three can come back after a newer
    // reply has taken over — which is why the guard moved here from the single-path `speak`.
    for (const name of ['request', 'playAndWait']) {
      assert.ok(method(name).includes('generation !== this.generation'),
        `${name} can outlive its request, so it must check the generation`)
    }
    const guards = (method('run').match(/generation !== this\.generation/g) ?? []).length
    assert.ok(guards >= 1, `the queue must not settle a stale reply, found ${guards}`)
  })
})

describe('sentencesForSpeech', () => {
  it('leaves a short reply in one piece', () => {
    assert.deepEqual(sentencesForSpeech('今天天气不错。'), ['今天天气不错。'])
  })

  it('merges short neighbours instead of paying a round trip for each', () => {
    // Three four-character sentences are one request, not three: the joins would be audible and
    // three short waits do not overlap into anything.
    assert.equal(sentencesForSpeech('好的。行。可以。').length, 1)
  })

  it('cuts a long reply into several, and never past the cap', () => {
    const text = '第一句话写得比较长一些，长到足够自己成段了。第二句话也不短，同样够长了。第三句话还是有点长度的。'
    const sentences = sentencesForSpeech(text)
    assert.ok(sentences.length >= 2, `expected a split, got ${JSON.stringify(sentences)}`)
    for (const sentence of sentences) {
      assert.ok(sentence.length <= 120, `over the cap: ${JSON.stringify(sentence)}`)
    }
  })

  it('loses nothing and invents nothing', () => {
    // The whole reply has to survive the cut: a dropped clause is a lie told by omission. This is
    // the assertion that caught the first version losing its terminators.
    const text = '这是第一句。这是第二句，带个逗号。最后一句！'
    const rejoined = sentencesForSpeech(text).join('')
    assert.equal(rejoined.replace(/\s+/g, ''), text.replace(/\s+/g, ''))
  })

  it('breaks up a reply that has no punctuation at all', () => {
    // Otherwise one unpunctuated paragraph would recreate exactly the wait this exists to remove.
    const sentences = sentencesForSpeech('字'.repeat(300))
    assert.ok(sentences.length >= 3, `expected several pieces, got ${sentences.length}`)
    for (const sentence of sentences) assert.ok(sentence.length <= 120)
  })

  it('returns nothing when there is nothing to say', () => {
    assert.deepEqual(sentencesForSpeech(''), [])
    assert.deepEqual(sentencesForSpeech('。。。'), [])
    assert.deepEqual(sentencesForSpeech('   \n  '), [])
  })

  it('never yields an empty or whitespace-only piece', () => {
    // An empty piece would still be a round trip, and the service rejects empty text outright.
    for (const text of ['。  第一句。  。第二句。', '\n\n第一句\n\n第二句\n\n', '  ']) {
      for (const sentence of sentencesForSpeech(text)) {
        assert.notEqual(sentence.trim(), '', `an empty piece came out of ${JSON.stringify(text)}`)
      }
    }
  })
})

describe('the queue plays a sentence ahead', () => {
  it('asks for the next sentence after this one arrives, and before it plays', () => {
    // This is why the reply is spoken in pieces rather than in one request. If the next sentence
    // were only asked for once this one had finished playing, the wait between sentences would be
    // the full round trip and the queue would be no faster than asking for everything at once.
    //
    // Both bounds are load-bearing, and both were measured rather than reasoned about. Starting the
    // request *before* awaiting this one — which this used to do — leaves two syntheses in flight at
    // once, and the far side cannot do that: the log fills with `IncompleteRead` retries and a pair
    // that takes about 5 s each when serialised took 9.1 s + 21.6 s while overlapped.
    const body = method('run')
    const awaitAt = body.indexOf('await request(index)')
    const prefetchAt = body.indexOf('request(index + 1)')
    const playAt = body.indexOf('await this.playAndWait(')
    assert.ok(awaitAt !== -1, 'the queue must await the current sentence')
    assert.ok(prefetchAt !== -1, 'and must still prefetch the next one')
    assert.ok(playAt !== -1, 'and must play this one')
    assert.ok(awaitAt < prefetchAt, 'the next request must not overlap this one\'s synthesis')
    assert.ok(prefetchAt < playAt, 'but it must start before this one plays, or nothing overlaps')
  })

  it('reads the rest of the reply when one sentence cannot be produced', () => {
    // A reply that stopped dead half way through is what this used to do, and it is what the user
    // saw: the first sentence played, the second never did, and nothing was said about either. The
    // reason is on screen now, so the sentences after the failure are still worth reading.
    const body = method('run')
    assert.ok(body.includes('failures'), 'one failed sentence must not end the run by itself')
    assert.ok(body.includes('continue'), 'the loop has to move on to the next sentence')
  })

  it('still gives up when the service itself is gone', () => {
    // Two failures in a row is not bad luck, and asking for the remaining sentences would only delay
    // the same message by another round trip each.
    assert.ok(method('run').includes('failures >= 2'))
  })

  it('returns the button to rest however the run ends', () => {
    // `fail` no longer clears the playing state, because a failed sentence is survivable now. The
    // queue owns that transition instead, which means it has to happen on every way out — a normal
    // finish, a cancellation, and a service that gave up half way.
    assert.ok(method('run').includes('finally'), 'settling has to survive an early return')
    assert.ok(method('run').includes('this.settle(generation)'), 'and has to settle the speaker')
    assert.ok(method('settle').includes('generation !== this.generation'),
      'settling must not blank a newer reply')
  })

  it('plays them in order, one at a time', () => {
    assert.ok(method('run').includes('await this.playAndWait('),
      'a reply spoken out of order is worse than one not spoken at all')
  })

  it('settles a cancelled sentence instead of waiting on it forever', () => {
    // A cancelled `<audio>` never fires `ended`, so the queue would sit on that await for the rest
    // of the session and hold the element, the blob URL and the key with it.
    const body = method('cancel')
    assert.ok(body.includes('this.playingResolve'), 'cancel must settle the sentence in flight')
    assert.ok(method('playAndWait').includes('this.playingResolve = finish'),
      'and playAndWait has to publish the resolver cancel will reach for')
  })
})

describe('the page speaks only a finished reply', () => {
  /** Cut a top-level function out of the page module by brace matching; see `method` above. */
  function pageFunction(name: string): string {
    // Most transcript helpers are plain `function` declarations. `syncSpeechButtons` has to be an
    // assignment instead: the speaker is constructed during module evaluation, before the transcript
    // scope ever runs, so that binding is created at the top of the file and assigned over later.
    // Both shapes are accepted here so the extractor is not tied to which one a given helper uses.
    const head = [`  function ${name}(`, `  ${name} = function (`].reduce(
      (found, needle) => (found === -1 ? shellSource.indexOf(needle) : found),
      -1,
    )
    assert.notEqual(head, -1, `${name} is missing from shell.js`)
    const open = shellSource.indexOf('{', paramListEnd(shellSource, head))
    let depth = 0
    for (let i = open; i < shellSource.length; i += 1) {
      if (shellSource[i] === '{') depth += 1
      else if (shellSource[i] === '}') {
        depth -= 1
        if (depth === 0) return shellSource.slice(head, i + 1)
      }
    }
    throw new Error(`${name} never closes`)
  }

  it('only speaks on the running true→false edge', () => {
    const body = pageFunction('speakWhenFinished')
    assert.ok(body.includes("block?.kind !== 'assistant'"), 'only assistant replies are spoken')
    assert.ok(body.includes('was !== true'), 'a block seen already finished must not be spoken')
    // The key travels with the text: without it the button under that reply cannot become a stop
    // control, and every message would look identical while one of them plays.
    assert.ok(body.includes('speaker.speak(block.text, block.key)'),
      'the raw block text and its key are what get spoken')
  })

  it('leaves the button as the only way in when autoPlay is off', () => {
    const body = pageFunction('speakWhenFinished')
    assert.ok(body.includes('speaker.autoPlay'), 'the automatic path must consult autoPlay')
    assert.ok(body.includes('if (!speaker.autoPlay) return'),
      'autoPlay off must skip the automatic read entirely')
  })

  it('fires the hook for every block update', () => {
    // Believing the test above depends on this: if the call were removed, the gate would never run
    // and the assertions would still pass on the function body alone.
    const upsert = pageFunction('upsertBlock')
    assert.ok(upsert.includes('speakWhenFinished(block)'), 'upsertBlock must call the hook')
  })

  it('remembers running per key so history reloads do not re-speak', () => {
    assert.ok(shellSource.includes('const speechRunningBefore = new Map()'),
      'the previous running state must be remembered per block')
  })
})

describe('the per-message play button', () => {
  /** Cut a top-level function out of the page module by brace matching; see `method` above. */
  function pageFunction(name: string): string {
    // Most transcript helpers are plain `function` declarations. `syncSpeechButtons` has to be an
    // assignment instead: the speaker is constructed during module evaluation, before the transcript
    // scope ever runs, so that binding is created at the top of the file and assigned over later.
    // Both shapes are accepted here so the extractor is not tied to which one a given helper uses.
    const head = [`  function ${name}(`, `  ${name} = function (`].reduce(
      (found, needle) => (found === -1 ? shellSource.indexOf(needle) : found),
      -1,
    )
    assert.notEqual(head, -1, `${name} is missing from shell.js`)
    const open = shellSource.indexOf('{', paramListEnd(shellSource, head))
    let depth = 0
    for (let i = open; i < shellSource.length; i += 1) {
      if (shellSource[i] === '{') depth += 1
      else if (shellSource[i] === '}') {
        depth -= 1
        if (depth === 0) return shellSource.slice(head, i + 1)
      }
    }
    throw new Error(`${name} never closes`)
  }

  it('sits in the assistant action row next to copy', () => {
    // The row is created once per reply, so this is the only place a button can be born with it.
    const upsert = pageFunction('upsertBlock')
    assert.ok(upsert.includes("actions.className = 'am-actions'"), 'sanity: the row still exists')
    assert.ok(upsert.includes('messageSpeakButton('), 'the button must be appended on creation')
    assert.ok(upsert.includes('speaker.enabled'), 'and only while the feature is on')
  })

  it('toggles between play and stop for the reply being read', () => {
    const body = pageFunction('messageSpeakButton')
    assert.ok(body.includes('speaker.isSpeaking(key)'), 'the button asks the speaker, it does not track')
    assert.ok(body.includes('speaker.cancel()'), 'pressing it again stops the audio')
    assert.ok(body.includes('speaker.speak(getText(), key)'), 'and pressing it starts this reply')
  })

  it('removes every button when the feature is switched off, and adds them when switched on', () => {
    const sync = pageFunction('syncSpeechButtons')
    assert.ok(sync.includes('button.remove()'), 'off must take the buttons away, not just disable them')
    assert.ok(sync.includes('state.enabled === false'), 'and only for an explicit off')
    assert.ok(shellSource.includes('addSpeakButtons()'),
      'switching on with replies already on screen must reach them')
  })

  it('repaints from the speaker itself, so no path can leave a stale play icon', () => {
    // Every route into playback — a click, an automatic reply, a service that died — goes through
    // the speaker, so wiring the listener there is what makes the guarantee hold.
    const start = shellSource.indexOf('new Speaker(')
    assert.notEqual(start, -1, 'sanity: the speaker is still constructed')
    // The whole construction expression, not just its first line: it carries several options now.
    const construction = shellSource.slice(start, shellSource.indexOf('})', start))
    assert.ok(construction.includes('syncSpeechButtons'),
      'the speaker must be wired to the button sync')
    assert.ok(construction.includes('ensureSpeech'),
      'and given a way to ask for the service to be started')
  })

  it('binds the button sync at module scope before the speaker is built', () => {
    // The regression this guards, and why it has to be spelled out: a `function` declaration inside
    // the transcript scope is invisible during module evaluation, so the listener the speaker calls
    // straight away threw a ReferenceError, the whole page module stopped, and the ball rendered its
    // CSS but answered nothing — no drag, no hover, no click. It is also invisible to every other
    // test here, because they run extracted function bodies rather than the module itself.
    const binder = shellSource.indexOf('let syncSpeechButtons')
    const construction = shellSource.indexOf('new Speaker(')
    assert.notEqual(binder, -1, 'the sync must be bound at module scope, not only inside a scope below')
    assert.ok(binder < construction, 'the binding must exist before the speaker is constructed')
    assert.ok(shellSource.includes('syncSpeechButtons = function ('),
      'the transcript scope assigns the real implementation over that binding')
  })

  it('says why nothing was heard, rather than failing silently', () => {
    // Pressing play with no service behind it used to do nothing at all: the speaker recorded a
    // reason and no one ever read it. A button that silently does nothing is indistinguishable from
    // a broken one, which is exactly how it was reported.
    const sync = pageFunction('syncSpeechButtons')
    assert.ok(sync.includes('speechStatusText(state)'), 'the state must be turned into a message')
    assert.ok(sync.includes('status.textContent = text'), 'and written where the user can see it')
    // The status line is shared with dictation and both can be live, so it may only be cleared by
    // whoever wrote it last — a bare "nothing to say" would wipe the other writer's text.
    assert.ok(sync.includes('status.textContent === speechStatus'),
      'a shared status line must only be cleared by its own writer')
  })

  it('words every failure code it can be handed', () => {
    const mapper = pageFunction('speechStatusText')
    for (const code of ['offline', 'timeout', 'autoplay', 'playback', 'server']) {
      assert.ok(mapper.includes(`'${code}'`), `nothing words the ${code} failure`)
    }
    assert.ok(mapper.includes("state.notice === 'starting'"),
      'the starting-up wait needs wording too, and it is not a failure')
  })

  it('drops a removed reply from the button map', () => {
    const remove = pageFunction('removeBlock')
    assert.ok(remove.includes('speechButtons.delete(key)'),
      'a strong map would otherwise keep the detached node alive for the whole session')
  })
})

describe('speaker configuration', () => {
  it('starts off, so a profile without a speech service shows no buttons', () => {
    assert.ok(shellSource.includes('enabled: false') || speechSource.includes('this.enabled = false'),
      'the default has to be off')
  })

  it('cancels playback the moment the feature is switched off', () => {
    const body = method('configure')
    assert.ok(body.includes('if (!enabled) this.cancel()'),
      'leaving a half-read answer playing after an off-switch would be the surprising half')
  })

  it('ignores a blank endpoint rather than pointing the speaker at nothing', () => {
    const body = method('setEndpoint')
    assert.ok(body.includes("endpoint.trim() === ''"), 'an empty string must not become the endpoint')
  })

  it('tracks which reply is playing, and clears it when playback ends', () => {
    const state = method('state')
    assert.ok(state.includes('key: this.currentKey'), 'the page needs to know which button to swap')
    // Clearing moved from the single `play` to the end of the queue: with the reply spoken one
    // sentence at a time it is not finished until the last of them is, and releasing the key any
    // earlier would put the play triangle back while the answer was still being read. It then moved
    // once more, out of the loop and into `settle` — because a sentence the service refused is no
    // longer a reason for the run to end, so `fail` cannot be what clears the key either, and the
    // `finally` in `run` is what guarantees it happens on every way out.
    assert.ok(method('settle').includes("this.currentKey = ''"),
      'finishing the queue must release the key')
    assert.ok(method('run').includes('this.settle(generation)'),
      'and the queue is what has to call it, on every exit')
  })
})

describe('the page is allowed to reach the service', () => {
  it('lets connect-src reach the local TTS port', () => {
    // The regression this guards, and it is the one that actually broke read-aloud: the ball's page
    // is a `file://` document, so a `fetch` to the local service is cross-origin, and `connect-src`
    // refused it outright. Every synthesis then failed as "Failed to fetch" while the service was
    // up and healthy — the ball blamed the service, and no amount of starting it could help.
    const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')
    const csp = /connect-src([^"]*)"/.exec(html)
    assert.ok(csp !== null, 'sanity: the page still declares connect-src')
    assert.match(csp[1], /http:\/\/127\.0\.0\.1:\*/,
      'the local service must be reachable, on whatever port the settings name')
  })

  it('plays from a blob, because the media policy admits nothing else', () => {
    // This is why the audio cannot simply be streamed from wherever it was synthesised, and why the
    // reply has to be cut into sentences instead: `media-src` allows `'self'` and `blob:` only, so
    // an `<audio>` pointed at a remote URL is blocked, and `connect-src` would have blocked the
    // fetch that discovered that URL. Everything therefore goes through the local proxy, and the
    // wait for a whole long reply arriving as one blob is what the queue exists to avoid.
    const html = readFileSync(join(here, '../assets/floating.html'), 'utf8')
    const csp = /media-src([^"]*)"/.exec(html)
    assert.ok(csp !== null, 'sanity: the page still declares media-src')
    assert.match(csp[1], /blob:/, 'the blob URL the speaker plays must stay allowed')
    assert.ok(method('playAndWait').includes('URL.createObjectURL'),
      'playback goes through a blob URL')
  })
})

describe('a service that is not up yet', () => {
  it('asks the host to start it, and retries once', () => {
    // Moved from `speak` to `request` when the reply became a queue: the fetch lives there now, and
    // so does the only moment at which a dead service can still be fixed invisibly.
    const body = method('request')
    assert.ok(body.includes('this.ensure'), 'a connection failure must be handed to the host')
    assert.ok(body.includes('allowRevive'), 'only the first sentence may ask for a start')
    assert.ok(body.includes('this.request(text, generation, false)'),
      'and the retry must be the last one, or a dead service is retried forever')
    assert.ok(body.includes('isOffline(error)'),
      'only a failure to connect is worth retrying — a service that answered badly is not')
  })

  it('does not ask for a start once the reply is already half spoken', () => {
    // Reviving mid-reply would replay that sentence over the one already playing, and a failure
    // there is a real problem rather than a cold start. `speak` passes true only for the first.
    assert.ok(method('run').includes('index === 0'),
      'only the first sentence of the queue may revive the service')
  })

  it('says it is starting, so a slow start is not mistaken for a dead button', () => {
    const body = method('request')
    assert.ok(body.includes("this.notice = 'starting'"), 'the wait has to be visible')
    assert.ok(method('state').includes('notice: this.notice'), 'and has to reach the page')
  })

  it('reports why it failed as a code, not as a sentence', () => {
    // The wording belongs to the ball, which is bilingual; a sentence baked in here would show up
    // in the wrong language. Every failure path has to name a code the caller can translate.
    for (const code of ['offline', 'timeout', 'autoplay', 'playback', 'server']) {
      assert.ok(speechSource.includes(`'${code}'`), `no path reports ${code}`)
    }
    assert.ok(method('fail').includes('this.lastError = code'),
      'and every path must go through the one place that records it')
  })

  it('hands the host whatever the service said, for wording it cannot predict', () => {
    const state = method('state')
    assert.ok(state.includes('detail: this.lastDetail'),
      'a server error message is worth showing verbatim')
  })
})
