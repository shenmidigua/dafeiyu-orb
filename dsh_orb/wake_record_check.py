"""The clip recorder's four promises, asserted against a fake endpoint.

`wake_truncation_probe.record` is the one place a network failure can end a measurement, and it has
already ended one: the endpoint dropped a session and the probe died inside `asyncio.run` before
scoring a single clip, so the interruption family went unmeasured and the report said nothing about
it. The fix is a retry on a fresh socket. That fix is worth nothing unless something fails when it is
removed, so this file asserts the promises rather than describing them:

    1  one dropped session does not end the run — the clip still comes back
    2  the dead socket is closed and *replaced*, not written into again
    3  a clip that fails every attempt aborts the run instead of being skipped, because the report
       reads "k/5 voices fire" and a silently dropped voice changes the denominator while every
       printed number still looks healthy
    4  a second call for the same clip touches no socket at all, and `--refresh` does touch one
    5  the cache key separates phrases that share a prefix — otherwise `大肥鱼一二大肥鱼` and
       `大肥鱼一二三大肥鱼` share one file and the probe scores the wrong audio while printing the
       right phrase, which is the only failure here that cannot be seen from the outside

No network is touched: `wake_tts` is replaced for the duration of each measurement.

Usage:  python wake_record_check.py
"""

from __future__ import annotations

import asyncio
import pathlib
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_truncation_probe as probe  # noqa: E402

REAL_WRITE = probe.wake_tts.write_wav

# A short phrase list, worded like the real one because the abort message quotes the phrase back.
PHRASE = "大肥鱼大肥鱼"
VOICE = "zh-CN-XiaoxiaoNeural"


class _Connection:
    """One session. A session the endpoint closes stays closed, which is the whole point of the test."""

    def __init__(self, owner) -> None:
        self.owner = owner
        self.dead = False

    async def say(self, voice, text, rate="+0%", pitch="+0Hz", timeout=30.0):
        if self.owner.remaining_failures > 0:
            self.owner.remaining_failures -= 1
            self.dead = True
            raise RuntimeError("no close frame received or sent")
        if self.dead:
            raise RuntimeError("the endpoint had already hung up on this session")
        self.owner.said.append((voice, text))
        # Constant and non-zero, so a cache round trip that came back silent or rescaled is visible.
        return np.full(16000, 0.01, dtype=np.float32)

    async def close(self):
        if not self.dead:
            self.owner.closes += 1
        self.dead = True


class _Dial:
    """Stands in for `wake_tts.Connection` — what `record` calls `.open()` on."""

    def __init__(self, owner) -> None:
        self.owner = owner

    async def open(self):
        self.owner.dials += 1
        session = _Connection(self.owner)
        self.owner.sessions.append(session)
        return session


class _Endpoint:
    def __init__(self, failures: int = 0) -> None:
        self.remaining_failures = failures
        self.dials = 0
        self.closes = 0
        self.said: list[tuple[str, str]] = []
        self.sessions: list[_Connection] = []
        self.write_wav = REAL_WRITE
        self.Connection = _Dial(self)


def measure(voices, phrases, failures=0, refresh=False, cache=None):
    """Run the real `record` against a fake endpoint.

    Returns `(endpoint, clips, error)`. The error is returned rather than raised because half of what
    is being asserted is *which* exception comes out: `SystemExit` is the deliberate abort, anything
    else is a crash, and the two must not be confused.
    """
    endpoint = _Endpoint(failures)
    saved_tts, saved_cache = probe.wake_tts, probe.CACHE
    probe.wake_tts = endpoint
    if cache is not None:
        probe.CACHE = cache
    clips, error = None, None
    try:
        clips = asyncio.run(probe.record(voices, phrases, refresh=refresh))
    except BaseException as failure:  # noqa: BLE001 — SystemExit included, on purpose
        error = failure
    finally:
        probe.wake_tts, probe.CACHE = saved_tts, saved_cache
    return endpoint, clips, error


def fresh_cache() -> pathlib.Path:
    return pathlib.Path(tempfile.mkdtemp(prefix="wake-record-"))


def one_drop_does_not_end_the_run() -> tuple[bool, str]:
    cache = fresh_cache()
    endpoint, clips, error = measure([VOICE], [PHRASE], failures=1, cache=cache)
    if error is not None:
        return False, f"a single dropped session ended the run: {type(error).__name__}: {error}"
    if not clips or len(clips) != 1:
        return False, f"expected 1 clip back, got {0 if not clips else len(clips)}"
    return True, f"clip returned after 1 failure, {endpoint.dials} dial(s)"


