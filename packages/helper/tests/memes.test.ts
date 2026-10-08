import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemePicker, gifDurationMs, MEME_DEFAULTS } from '../src/memes.ts'

/** A picker that always takes the first candidate, so a burst frame is predictable. */
const first = () => 0

/** The `data:` URL of the pack's `in.gif`. Named apart from the `fish.gif` one below: both start with
 *  `R0lG`, so a literal written by hand reads as either and a wrong expectation hides in the noise. */
const inUrl = () => `data:image/gif;base64,${tinyGif().toString('base64')}`

/** The `data:` URL of the pack's `fish.gif`, three bytes of GIF header and nothing to parse. */
const fishUrl = 'data:image/gif;base64,R0lG'

/** A two-frame GIF89a whose delays are 30 and 20 hundredths of a second. */
function tinyGif(): Buffer {
  const gce = (delay: number) => Buffer.from([0x21, 0xf9, 0x04, 0x00, delay & 0xff, (delay >> 8) & 0xff, 0x00, 0x00])
  const image = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00])
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
    Buffer.from([0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
    gce(30), image, gce(20), image,
    Buffer.from([0x3b]),
  ])
}

async function pack(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
  const nested = join(root, '大肥鱼表情包整合', '大肥鱼表情包整合')
  await mkdir(nested, { recursive: true })
  await writeFile(join(nested, 'fish.gif'), Buffer.from([0x47, 0x49, 0x46]))
  await writeFile(join(nested, 'PNGTuber 闲置.gif'), Buffer.from([0x47, 0x49, 0x46, 0x38]))
  await writeFile(join(nested, 'in.gif'), tinyGif())
  await writeFile(join(root, 'notes.txt'), 'not an image')
  return root
}

describe('resting loop', () => {
  it('stays off without a config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      assert.equal(await createMemePicker(join(root, 'memes.json')).idle(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('finds a bare file name anywhere in the pack', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, idle: { file: 'PNGTuber 闲置.gif' } }))
      assert.equal(await createMemePicker(config).idle(), 'data:image/gif;base64,R0lGOA==')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes a path below the folder, an absolute path, or nothing', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      const nested = '大肥鱼表情包整合/大肥鱼表情包整合/fish.gif'
      const absolute = join(root, '大肥鱼表情包整合', '大肥鱼表情包整合', 'fish.gif')
      for (const file of [nested, absolute]) {
        await writeFile(config, JSON.stringify({ dir: root, idle: { file } }))
        assert.equal(await createMemePicker(config).idle(), 'data:image/gif;base64,R0lG', file)
      }
      for (const idle of [{ file: 'gone.gif' }, { file: 'notes.txt' }, { file: '' }, { file: 'fish.gif', enabled: false }]) {
        await writeFile(config, JSON.stringify({ dir: root, idle }))
        assert.equal(await createMemePicker(config).idle(), null, JSON.stringify(idle))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('hover frame', () => {
  it('resolves its named file and stays off when unnamed', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, hover: { file: 'PNGTuber 闲置.gif' } }))
      assert.deepEqual(await createMemePicker(config).hover(), {
        src: 'data:image/gif;base64,R0lGOA==',
        intro: null,
      })
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).hover(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('carries a one-pass intro with the length of its own animation', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, hover: { file: 'PNGTuber 闲置.gif', intro: 'in.gif' } }))
      const frames = await createMemePicker(config).hover()
      assert.equal(frames?.src, 'data:image/gif;base64,R0lGOA==')
      assert.equal(frames?.intro?.src, `data:image/gif;base64,${tinyGif().toString('base64')}`)
      assert.equal(frames?.intro?.ms, 500)
      await writeFile(config, JSON.stringify({ dir: root, hover: { file: 'PNGTuber 闲置.gif', intro: 'gone.gif' } }))
      assert.deepEqual((await createMemePicker(config).hover())?.intro, null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a GIF length from its frame delays and falls back on anything else', () => {
    assert.equal(gifDurationMs(tinyGif()), 500)
    assert.equal(gifDurationMs(Buffer.from([0x47, 0x49, 0x46])), 1200)
    assert.equal(gifDurationMs(Buffer.from('GIF89a', 'latin1')), 1200)
    assert.equal(gifDurationMs(Buffer.from('nope'), 42), 42)
  })
})

