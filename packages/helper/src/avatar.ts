/**
 * Avatar messages from the host.
 * The host owns what the avatar is; the helper only turns that into something the
 * ball page can load: the uploaded bytes, or nothing (the GIF that ships with the page).
 *
 * There used to be a third kind — `preset`, a relative path into `assets/avatars` — for the six
 * built-in animations the settings page offered. That gallery is gone (2026-11-20), so a host that
 * still sent a preset string would be sending something this process must not trust: the branch is
 * deleted rather than kept for compatibility, and an unknown kind falls back to the shipped image.
 */

export type AvatarChoice =
  | { kind: 'default' }
  | { kind: 'custom'; version: number }

export function readAvatarChoice(record: Record<string, unknown>): AvatarChoice {
  const version = typeof record.version === 'number' && Number.isFinite(record.version) ? Math.trunc(record.version) : 0
  if (record.kind === 'custom' && version > 0) return { kind: 'custom', version }
  return { kind: 'default' }
}