def the_dead_socket_is_replaced() -> tuple[bool, str]:
    cache = fresh_cache()
    endpoint, clips, error = measure([VOICE], [PHRASE], failures=1, cache=cache)
    if error is not None:
        return False, f"the retry did not recover: {type(error).__name__}: {error}"
    if endpoint.dials != 2:
        return False, f"expected exactly 2 dials (the dead one replaced), got {endpoint.dials}"
    if len(endpoint.sessions) < 2 or endpoint.sessions[0] is endpoint.sessions[1]:
        return False, "the retry wrote into the same session object the endpoint had closed"
    if not endpoint.sessions[0].dead:
        return False, "the failed session was not marked closed"
    if endpoint.closes < 1:
        return False, "the dead session was abandoned without being closed"
    if endpoint.said != [(VOICE, PHRASE)]:
        return False, f"the clip was not said exactly once on the live session: {endpoint.said}"
    return True, "dead session closed, second dial used, clip said once"


def a_permanent_failure_aborts() -> tuple[bool, str]:
    cache = fresh_cache()
    endpoint, clips, error = measure([VOICE], [PHRASE], failures=99, cache=cache)
    if clips is not None:
        return False, (f"the run continued with {len(clips)} clip(s) after the endpoint refused "
                       f"every attempt — a dropped voice changes the denominator silently")
    if not isinstance(error, SystemExit):
        return False, f"expected the deliberate abort (SystemExit), got {type(error).__name__}: {error}"
    if PHRASE not in str(error):
        return False, f"the abort does not name the phrase that failed: {error}"
    if endpoint.dials != probe.SAY_ATTEMPTS:
        return False, (f"expected {probe.SAY_ATTEMPTS} dials (one per attempt), got "
                       f"{endpoint.dials}")
    return True, f"aborted after {endpoint.dials} attempts, naming the phrase"


def the_cache_is_used_and_refresh_ignores_it() -> tuple[bool, str]:
    cache = fresh_cache()
    first, clips, error = measure([VOICE], [PHRASE], cache=cache)
    if error is not None or not clips:
        return False, f"the first pass did not record: {type(error).__name__}: {error}"
    if first.dials != 1:
        return False, f"expected 1 dial on an empty cache, got {first.dials}"

    second, cached, error = measure([VOICE], [PHRASE], cache=cache)
    if error is not None or not cached:
        return False, f"the second pass did not return the clip: {type(error).__name__}: {error}"
    if second.dials != 0:
        return False, f"the cached clip was fetched again ({second.dials} dial(s) against a warm cache)"
    if cached[0][2].shape != clips[0][2].shape:
        return False, f"the cached audio changed shape: {cached[0][2].shape} against {clips[0][2].shape}"
    if float(np.abs(cached[0][2]).max()) < 0.005:
        return False, "the cached audio came back silent — the wav was written or read wrong"
    if not np.allclose(cached[0][2], clips[0][2], atol=2e-3):
        return False, "the cached audio does not match what was synthesised (rescaled round trip)"

    third, refreshed, error = measure([VOICE], [PHRASE], refresh=True, cache=cache)
    if error is not None or not refreshed:
        return False, f"--refresh did not re-record: {type(error).__name__}: {error}"
    if third.dials != 1:
        return False, f"--refresh must ignore the cache; it made {third.dials} dial(s)"
    return True, "warm cache dials 0 times, round trip preserves the audio, --refresh dials once"


def the_key_separates_phrases() -> tuple[bool, str]:
    phrases = [PHRASE, "大肥鱼一二三大肥鱼", "大肥鱼一二大肥鱼", "大肥大肥", "大肥大肥鱼"]
    keys = [probe.cache_path(VOICE, text) for text in phrases]
    if len(set(keys)) != len(phrases):
        shared = [text for text in phrases if keys.count(probe.cache_path(VOICE, text)) > 1]
        return False, f"these phrases share one cache file: {shared}"
    voices = [probe.cache_path(voice, PHRASE) for voice in ("zh-CN-XiaoxiaoNeural", "zh-CN-YunxiNeural")]
    if voices[0] == voices[1]:
        return False, "the same phrase in two voices shares one cache file"
    return True, f"{len(phrases)} phrases and 2 voices give {len(set(keys)) + 1} distinct files"


PROPERTIES = [
    ("one dropped session does not end the run", one_drop_does_not_end_the_run),
    ("the dead socket is replaced, not written into", the_dead_socket_is_replaced),
    ("a clip that fails every attempt aborts the run", a_permanent_failure_aborts),
    ("the cache is used, and --refresh is not", the_cache_is_used_and_refresh_ignores_it),
    ("the cache key separates phrases", the_key_separates_phrases),
]


def main() -> int:
    print(f"  record(): {probe.SAY_ATTEMPTS} attempts, backoff {probe.RECONNECT_BACKOFF}s, "
          f"cache {probe.CACHE}")
    print()
    failed = 0
    for index, (name, run) in enumerate(PROPERTIES, 1):
        try:
            ok, detail = run()
        except BaseException as error:  # noqa: BLE001
            ok, detail = False, f"the check itself raised {type(error).__name__}: {error}"
        print(f"  {'PASS' if ok else 'FAIL'}  {index} {name}")
        print(f"          {detail}")
        failed += not ok
    print()
    if failed:
        print(f"  {failed}/{len(PROPERTIES)} FAIL — record() does not keep its promises")
        return 1
    print(f"  {len(PROPERTIES)}/{len(PROPERTIES)} pass")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
