import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMemePicker, gifDurationMs, MEME_DEFAULTS } from '../src/memes.ts'

/** A picker that always takes the first candidate, so a burst frame is predictable. */
const first = () => 0

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

  it('resolves the drag face like the other named states', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({ dir: root, drag: { file: 'fish.gif' } }))
      assert.equal(await createMemePicker(config).drag(), 'data:image/gif;base64,R0lG')
      await writeFile(config, JSON.stringify({ dir: root, drag: { file: 'PNGTuber 闲置.gif' } }))
      assert.equal(await createMemePicker(config).drag(), 'data:image/gif;base64,R0lGOA==')
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

  it('hands over both frames with the length of their own animation', async () => {
    const root = await pack()
    try {
      const config = join(root, 'memes.json')
      await writeFile(config, JSON.stringify({
        dir: root,
        skit: { gapMs: [5_000, 9_000], times: [2, 4], file: 'in.gif', interject: 'fish.gif' },
      }))
      assert.deepEqual(await createMemePicker(config).skit(), {
        gapMs: [5_000, 9_000],
        times: [2, 4],
        file: { src: `data:image/gif;base64,${tinyGif().toString('base64')}`, ms: 500 },
        interject: { src: 'data:image/gif;base64,R0lG', ms: 1_200 },
      })
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