describe('typing frame', () => {
  it('stays off without a config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      const picker = createMemePicker(join(root, 'memes.json'))
      assert.equal(await picker.typing(), null)
      assert.equal(await picker.reply(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the carry as a loop plus an optional pickup', async () => {
    // `drag` answers in the same shape `hover` does: the loop to wear, and the clip to play once
    // when the ball is first picked up. `intro` is what separates the two, and an unnamed one is
    // `null` rather than an empty string so the page has one thing to test.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, drag: { file: 'fish.gif' } }))
      assert.deepEqual(await createMemePicker(config).drag(), {
        src: 'data:image/gif;base64,R0lG',
        intro: null,
      })
      await writeFile(config, JSON.stringify({ dir: root, drag: { file: 'PNGTuber 闲置.gif' } }))
      assert.deepEqual(await createMemePicker(config).drag(), {
        src: 'data:image/gif;base64,R0lGOA==',
        intro: null,
      })
      // A named pickup is resolved and timed like the loop is, so the page can schedule the
      // hand-off without a second round trip.
      await writeFile(config, JSON.stringify({
        dir: root, drag: { file: 'fish.gif', intro: 'PNGTuber 闲置.gif' },
      }))
      const withIntro = await createMemePicker(config).drag()
      assert.equal(withIntro?.intro?.src, 'data:image/gif;base64,R0lGOA==')
      assert.equal(typeof withIntro?.intro?.ms, 'number')
      // A pickup that does not resolve costs only the pickup; the carry still has its loop.
      await writeFile(config, JSON.stringify({
        dir: root, drag: { file: 'fish.gif', intro: 'gone.gif' },
      }))
      assert.deepEqual(await createMemePicker(config).drag(), {
        src: 'data:image/gif;base64,R0lG',
        intro: null,
      })
      // Neither file resolving is the only case that answers `null`.
      await writeFile(config, JSON.stringify({ dir: root, drag: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).drag(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the release frame with the length of its own animation', async () => {
    // The release is a one-shot, so unlike `drag` it has to come back carrying a duration: the
    // page holds the face for exactly one pass and the step counter restarts the GIF.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, drop: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).drop(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      // A bare name is matched anywhere in the pack, the same way every other slot resolves.
      await writeFile(config, JSON.stringify({ dir: root, drop: { file: 'PNGTuber 闲置.gif' } }))
      assert.notEqual(await createMemePicker(config).drop(), null)
      await writeFile(config, JSON.stringify({ dir: root, drop: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).drop(), null)
      // Unnamed means no release face at all, which is what a profile written before this slot
      // existed looks like.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).drop(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the click reaction with the length of its own animation', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, click: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).click(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      await writeFile(config, JSON.stringify({ dir: root, click: { file: 'fish.gif' } }))
      assert.deepEqual(await createMemePicker(config).click(), {
        src: 'data:image/gif;base64,R0lG',
        ms: 1_200,
      })
      await writeFile(config, JSON.stringify({ dir: root, click: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).click(), null)
      await writeFile(config, JSON.stringify({ dir: root, click: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).click(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the arrival as the clips it plays, in order, one pass each', async () => {
    // The greeting is one-shots like the click reaction, so each clip comes back carrying the
    // length of its own animation: the page holds it for one pass, and the step counter is what
    // restarts the next GIF from its first frame.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, arrive: { files: ['in.gif', 'fish.gif'] } }))
      assert.deepEqual(await createMemePicker(config).arrive(), [
        { src: `data:image/gif;base64,${tinyGif().toString('base64')}`, ms: 500 },
        { src: 'data:image/gif;base64,R0lG', ms: 1_200 },
      ])
      // A bare name is matched anywhere in the pack, the same way every other slot resolves — which
      // is what lets a file one folder down from the configured `dir` be named at all.
      await writeFile(config, JSON.stringify({ dir: root, arrive: { files: ['PNGTuber 闲置.gif'] } }))
      assert.deepEqual(await createMemePicker(config).arrive(), [
        { src: 'data:image/gif;base64,R0lGOA==', ms: 1_200 },
      ])
      // A name that resolves to nothing costs its own clip and no more: losing the wave file must
      // not cost the arrival in front of it.
      await writeFile(config, JSON.stringify({ dir: root, arrive: { files: ['in.gif', 'gone.gif'] } }))
      assert.deepEqual(await createMemePicker(config).arrive(), [
        { src: `data:image/gif;base64,${tinyGif().toString('base64')}`, ms: 500 },
      ])
      // Unnamed means no greeting: a profile written before this slot existed keeps the silent
      // startup it always had, exactly like the click reaction and the finished-task frame.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).arrive(), null)
      await writeFile(config, JSON.stringify({ dir: root, arrive: { enabled: false, files: ['in.gif'] } }))
      assert.equal(await createMemePicker(config).arrive(), null)
      await writeFile(config, JSON.stringify({ dir: root, arrive: { files: ['gone.gif'] } }))
      assert.equal(await createMemePicker(config).arrive(), null)
      await writeFile(config, JSON.stringify({ dir: root, arrive: { files: [] } }))
      assert.equal(await createMemePicker(config).arrive(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the docked arrival as one clip per edge, with the length of its own animation', async () => {
    // The strip's clip is a single gesture, not a greeting sequence, so it resolves like the click
    // reaction: one file, one pass, and the length of that pass. The page cuts it there because the
    // file repeats itself and nothing else would say where one pass ends. The loop it hands over to,
    // when the pack names one, travels beside it rather than replacing it.
    //
    // Both edges come back from one read. They are the same clip unless the pack names a `left`, which
    // it does because the two edges want mirrored pictures: the ball sits against the edge looking into
    // the screen.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      const shared = { file: { src: inUrl(), ms: 500 }, loop: null }
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).dockArrive(), { left: shared, right: shared })
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'fish.gif' } }))
      assert.deepEqual(await createMemePicker(config).dockArrive(), {
        left: { file: { src: fishUrl, ms: 1_200 }, loop: null },
        right: { file: { src: fishUrl, ms: 1_200 }, loop: null },
      })
      // A loop named beside the entrance rides along as its own src, unresolved only when the file it
      // names is not in the pack — the entrance still plays then, and the ball drops to the idle.
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'in.gif', loop: 'PNGTuber 闲置.gif' } }))
      const looped = await createMemePicker(config).dockArrive()
      assert.deepEqual(looped?.right.file, { src: inUrl(), ms: 500 })
      assert.equal(looped?.right.loop, 'data:image/gif;base64,R0lGOA==')
      assert.deepEqual(looped?.left, looped?.right, 'the left edge plays the shared clip when it is named none')
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'in.gif', loop: 'gone.gif' } }))
      assert.equal((await createMemePicker(config).dockArrive())?.right.loop, null)

      // The left edge's own picture, which is the whole point of the key: one clip for each way round,
      // and a loop of its own beside it.
      await writeFile(config, JSON.stringify({
        dir: root,
        dockArrive: { file: 'fish.gif', loop: 'PNGTuber 闲置.gif', left: 'in.gif' },
      }))
      const perEdge = await createMemePicker(config).dockArrive()
      assert.deepEqual(perEdge?.left.file, { src: inUrl(), ms: 500 })
      assert.equal(perEdge?.left.loop, 'data:image/gif;base64,R0lGOA==', 'the left loop falls back to the shared one')
      assert.deepEqual(perEdge?.right.file, { src: fishUrl, ms: 1_200 })
      assert.equal(perEdge?.right.loop, 'data:image/gif;base64,R0lGOA==')

      await writeFile(config, JSON.stringify({
        dir: root,
        dockArrive: { file: 'fish.gif', left: 'PNGTuber 闲置.gif', leftLoop: 'in.gif' },
      }))
      const ownLoop = await createMemePicker(config).dockArrive()
      assert.equal(ownLoop?.left.loop, inUrl(), 'a leftLoop replaces the shared loop on that edge')
      assert.equal(ownLoop?.right.loop, null, 'and leaves the other edge without one')

      // A left clip that is named but cannot be read leaves the strip answering: it plays the shared
      // clip rather than going silent, because the clip is a gift and a missing file is not a reason
      // for the strip to stop greeting a hand.
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'in.gif', left: 'gone.gif' } }))
      assert.deepEqual((await createMemePicker(config).dockArrive())?.left, shared)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers nothing for the docked arrival when the pack names no clip', async () => {
    // Every shape of "there is no clip here" is the same answer, and the strip keeps its drag out of the
    // dock whichever one it is: the slot is named in a profile written for an older build, it is
    // misspelled, the file is gone, or the pack turns it off.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).dockArrive(), null)
      await writeFile(config, JSON.stringify({ dir: root, dockArive: { file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).dockArrive(), null, 'a misspelled slot must not resolve')
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).dockArrive(), null)
      await writeFile(config, JSON.stringify({ dir: root, dockArrive: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).dockArrive(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the poor face together with the balance line that turns it on', async () => {
    // The pair travels as one answer: the page cannot decide anything with only half of it, so a slot
    // that names a file but no usable line is refused rather than defaulted.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'PNGTuber 闲置.gif', below: 5 } }))
      assert.deepEqual(await createMemePicker(config).poor(), {
        src: 'data:image/gif;base64,R0lGOA==',
        below: 5,
      })
      // Cents are kept, and an absent line takes the shipped one.
      await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'fish.gif', below: 12.345 } }))
      assert.deepEqual(await createMemePicker(config).poor(), { src: 'data:image/gif;base64,R0lG', below: 12.35 })
      await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'fish.gif' } }))
      assert.deepEqual(await createMemePicker(config).poor(), { src: 'data:image/gif;base64,R0lG', below: 5 })
      // `null` is how a hand-edited JSON says "left out", so it takes the shipped line with an absent
      // one; a line that is *there* but unusable becomes zero, which no balance is below — a broken
      // amount must not be the thing that turns a face on.
      await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'fish.gif', below: null } }))
      assert.deepEqual(await createMemePicker(config).poor(), { src: 'data:image/gif;base64,R0lG', below: 5 })
      for (const below of [-1, '5']) {
        await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'fish.gif', below } }))
        assert.deepEqual(await createMemePicker(config).poor(), { src: 'data:image/gif;base64,R0lG', below: 0 },
          JSON.stringify(below))
      }
      // Unnamed, disabled, or a file that resolves to nothing: no poor face at all.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).poor(), null)
      await writeFile(config, JSON.stringify({ dir: root, poor: { enabled: false, file: 'fish.gif' } }))
      assert.equal(await createMemePicker(config).poor(), null)
      await writeFile(config, JSON.stringify({ dir: root, poor: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).poor(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the finished-task frame with the length of its own animation', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, done: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).done(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      // Off unless asked for: an absent or disabled slot must not surprise anyone with a GIF.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).done(), null)
      await writeFile(config, JSON.stringify({ dir: root, done: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).done(), null)
      await writeFile(config, JSON.stringify({ dir: root, done: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).done(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the failure face with the length of its own animation', async () => {
    // The other reading of the finished-task edge, and off unless the pack asks for it: the shipped
    // default cannot name a file, because the clip this face wants lives in somebody's meme pack and
    // not in this package. A profile that names none keeps the old behaviour — no face change.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, fail: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).fail(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      await writeFile(config, JSON.stringify({ dir: root, fail: { file: 'PNGTuber 闲置.gif' } }))
      assert.deepEqual(await createMemePicker(config).fail(), {
        src: 'data:image/gif;base64,R0lGOA==',
        ms: 1_200,
      })
      // Unnamed, disabled, or a file that is not there: `null`, which is the whole fail-safe. The
      // ball then shows nothing new on a failed run rather than a broken image or an exception.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).fail(), null)
      await writeFile(config, JSON.stringify({ dir: root, fail: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).fail(), null)
      await writeFile(config, JSON.stringify({ dir: root, fail: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).fail(), null)
      await writeFile(config, JSON.stringify({ dir: root, fail: { file: 'notes.txt' } }))
      assert.equal(await createMemePicker(config).fail(), null)
      await writeFile(config, JSON.stringify({ dir: root, fail: { file: '' } }))
      assert.equal(await createMemePicker(config).fail(), null)
      await writeFile(config, JSON.stringify({ dir: root, fail: '哭 1.gif' }))
      assert.equal(await createMemePicker(config).fail(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the question face with the length of its own animation', async () => {
    // The slot the ball wears while the agent waits for an answer. Same shape as the finished-task
    // frame and the wake reaction, and off unless the pack asks for it, so a profile that names no
    // question file is not surprised by one.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, ask: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).ask(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      // Unnamed, disabled, missing from disk, or a name that is not an image at all: `null` every
      // time, which is what the page reads as "keep the face you had" rather than as an error.
      for (const ask of [undefined, { enabled: false, file: 'in.gif' }, { file: 'gone.gif' }, { file: 'notes.txt' }]) {
        await writeFile(config, JSON.stringify(ask === undefined ? { dir: root } : { dir: root, ask }))
        assert.equal(await createMemePicker(config).ask(), null, JSON.stringify(ask))
      }
      // A slot written as something that is not an object at all is a broken hand edit, not a crash.
      await writeFile(config, JSON.stringify({ dir: root, ask: 'in.gif' }))
      assert.equal(await createMemePicker(config).ask(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the wake reaction with the length of its own animation', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, wake: { file: 'in.gif' } }))
      assert.deepEqual(await createMemePicker(config).wake(), {
        src: `data:image/gif;base64,${tinyGif().toString('base64')}`,
        ms: 500,
      })
      await writeFile(config, JSON.stringify({ dir: root, wake: { file: 'fish.gif' } }))
      assert.deepEqual(await createMemePicker(config).wake(), {
        src: 'data:image/gif;base64,R0lG',
        ms: 1_200,
      })
      // Off unless asked for, exactly like the click reaction and the finished-task frame: a
      // wake word that fires all day must not start playing a GIF nobody configured.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).wake(), null)
      await writeFile(config, JSON.stringify({ dir: root, wake: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).wake(), null)
      await writeFile(config, JSON.stringify({ dir: root, wake: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).wake(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the reply, thinking and tool frames like the other named states', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        typing: { file: 'fish.gif' },
        reply: { file: 'in.gif' },
        thinking: { file: 'PNGTuber 闲置.gif' },
        tool: { file: 'fish.gif' },
      }))
      const picker = createMemePicker(config)
      assert.equal(await picker.typing(), 'data:image/gif;base64,R0lG')
      assert.equal(await picker.reply(), `data:image/gif;base64,${tinyGif().toString('base64')}`)
      assert.equal(await picker.thinking(), 'data:image/gif;base64,R0lGOA==')
      assert.equal(await picker.tool(), 'data:image/gif;base64,R0lG')
      await writeFile(config, JSON.stringify({ dir: root, reply: { enabled: false, file: 'in.gif' } }))
      const off = createMemePicker(config)
      assert.equal(await off.reply(), null)
      assert.equal(await off.thinking(), null)
      assert.equal(await off.tool(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a face for a named tool, and leaves the shared face in charge of the rest', async () => {
    // This replaced a slot that gave one hard-coded tool a face of its own. The mapping is the general form of
    // the same idea, and the property worth pinning is unchanged: a pack that says nothing about a tool must
    // leave the shared face in charge of it, which is only true if the picker answers `null` rather than
    // `tool()`'s file — answering with the shared file would make a listed tool and an unlisted one
    // indistinguishable to a caller that only ever sees a URL.
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, tool: { file: 'fish.gif', tools: { read: 'PNGTuber 闲置.gif' } } }))
      assert.equal(await createMemePicker(config).toolNamed('read'), 'data:image/gif;base64,R0lGOA==')

      const bare = join(root, 'bare.json')
      await writeFile(bare, JSON.stringify({ dir: root, tool: { file: 'fish.gif' } }))
      assert.equal(await createMemePicker(bare).toolNamed('read'), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves the dictation pose as a loop, not a timed one-shot', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, voice: { file: 'in.gif' } }))
      // A `data:` URL rather than a `{ src, ms }` pair: the pose has to last as long as the
      // microphone is open, and nobody knows that when it starts.
      assert.equal(await createMemePicker(config).voice(), `data:image/gif;base64,${tinyGif().toString('base64')}`)
      // Off unless asked for, like every other slot: waking the ball must not put a GIF on the
      // screen that the pack never named.
      await writeFile(config, JSON.stringify({ dir: root }))
      assert.equal(await createMemePicker(config).voice(), null)
      await writeFile(config, JSON.stringify({ dir: root, voice: { enabled: false, file: 'in.gif' } }))
      assert.equal(await createMemePicker(config).voice(), null)
      await writeFile(config, JSON.stringify({ dir: root, voice: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).voice(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves its named file next to the resting loop', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        idle: { file: 'fish.gif' },
        typing: { file: 'PNGTuber 闲置.gif' },
      }))
      const picker = createMemePicker(config)
      assert.equal(await picker.typing(), 'data:image/gif;base64,R0lGOA==')
      assert.equal(await picker.idle(), 'data:image/gif;base64,R0lG')
      await writeFile(config, JSON.stringify({ dir: root, typing: { file: 'gone.gif' } }))
      assert.equal(await createMemePicker(config).typing(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('idle skit', () => {
  it('stays off without a config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      assert.equal(await createMemePicker(join(root, 'memes.json')).skit(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('hands over the whole plan with the length each frame animates for', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { gapMs: [5_000, 9_000], times: [2, 4], file: 'in.gif', interject: 'fish.gif' },
      }))
      const plan = await createMemePicker(config, first).skit()
      assert.deepEqual(plan, {
        gapMs: [5_000, 9_000],
        times: [2, 4],
        // The one file this slot used to name is the pool, spelled both ways for the two page versions.
        files: [{ kind: 'single', frame: { src: inUrl(), ms: 500 } }],
        item: { kind: 'single', frame: { src: inUrl(), ms: 500 } },
        interject: { src: fishUrl, ms: 1_200 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes a run of files as one item, played in order', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      const run = ['in.gif', 'fish.gif', 'gone.gif']
      // A run beside a single clip: three items, one of which is a scripted sequence. A name inside
      // the run that is gone costs only itself — the run still plays, in the order written.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: [run, 'in.gif'], times: [2, 2] } }))
      const plan = await createMemePicker(config, first).skit()
      assert.deepEqual(plan?.files, [
        { kind: 'sequence', frames: [{ src: inUrl(), ms: 500 }, { src: fishUrl, ms: 1_200 }] },
        { kind: 'single', frame: { src: inUrl(), ms: 500 } },
      ])
      // Drawing the run hands over the run, and nothing to break it up: its last clip is what ends it.
      assert.equal(plan?.item.kind, 'sequence')
      assert.deepEqual(plan?.item.frames.map((frame) => frame.ms), [500, 1_200])
      assert.equal(plan?.interject, null)
      // A run is a *group*, not a longer pool: one item, whatever it holds. `0.99` reaches the single
      // clip beside it, and that one still gets the interjection that belongs to a repeated clip.
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { files: [run, 'in.gif'], times: [2, 2], interject: 'fish.gif' },
      }))
      const single = await createMemePicker(config, () => 0.99).skit()
      assert.equal(single?.item.kind, 'single')
      assert.equal(single?.interject?.src, fishUrl)
      // A run whose every clip is gone is not an item, and a pool left empty is no skit at all.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: [['gone.gif', 'also-gone.gif']] } }))
      assert.equal(await createMemePicker(config).skit(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reaches every entry of a several-clip pool, and reads the singular spelling as a pool of one', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { file: 'gone.gif', files: ['in.gif', 'fish.gif', 'gone.gif'], times: [2, 2], interject: 'fish.gif' },
      }))
      // Every clip the page can rotate to is handed over, in config order, and one that is gone only
      // costs itself. (`file` is missing here on purpose: the list is the only thing that names the
      // pool, and it still has to turn the slot on.)
      const plan = await createMemePicker(config, first).skit()
      assert.deepEqual(plan?.files, [
        { kind: 'single', frame: { src: inUrl(), ms: 500 } },
        { kind: 'single', frame: { src: fishUrl, ms: 1_200 } },
      ])
      // A page written before `files` existed plays the drawn item: it has to be one of the pool's own.
      assert.deepEqual(plan?.item, plan?.files[0])
      assert.deepEqual((await createMemePicker(config, () => 0.99).skit())?.files, plan?.files)
      // `file` on its own is a pool of one — the spelling every config used before this slot took a list.
      await writeFile(config, JSON.stringify({ dir: root, skit: { file: 'in.gif' } }))
      const single = await createMemePicker(config, first).skit()
      assert.equal(single?.files.length, 1)
      assert.deepEqual(single?.item, { kind: 'single', frame: { src: inUrl(), ms: 500 } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never hands over an interjection that is the clip it interrupts', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      // Two clips in both pools with different lengths, so which entry each draw took is legible from
      // the frame alone: `in.gif` is 500 ms and `fish.gif` is 1200 ms. The slot names its interjection
      // twice — once as `interject`, once first in `interjects` — and the two spellings are one
      // candidate, so `0.99` takes the last entry and `first` the first.
      const skit = (file, interjects, interject) => JSON.stringify({
        dir: root,
        skit: { files: [file], interject, interjects },
      })
      const inGif = skit('in.gif', ['fish.gif', 'in.gif'], 'fish.gif')
      const fishGif = skit('fish.gif', ['in.gif', 'fish.gif'], 'in.gif')
      // The interjection drawn is the clip the skit repeats: `0.99` takes `in.gif` for the middle and
      // the pool is a single file, so the repeat is `in.gif` too. It would play right before that clip,
      // which is one pose twice in a row, so the plan drops it and the skit runs its repeats alone.
      await writeFile(config, inGif)
      assert.equal((await createMemePicker(config, () => 0.99).skit())?.interject, null)
      // The same with the other clip, so neither is special-cased.
      await writeFile(config, fishGif)
      assert.equal((await createMemePicker(config, () => 0.99).skit())?.interject, null)
      // A different clip is an interruption and is handed over as always, with the length of its own
      // animation. This is the case that catches an over-eager rule: one that simply dropped the entry
      // the pool's own file repeats would pass the two cases above and fail here.
      await writeFile(config, inGif)
      const fishFrame = await createMemePicker(config, first).skit()
      assert.equal(fishFrame?.interject?.src, fishUrl)
      assert.equal(fishFrame?.interject?.ms, 1_200)
      await writeFile(config, fishGif)
      const inFrame = await createMemePicker(config, first).skit()
      assert.equal(inFrame?.interject?.src, inUrl())
      assert.equal(inFrame?.interject?.ms, 500)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes several interjections and falls back to the singular one', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      // No interjection at all: nothing to draw from, and nothing to hand over.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: ['fish.gif'], interjects: ['gone.gif'] } }))
      assert.equal((await createMemePicker(config, first).skit())?.interject, null)
      // Two live entries in the list, and the lead is unrelated to both, so the draw is the list's:
      // `first` takes `in.gif` and `0.99` takes the second `in.gif`, neither of which is the clip being
      // interrupted. A listed name that is gone (`gone.gif`) only costs itself.
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { files: ['fish.gif'], interjects: ['in.gif', 'gone.gif', 'in.gif'] },
      }))
      assert.equal((await createMemePicker(config, () => 0.99).skit())?.interject?.src, inUrl())
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { files: ['in.gif'], interjects: ['fish.gif', 'gone.gif'] },
      }))
      assert.equal((await createMemePicker(config, first).skit())?.interject?.src, fishUrl)
      // The singular name is still a candidate when the slot also lists its own — the list is added to
      // it, not a replacement for it — and the same name in both places is one candidate, not two.
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { files: ['in.gif'], interject: 'fish.gif', interjects: ['fish.gif', 'gone.gif'] },
      }))
      assert.equal((await createMemePicker(config, first).skit())?.interject?.src, fishUrl)
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { files: ['in.gif'], interject: 'fish.gif', interjects: ['gone.gif'] },
      }))
      assert.equal((await createMemePicker(config, first).skit())?.interject?.src, fishUrl)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('survives a missing pool, a missing interjection, and a disabled slot', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      // Every name gone: the ball keeps resting rather than throwing.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: ['gone.gif', 'gone2.gif'], interject: 'fish.gif' } }))
      assert.equal(await createMemePicker(config).skit(), null)
      // A pool with one live entry still plays, with or without its interjection.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: ['fish.gif', 'gone.gif'], interject: 'gone.gif' } }))
      const spared = await createMemePicker(config, first).skit()
      assert.equal(spared?.files.length, 1)
      assert.equal(spared?.interject, null)
      // `enabled: false` keeps the slot off however it is spelled.
      await writeFile(config, JSON.stringify({ dir: root, skit: { enabled: false, files: ['fish.gif', 'in.gif'] } }))
      assert.equal(await createMemePicker(config).skit(), null)
      // And nothing named at all is still off.
      await writeFile(config, JSON.stringify({ dir: root, skit: { files: [] } }))
      assert.equal(await createMemePicker(config).skit(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops the interjection, survives a missing file, and clamps the ranges', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, skit: { file: 'fish.gif' } }))
      const plain = await createMemePicker(config).skit()
      assert.equal(plain?.interject, null)
      assert.deepEqual(plain?.times, [3, 5])
      assert.deepEqual(plain?.gapMs, [120_000, 300_000])
      await writeFile(config, JSON.stringify({ dir: root, skit: { file: 'gone.gif', interject: 'fish.gif' } }))
      assert.equal(await createMemePicker(config).skit(), null)
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { file: 'fish.gif', times: [0, 99], gapMs: [10, 20] },
      }))
      const clamped = await createMemePicker(config).skit()
      assert.deepEqual(clamped?.times, [1, 12])
      assert.deepEqual(clamped?.gapMs, [5_000, 5_000])
      await writeFile(config, JSON.stringify({ dir: root, skit: { file: 'fish.gif', enabled: false } }))
      assert.equal(await createMemePicker(config).skit(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('nap timeline', () => {
  it('stays off without a config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      const picker = createMemePicker(join(root, 'memes.json'))
      assert.equal(await picker.sleep(), null)
      assert.equal(await picker.sleepFrame(0), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('counts only the files that resolve and reads frames on demand', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        sleep: { afterMs: 5_000, stepMs: 7_000, files: ['fish.gif', 'in.gif', 'gone.gif'] },
      }))
      const picker = createMemePicker(config)
      assert.deepEqual(await picker.sleep(), { afterMs: 5_000, stepMs: 7_000, count: 2, yawn: null })
      assert.equal(await picker.sleepFrame(0), 'data:image/gif;base64,R0lG')
      assert.equal(await picker.sleepFrame(1), `data:image/gif;base64,${tinyGif().toString('base64')}`)
      for (const index of [2, -1, 1.5]) assert.equal(await picker.sleepFrame(index), null, String(index))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clamps the durations and stays off for an empty list', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, sleep: { afterMs: 10, stepMs: 'soon', files: ['fish.gif'] } }))
      assert.deepEqual(await createMemePicker(config).sleep(), { afterMs: 1_000, stepMs: 300_000, count: 1, yawn: null })
      await writeFile(config, JSON.stringify({ dir: root, sleep: { files: [] } }))
      assert.equal(await createMemePicker(config).sleep(), null)
      await writeFile(config, JSON.stringify({ dir: root, sleep: { files: ['fish.gif'], enabled: false } }))
      assert.equal(await createMemePicker(config).sleep(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens the nap with the length and repetition count of the yawn', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        sleep: { afterMs: 5_000, stepMs: 7_000, files: ['fish.gif'], yawn: { file: 'in.gif', times: 2 } },
      }))
      const picker = createMemePicker(config)
      // `in.gif` runs 30 + 20 hundredths of a second, and that is what the pre-roll is sized on.
      assert.deepEqual(await picker.sleep(), { afterMs: 5_000, stepMs: 7_000, count: 1, yawn: { ms: 500, times: 2 } })
      assert.equal(await picker.yawn(), `data:image/gif;base64,${tinyGif().toString('base64')}`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('leaves the yawn out when it is off or its file is missing', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      const sleep = { afterMs: 5_000, stepMs: 7_000, files: ['fish.gif'] }
      for (const yawn of [
        { enabled: false, file: 'in.gif', times: 2 },
        { file: 'gone.gif', times: 2 },
        { file: '', times: 2 },
        {},
      ]) {
        await writeFile(config, JSON.stringify({ dir: root, sleep: { ...sleep, yawn } }))
        const picker = createMemePicker(config)
        assert.equal((await picker.sleep()).yawn, null, JSON.stringify(yawn))
        assert.equal(await picker.yawn(), null, JSON.stringify(yawn))
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('plays the yawn at least once and defaults to two passes', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      const sleep = { afterMs: 5_000, stepMs: 7_000, files: ['fish.gif'] }
      for (const [times, expected] of [[0, 1], [-3, 1], [1.4, 1], [2.6, 3], [99, 12], ['two', 2], [null, 2]]) {
        await writeFile(config, JSON.stringify({ dir: root, sleep: { ...sleep, yawn: { file: 'in.gif', times } } }))
        const plan = await createMemePicker(config).sleep()
        assert.equal(plan.yawn.times, expected, `times: ${JSON.stringify(times)}`)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the yawn off when the whole nap is off', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        sleep: { enabled: false, files: ['fish.gif'], yawn: { file: 'in.gif', times: 2 } },
      }))
      const picker = createMemePicker(config)
      assert.equal(await picker.sleep(), null)
      assert.equal(await picker.yawn(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('meme bursts', () => {
  it('stays off without a config file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      const picker = createMemePicker(join(root, 'memes.json'), first)
      assert.deepEqual(await picker.schedule(), MEME_DEFAULTS)
      assert.equal(await picker.next(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads frames from a nested pack as data URLs', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ enabled: true, dir: root }))
      const picker = createMemePicker(config, first)
      const schedule = await picker.schedule()
      assert.deepEqual(schedule.frames, MEME_DEFAULTS.frames)
      assert.equal(schedule.enabled, true)
      assert.deepEqual(schedule, { ...MEME_DEFAULTS, enabled: true })
      assert.match((await picker.next()) ?? '', /^data:image\/gif;base64,R0lG$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the ball as it was while the config says off', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ enabled: false, dir: root }))
      const picker = createMemePicker(config, first)
      assert.equal(await picker.next(), null)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('takes one folder or a list and ignores entries that are not folders', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ enabled: true, dir: ['', root, root, 7, join(root, 'gone')] }))
      const picker = createMemePicker(config, first)
      assert.match((await picker.next()) ?? '', /^data:image\/gif;base64,/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a config file a Windows editor saved with a BOM', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, `\uFEFF${JSON.stringify({ enabled: true, dir: root })}`)
      const picker = createMemePicker(config, first)
      assert.equal((await picker.schedule()).enabled, true)
      assert.match((await picker.next()) ?? '', /^data:image\/gif;base64,/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('orders, clamps, and defaults the schedule pairs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orb-memes-'))
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        enabled: true,
        dir: root,
        gapMs: [90_000, 20_000],
        holdMs: [10, 20],
        frames: [99, 'two'],
      }))
      assert.deepEqual(await createMemePicker(config).schedule(), {
        enabled: true,
        gapMs: [20_000, 90_000],
        holdMs: [120, 120],
        frames: MEME_DEFAULTS.frames,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('survives a listed file that disappeared before it was read', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ enabled: true, dir: root }))
      const nested = join(root, '大肥鱼表情包整合', '大肥鱼表情包整合')
      await writeFile(join(nested, 'gone.gif'), Buffer.from([0x47, 0x49, 0x46]))
      const sequence = [0, 0.99]
      let step = 0
      const picker = createMemePicker(config, () => sequence[step++ % sequence.length])
      await picker.next()
      await rm(join(nested, 'gone.gif'))
      assert.match((await picker.next()) ?? '', /^data:image\/gif;base64,/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
