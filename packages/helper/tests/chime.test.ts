/**
 * The hourly chime: what it says, and when it is allowed to say it.
 *
 * Two failures are audible. A wrong hour ("现在是下午三点整" at 15:04) is worse than silence, and a
 * chime at 4 AM is the fastest way to get the whole feature switched off. Both are decided here
 * rather than in the page, so both are pinned below — including the wrap-around window a user
 * actually wants ("quiet from 22 to 6"), which is the case a naive `hour >= from && hour < to`
 * gets exactly backwards.
 *
 * The wording cases are the hours a listener notices: midnight, the 上午/下午/晚上 switches, noon,
 * and the 十二 the clock cannot print.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CHIME_DEFAULTS,
  CHIME_LATE_MS,
  chimeWanted,
  hourlyLine,
  isQuietHour,
  nextHourAt,
  normalizeChime,
} from '../assets/chime.js'

const here = dirname(fileURLToPath(import.meta.url))
const shell = readFileSync(join(here, '..', 'assets', 'shell.js'), 'utf8')
const main = readFileSync(join(here, '..', 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(here, '..', 'preload.cjs'), 'utf8')
const orb = readFileSync(join(here, '..', '..', 'host', 'src', 'orb.ts'), 'utf8')

describe('the time, said out loud', () => {
  it('names the hour the way a clock face reads it', () => {
    assert.equal(hourlyLine(0), '现在是零点整。')
    assert.equal(hourlyLine(1), '现在是上午一点整。')
    assert.equal(hourlyLine(9), '现在是上午九点整。')
    assert.equal(hourlyLine(11), '现在是上午十一点整。')
    // Noon is its own word: "上午十二点" is not something anybody says.
    assert.equal(hourlyLine(12), '现在是中午十二点整。')
    assert.equal(hourlyLine(13), '现在是下午一点整。')
    assert.equal(hourlyLine(17), '现在是下午五点整。')
    assert.equal(hourlyLine(18), '现在是晚上六点整。')
    assert.equal(hourlyLine(23), '现在是晚上十一点整。')
  })

  it('says 十二, not 零, for the hours a twelve-hour clock wraps', () => {
    // The numerals table runs 零 … 十二, and both 12 and 0 are the wrap point; getting the index
    // wrong reads "现在是中午零点整", which is the one sentence in the feature nobody would believe.
    assert.equal(hourlyLine(12).includes('零点'), false)
    assert.equal(hourlyLine(0).includes('十二'), false)
  })

  it('normalizes an hour that came from somewhere odd', () => {
    // The page hands this a `Date`-derived hour, so this is only a safety net — but a negative or
    // 25th hour must not index off the end of the table and speak "undefined".
    assert.equal(hourlyLine(25), hourlyLine(1))
    assert.equal(hourlyLine(-1), hourlyLine(23))
  })
})

describe('the quiet window', () => {
  it('silences the hours inside a window that does not wrap', () => {
    const settings = { quietFrom: 1, quietTo: 7 }
    assert.equal(isQuietHour(0, settings), false)
    assert.equal(isQuietHour(1, settings), true)
    assert.equal(isQuietHour(6, settings), true)
    // The end is exclusive: 7 is when the first chime of the morning is due.
    assert.equal(isQuietHour(7, settings), false)
    assert.equal(isQuietHour(23, settings), false)
  })

  it('silences a window that wraps midnight', () => {
    const settings = { quietFrom: 22, quietTo: 6 }
    assert.equal(isQuietHour(21, settings), false)
    assert.equal(isQuietHour(22, settings), true)
    assert.equal(isQuietHour(23, settings), true)
    assert.equal(isQuietHour(0, settings), true)
    assert.equal(isQuietHour(5, settings), true)
    assert.equal(isQuietHour(6, settings), false)
    assert.equal(isQuietHour(12, settings), false)
  })

  it('treats an empty window as no silence at all', () => {
    // `quietFrom === quietTo` is how a user says "every hour, including night"; the alternative
    // reading — silence for the whole day — is a feature that never speaks and looks broken.
    for (const hour of [0, 6, 12, 23]) {
      assert.equal(isQuietHour(hour, { quietFrom: 0, quietTo: 0 }), false)
      assert.equal(isQuietHour(hour, { quietFrom: 24, quietTo: 24 }), false)
    }
  })
})

describe('whether this hour is a chime', () => {
  const settings = { enabled: true, quietFrom: 0, quietTo: 7 }
  const at = Date.UTC(2026, 0, 1, 9, 0, 0)

  it('fires on the hour, with the window open and nothing else talking', () => {
    assert.equal(chimeWanted({ hour: 9, settings, now: at, at, canSpeak: true }), true)
    // A timer that woke a little late still counts: sleep and a busy event loop both look like this.
    assert.equal(chimeWanted({ hour: 9, settings, now: at + 30_000, at, canSpeak: true }), true)
  })

  it('stays quiet when the clock has already moved on', () => {
    // Past the limit the minute hand is visibly somewhere else, and a time is only useful while it
    // is still right.
    assert.equal(chimeWanted({ hour: 9, settings, now: at + CHIME_LATE_MS + 1, at, canSpeak: true }), false)
  })

  it('stays quiet when the switch is off, the hour is silent, or something else is talking', () => {
    assert.equal(chimeWanted({ hour: 9, settings: { ...settings, enabled: false }, now: at, at, canSpeak: true }), false)
    assert.equal(chimeWanted({ hour: 3, settings, now: at, at, canSpeak: true }), false)
    // `canSpeak` false is a reply being read, a dictation in flight, or a voice turn waiting.
    assert.equal(chimeWanted({ hour: 9, settings, now: at, at, canSpeak: false }), false)
  })

  it('treats a missing `canSpeak` as "no"', () => {
    // The page passes `maySpeakUp()`, which is a boolean; anything that is not `true` must not be
    // read as permission to talk over the user.
    assert.equal(chimeWanted({ hour: 9, settings, now: at, at }), false)
  })
})

describe('the next hour', () => {
  it('lands exactly on the top of the hour, from any minute inside this one', () => {
    const now = new Date(2026, 0, 15, 8, 30, 15).getTime()
    assert.equal(nextHourAt(now), new Date(2026, 0, 15, 9, 0, 0).getTime())
  })

  it('rolls across midnight without drifting', () => {
    // Recomputed from the wall clock rather than by adding an hour, which is what keeps a chime
    // that fired late from marking every hour afterwards late too.
    const now = new Date(2026, 0, 15, 23, 59, 30).getTime()
    assert.equal(nextHourAt(now), new Date(2026, 0, 16, 0, 0, 0).getTime())
  })

  it('lands on the hour itself when called exactly on the hour', () => {
    const now = new Date(2026, 0, 15, 9, 0, 0).getTime()
    assert.equal(nextHourAt(now), new Date(2026, 0, 15, 10, 0, 0).getTime())
  })
})

describe('the settings the file carries', () => {
  it('falls back to on, silent at night, when nothing usable arrived', () => {
    assert.deepEqual(normalizeChime(undefined), { ...CHIME_DEFAULTS })
    assert.deepEqual(normalizeChime(null), { ...CHIME_DEFAULTS })
    assert.deepEqual(normalizeChime('off'), { ...CHIME_DEFAULTS })
    assert.deepEqual(normalizeChime([1, 2]), { ...CHIME_DEFAULTS })
  })

  it('clamps the window rather than trusting a hand edit', () => {
    // A window of 31 silences nothing while looking like it silences everything; a fractional hour
    // cannot compare equal to an integer one. Both become the nearest usable hour.
    assert.deepEqual(normalizeChime({ enabled: false, quietFrom: 31, quietTo: -4 }), {
      enabled: false,
      quietFrom: 24,
      quietTo: 0,
    })
    assert.deepEqual(normalizeChime({ quietFrom: 5.6, quietTo: '8' }), {
      enabled: true,
      quietFrom: 6,
      quietTo: CHIME_DEFAULTS.quietTo,
    })
  })

  it('keeps the switch independent of the window', () => {
    assert.deepEqual(normalizeChime({ enabled: false }), { enabled: false, quietFrom: 0, quietTo: 7 })
    assert.deepEqual(normalizeChime({ quietFrom: 22 }), { enabled: true, quietFrom: 22, quietTo: 7 })
  })
})

describe('the wiring that makes the chime audible', () => {
  it('runs the timer on the page, whatever the profile holds', () => {
    // The chime used to be gated on a `?hourly=off` URL parameter the helper never set, so the
    // switch was dead code and the feature was always on. The profile is the only source now.
    assert.match(shell, /import \{[^}]*chimeWanted[^}]*\} from '\.\/chime\.js'/)
    assert.match(shell, /scheduleHourly\(\)/)
    assert.equal(shell.includes('hourlyOff'), false)
    assert.match(shell, /chimeWanted\(\{/)
    assert.match(shell, /speaker\.speak\(hourlyLine\(/)
  })

  it('plays a sample when the switch goes on, so the row is checkable at once', () => {
    assert.match(shell, /function applyChime\(settings\)/)
    assert.match(shell, /if \(chime\.enabled && !wasEnabled\) previewChime\(\)/)
    assert.match(shell, /api\.onChime\(/)
  })

  it('yields the hour to anything already talking or listening', () => {
    // The page answers `canSpeak` itself. `active` rather than `waiting` is the important part: a
    // chime during `opening` is recorded by the microphone, and during `armed` it hands the exchange
    // a turn nobody asked for — both worse than skipping one hour.
    assert.match(shell, /if \(continuousVoice\.active\) return false/)
    assert.match(shell, /if \(dictationPhase !== undefined\) return false/)
    assert.match(shell, /if \(speaker\.state\(\)\.speaking\) return false/)
  })

  it('travels from the host through the helper to the page', () => {
    // A settings field that stops at either process is silent: the menu would flip a checkbox that
    // changes nothing, which is exactly how this feature read before the switch existed.
    assert.match(orb, /chime: this\.store\.chime\(\)/)
    assert.match(orb, /record\.type === 'set-chime'/)
    assert.match(main, /type: 'set-chime'/)
    assert.match(main, /win\.webContents\.send\('orb:chime'/)
    assert.match(preload, /onChime\(callback\)/)
    assert.match(preload, /ipcRenderer\.on\('orb:chime'/)
  })
})
