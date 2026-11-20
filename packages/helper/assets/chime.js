/**
 * The hourly chime: what it says, and whether this hour is one it may say it on.
 *
 * The ball is a voice object, so the one thing it can offer without being asked is the time. What
 * makes that worth having rather than annoying is the narrowness of the promise: once an hour, on
 * the hour, in a sentence short enough to be heard and forgotten.
 *
 * Three rules live here rather than in the page, because all three are decisions rather than
 * wiring, and each of them has a failure that is audible:
 *
 *   * **On the hour, or not at all.** A timer that wakes late — a sleeping machine, a busy event
 *     loop — must stay quiet rather than say "three" at 3:04. A time is only worth hearing while
 *     it is still right.
 *   * **Never at night.** The quiet window is what keeps the feature from being switched off the
 *     first time it wakes somebody. `quietFrom`/`quietTo` may wrap midnight (22 → 6).
 *   * **Only when the ball is welcome to talk.** Whether a reply, a dictation or a waiting voice
 *     turn is in the way is the page's knowledge, so that arrives as `canSpeak`; this file only
 *     decides whether the hour and the settings allow it in the first place.
 *
 * @module chime
 */

/**
 * What a missing or unusable `orb-chime.json` means.
 *
 * On, with night silent. On because the voice ball is already something the user opted into by
 * installing it, and a chime nobody ever heard is a feature that cannot be judged; night silent
 * because 4 AM is the fastest way to get the whole idea switched off.
 */
export const CHIME_DEFAULTS = Object.freeze({ enabled: true, quietFrom: 0, quietTo: 7 })

/**
 * How late a timer may wake and still count as the hour it was armed for.
 *
 * Ninety seconds covers a machine that was asleep across the hour by a little; past it the clock
 * has visibly moved on, and a wrong time is worse than none.
 */
export const CHIME_LATE_MS = 90_000

/** Shipping hours run 0–23; the window ends are hour numbers, `24` meaning "the end of the day". */
export const CHIME_HOUR_MAX = 24

const NUMERALS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']

/**
 * The chime settings, clamped to what the page can act on.
 *
 * A host that predates this field sends nothing and the defaults stand; a hand-edited
 * `orb-chime.json` with an out-of-range hour is corrected here rather than trusted, so the page
 * and the helper's own launch value cannot disagree about when silence starts.
 * @param {unknown} value the settings as they arrived
 * @returns {{ enabled: boolean, quietFrom: number, quietTo: number }}
 */
export function normalizeChime(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ...CHIME_DEFAULTS }
  }
  const record = /** @type {{ enabled?: unknown, quietFrom?: unknown, quietTo?: unknown }} */ (value)
  const hour = (candidate, fallback) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.min(CHIME_HOUR_MAX, Math.max(0, Math.round(candidate)))
    : fallback
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : CHIME_DEFAULTS.enabled,
    quietFrom: hour(record.quietFrom, CHIME_DEFAULTS.quietFrom),
    quietTo: hour(record.quietTo, CHIME_DEFAULTS.quietTo),
  }
}

/**
 * Whether `hour` falls inside the silent window.
 *
 * The window may wrap midnight: `quietFrom: 22, quietTo: 6` silences 22, 23, 0–5. An empty window —
 * `quietFrom === quietTo` — silences nothing, which is how a user who wants every hour including
 * night says so.
 * @param {number} hour 0–23, the hour that is striking now
 * @param {{ quietFrom: number, quietTo: number }} settings
 */
export function isQuietHour(hour, settings) {
  const from = settings.quietFrom
  const to = settings.quietTo
  if (from === to) return false
  if (from < to) return hour >= from && hour < to
  return hour >= from || hour < to
}

/** The hour as a person says it out loud, not as a clock prints it. */
export function hourlyLine(hour) {
  const value = ((Math.round(hour) % 24) + 24) % 24
  if (value === 0) return '现在是零点整。'
  const part = value < 12 ? '上午' : value === 12 ? '中午' : value < 18 ? '下午' : '晚上'
  const onClock = value % 12
  return `现在是${part}${NUMERALS[onClock === 0 ? 12 : onClock]}点整。`
}

/** The instant the next whole hour begins, computed from the wall clock rather than by adding an hour. */
export function nextHourAt(now) {
  const next = new Date(now)
  next.setMinutes(0, 0, 0)
  next.setHours(next.getHours() + 1)
  return next.getTime()
}

/**
 * Whether the chime should speak this hour.
 *
 * One place for the whole decision, so the page's timer only has to ask: is it the hour, is the
 * clock still near it, is the window open, is anything else talking. `canSpeak` is the page's own
 * answer — a reply being read, a dictation in flight, a voice turn waiting — and false means the
 * chime loses this hour rather than talking over it.
 * @param {{ hour: number, settings: object, now: number, at: number, canSpeak: boolean }} state
 */
export function chimeWanted({ hour, settings, now, at, canSpeak }) {
  if (settings.enabled !== true) return false
  if (now - at > CHIME_LATE_MS) return false
  if (isQuietHour(hour, settings)) return false
  return canSpeak === true
}
