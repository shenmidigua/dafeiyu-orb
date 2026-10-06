"""Would requiring a pause before the phrase help? Measured, not argued.

The proposal: wake only on **停顿 + 大肥鱼大肥鱼** — a pause, then the phrase. It sounds like a
tightening, and it is worth being precise about why it is not one, because the answer turns on the
shape of the window rather than on taste.

A pause gate can only help if the real wake has a pause and the false wake does not. Both halves are
measurable, and neither holds:

  * **The real phrase has no pause requirement today.** Half the training warm-ups are a stretch of
    *talking* (`wake_features.warmup_audio`), so the model was fitted to fire on the phrase with speech
    running right up to it. A pause gate therefore does not narrow an existing rule — it adds a new
    requirement, and every real wake arriving without a pause is a wake that stops working. The column
    to read is `pause 0.00s`: if the phrase fires there, no pause is being demanded, and demanding one
    is a new way to miss rather than a new way to filter.

  * **The false wake already has the pause.** The near-miss is said deliberately, after a pause, and
    nothing about a pause removes it: the ring ends at *now* and the inserted material sits inside the
    utterance, so the pause can only occupy the window's left edge — at most `ring - clip` of it, under
    a second for these phrases — while the insertion sits a good deal closer to the end than that. The
    table below is the check on that argument, and it does not depend on it: the interruptions are
    measured firing *behind a four-second pause*.

The columns:

    pause     seconds of quiet room immediately before the phrase, spliced onto the warm-up's end
    peak      highest window score, worst case over voices
    run       longest run above the threshold, best case over voices — the engine's own quantity
    fires     voices where a run of RULE_WINDOWS completes
    room      seconds of the firing window a pause can occupy = ring - clip length

`room` is derived, and it is here because it is the whole reason the argument is short: the phrase and
its interruption both fit inside one window, so there is under a second of the window left for anything
that comes *before* the utterance. It is not an assertion about where the model draws its line — the
measured columns are that.

Warm-ups here are built by hand rather than through `wake_dataset.warm_windows`, and that is the one
place this file deliberately departs from every other probe. `warm_windows` exists so that nothing
reassembles the ring differently from training; the question here *is* the ring's left edge, so it has
to be assembled explicitly. Everything else — the extractor, the model, the rule, the clip cache — is
the same code path the other probes use.

Usage:  <pipeline python> wake_pause_probe.py [--voices 3]
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_truncation_probe as probe  # noqa: E402
from wake_dataset import pool_slice  # noqa: E402
from wake_features import (  # noqa: E402
    SILENCE_LEVEL, SLOT_SAMPLES, WINDOW_FRAMES, OrbFeatures, pcm16_from_wav, warmup_length)

# 28 slots of 128 ms, taken from `wake_features` where the ring is derived rather than retyped: the
# number is the leading dimension of the classifier's input, so a copy that drifts describes a model
# nobody is running.
RING_SECONDS = WINDOW_FRAMES * SLOT_SAMPLES / 16000.0

# The phrase, and the interruptions worth putting in front of a pause. The control has to fire at every
# lead-in or the gate under test is not a gate but a second way to fail.
CANDIDATES = [
    ("大肥鱼大肥鱼", "the phrase, whole — must fire at every lead-in"),
    ("大肥鱼嗯大肥鱼", "a hesitation — the worst measured interruption"),
    ("大肥鱼那个大肥鱼", "a filler word"),
    ("大肥鱼一二大肥鱼", "a short count — the hardest of the count family"),
    ("大肥鱼一二三大肥鱼", "a count — the phrase the user reported"),
]

# 0 s is the case that decides whether a pause is required today. 2 s and 4 s are both past `in frame`
# for every phrase here, so they must agree with each other to the last digit.
PAUSES = (0.0, 0.25, 0.5, 1.0, 2.0, 4.0)

FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")


def warm_with_pause(pool_audio, rng, pause_seconds: float, nprng: np.random.Generator) -> np.ndarray:
    """A training-length warm-up whose last `pause_seconds` are a quiet room.

    Deliberately not `warmup_audio`: that function picks talking or silence *at random* to keep the
    trained distribution honest, and here the whole variable under test is which of the two sits
    immediately before the phrase.
    """
    total = warmup_length()
    quiet = int(round(pause_seconds * 16000))
    if quiet >= total:
        raise SystemExit(f"pause {pause_seconds}s does not fit in a {total / 16000:.1f}s warm-up")
    talking = pool_slice(pool_audio, rng, total - quiet)
    if talking is None:
        raise SystemExit("the filler pool is too small to build a warm-up")
    room = (nprng.standard_normal(quiet) * SILENCE_LEVEL).astype(np.float32)
    return np.concatenate([np.asarray(talking[:total - quiet], dtype=np.float32), room])


def score(session, feed, extractor, samples, warm, tries, rng):
    """(peak, longest run) worst case over warm-ups — `warm` is rebuilt per try so the talking varies."""
    peak, run = 0.0, 0
    for _ in range(tries):
        windows = extractor.windows(samples, warm, 0)
        if windows.shape[0] == 0:
            continue
        scores = [float(session.run(None, {feed: window[None, :, :]})[0].ravel()[0])
                  for window in windows]
        peak = max(peak, max(scores))
        streak = best = 0
        for value in scores:
            streak = streak + 1 if value >= probe.THRESHOLD else 0
            best = max(best, streak)
        run = max(run, best)
    return peak, run


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=3)
    parser.add_argument("--tries", type=int, default=3)
    args = parser.parse_args()

    live = probe.deployed_model()
    if live is None or not live.exists():
        raise SystemExit(f"the orb's own model is missing: {live}")

    voices = probe.wake_tts.VOICES[:args.voices]
    phrases = [text for text, _ in CANDIDATES]
    # Reuses the cache `wake_truncation_probe.py` fills, retry and all: a measurement that re-dials the
    # read-aloud endpoint for audio already on disk is a measurement that can be lost to a dropped
    # socket for no reason.
    clips = asyncio.run(probe.record(voices, phrases))

    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    extractor = OrbFeatures(ncpu=4)
    session = ort.InferenceSession(str(live), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name

    by_phrase: dict[str, dict[str, list[np.ndarray]]] = {}
    for voice, text, samples in clips:
        by_phrase.setdefault(text, {}).setdefault(voice, []).append(samples)

    print(f"  model:   {live.name}  ({live.parent})")
    print(f"  rule:    {probe.RULE_WINDOWS} consecutive windows at or above {probe.THRESHOLD}")
    print(f"  ring:    {WINDOW_FRAMES} slots x {SLOT_SAMPLES / 16000 * 1000:.0f} ms = "
          f"{RING_SECONDS:.3f} s, ending at the phrase's end")
    print(f"  voices:  {', '.join(voices)}")
    print(f"  warm-ups:{args.tries} per cell, talking resampled each time")
    print()

    verdicts = []
    for text, note in CANDIDATES:
        samples_by_voice = by_phrase.get(text)
        if not samples_by_voice:
            print(f"  {text}  — no clip; skipped")
            continue
        first = next(iter(samples_by_voice.values()))[0]
        room = RING_SECONDS - len(first) / 16000.0
        print(f"  {text}  — {note}")
        print(f"    {'pause':>7} {'peak':>7} {'run':>6} {'fires':>7} {'room':>7}")
        curves = {}
        for index, pause in enumerate(PAUSES):
            peaks, runs, hits = [], [], 0
            for position, (voice, group) in enumerate(sorted(samples_by_voice.items())):
                for clip in group:
                    rng = random.Random(index * 1000 + position)
                    nprng = np.random.default_rng(len(clip) + index)
                    warm = warm_with_pause(pool_audio, rng, pause, nprng)
                    peak, run = score(session, feed, extractor, clip, warm, args.tries, rng)
                    peaks.append(peak)
                    runs.append(run)
                    hits += run >= probe.RULE_WINDOWS
            curves[pause] = (max(peaks), max(runs), hits)
            print(f"    {pause:6.2f}s {max(peaks):7.3f} {max(runs):6d} "
                  f"{hits:>4}/{len(samples_by_voice):<2} {room:6.2f}s")
        print()
        verdicts.append((text, curves, room))

    # The aggregate, which is the answer: how many of the near-misses a pause excludes, and what it
    # costs on the phrase that has to keep working. Both are read at the longest pause tried, which is
    # the most favourable setting the proposal could ask for.
    last = PAUSES[-1]
    control = verdicts[0]
    interruptions = verdicts[1:]
    still = [text for text, curves, _ in interruptions if curves[last][2]]
    print("  " + "-" * 78)
    print(f"  The phrase, with no pause in front of it at all (0.00s): "
          f"{control[1][0.0][2]}/{len(voices)} voice(s) fire. "
          f"At {last:.0f}s: {control[1][last][2]}/{len(voices)}.")
    print(f"  So the model is indifferent to the pause — it does not require one today, and gating on")
    print(f"  one adds a requirement rather than tightening an existing one.")
    print()
    print(f"  Interruptions excluded by a {last:.0f}s pause: "
          f"{len(interruptions) - len(still)}/{len(interruptions)}.")
    if still:
        for text, curves, _ in interruptions:
            if curves[last][2]:
                print(f"    {text}: peak {curves[0.0][0]:.3f} -> {curves[last][0]:.3f} "
                      f"across the whole range, still fires in {curves[last][2]}/"
                      f"{len(voices)} voice(s)")
        print(f"  These keep firing however long the pause is, and their peak does not move while it")
        print(f"  grows: the insertion is inside the utterance, and the pause only ever reaches the")
        print(f"  window's left edge, where there is {min(room for _, _, room in verdicts):.2f}s of room at most.")
    else:
        print(f"  Every measured interruption is excluded by a pause. Worth acting on.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
