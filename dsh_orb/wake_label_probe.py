"""Does the new labelling rule actually separate "twice" from "once"?

The rule the retrain depends on: a window only counts as a positive once it holds the whole doubled
phrase, and a clip of the phrase said **once** is a negative. That only works if a single 大肥鱼
cannot reach the slot count a doubled one requires. If it can, the model is being asked to fit the
same input under two labels, and no amount of training fixes that — the labels have to be fixed.

So this measures the two populations the same way `wake_dataset` does, on real TTS from the voices the
dataset uses, and reports the overlap. Two numbers per phrase:

  * `require` — the slot the ring must have reached for the phrase to be complete. This is what
    `require_clip_embeddings` gets.
  * `clip slots` — how long the trimmed clip is. The invariant is `clip slots - ring <= phrase start`,
    i.e. the last kept window still reaches back past the beginning of the phrase.

Usage: wake_label_probe.py [--voices 4]
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import random
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_dataset  # noqa: E402
import wake_features  # noqa: E402
import wake_phrases  # noqa: E402
import wake_tts  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

RATES = ["-25%", "-8%", "+0%", "+25%"]


def measure(samples: np.ndarray, pool_audio, rng: random.Random,
            nprng: np.random.Generator, extractor) -> dict | None:
    """Everything the labelling rule needs about one clip, plus what the extractor really returns."""
    prepared = wake_dataset.prepare_positive(samples)
    if prepared is None:
        return None
    clip, require = prepared
    warmup = wake_features.warmup_audio(nprng, wake_dataset.pool_slice(
        pool_audio, rng, wake_features.warmup_length()) if pool_audio else None)
    windows = extractor.windows(clip, warmup, require_clip_embeddings=require)
    ring = wake_features.WINDOW_FRAMES
    # The trim keeps the lead-in short, so the phrase starts a slot or two into the clip.
    start, _ = wake_dataset.speech_bounds(clip)
    lead_frame = (start or 0) // wake_features.FRAME_SAMPLES
    base = wake_features.slots_at(wake_features.WARMUP_FRAMES)
    phrase_start_slot = wake_features.slots_at(wake_features.WARMUP_FRAMES + lead_frame) - base
    clip_slots = (wake_features.slots_at(wake_features.WARMUP_FRAMES + len(clip) // 1280) - base)
    return {
        "require": require,
        "clip_slots": clip_slots,
        "windows": int(windows.shape[0]),
        "contained": clip_slots - ring <= phrase_start_slot,
        "shape": None if windows.shape[0] == 0 else tuple(windows.shape[1:]),
    }


async def collect(voices: list[str], pool_audio, rng, nprng, extractor) -> dict[str, list[dict]]:
    link = await wake_tts.Connection.open()
    out: dict[str, list[dict]] = {}
    try:
        for voice in voices:
            for text in ["大肥鱼"] + wake_phrases.POSITIVE_CARRIERS:
                for rate in RATES:
                    row = measure(await link.say(voice, text, rate=rate),
                                  pool_audio, rng, nprng, extractor)
                    if row is not None:
                        row.update(voice=voice, text=text, rate=rate)
                        out.setdefault(text, []).append(row)
    finally:
        await link.close()
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=4)
    args = parser.parse_args()

    voices = wake_tts.VOICES[:args.voices]
    print(f"  ring: {wake_features.WINDOW_FRAMES} slots "
          f"({wake_features.WINDOW_FRAMES * wake_features.SLOT_SAMPLES / 16000:.2f} s)")
    print(f"  voices: {', '.join(voices)}")
    print(f"  rates:  {', '.join(RATES)}")
    print()

    pool = sorted((wake_dataset.NEGATIVE_DIR).glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    rng = random.Random(0)
    nprng = np.random.default_rng(0)
    extractor = OrbFeatures(ncpu=4)

    results = asyncio.run(collect(voices, pool_audio, rng, nprng, extractor))

    print(f"  {'phrase':18} {'rate':6} {'requi':>5} {'clip':>5} {'win':>4} {'kept':>6}")
    for text, rows in results.items():
        for row in sorted(rows, key=lambda r: (r["voice"], r["rate"])):
            print(f"  {text:18} {row['rate']:6} {row['require']:5} {row['clip_slots']:5}"
                  f" {row['windows']:4} {'yes' if row['contained'] else 'NO':>6}")
    print()

    single = [row for text, rows in results.items() if text == "大肥鱼" for row in rows]
    doubled = [row for text, rows in results.items() if text != "大肥鱼" for row in rows]
    single_require = [row["require"] for row in single]
    doubled_require = [row["require"] for row in doubled]

    print("  ---- summary ----")
    print(f"    大肥鱼 (once)      require {min(single_require)}..{max(single_require)}"
          f"   {len(single)} clips")
    print(f"    大肥鱼×2 (carriers) require {min(doubled_require)}..{max(doubled_require)}"
          f"   {len(doubled)} clips")
    print(f"    separator: {max(single_require)} vs {min(doubled_require)}"
          f"  -> margin {min(doubled_require) - max(single_require)} slots")
    print()

    broken = [row for row in doubled if not row["contained"]]
    empty = [row for row in doubled if row["windows"] == 0]
    shapes = {row["shape"] for row in doubled if row["shape"]}
    if broken:
        print(f"  *** {len(broken)} clip(s) where the last window slides past the phrase start — the")
        print("      tail is too long for this phrase and rate; lower MAX_TAIL_SLOTS.")
    if empty:
        print(f"  *** {len(empty)} clip(s) produced NO positive window — the phrase does not fit the")
        print("      ring. Raise wake_features.WINDOW_FRAMES.")
    if min(doubled_require) <= max(single_require):
        print("  *** THE POPULATIONS OVERLAP. A single 大肥鱼 can reach the slot count a doubled one")
        print("      requires, so windows of the two would carry the same label. This is the exact")
        print("      failure the change was meant to remove — fix the phrases before training.")
    if not broken and not empty and min(doubled_require) > max(single_require):
        print(f"  Labels are consistent: every doubled clip needs at least {min(doubled_require)} slots")
        print(f"  while a single 大肥鱼 tops out at {max(single_require)}, and every doubled window still")
        print("  reaches back past the start of its phrase.")
    print(f"  window shapes: {shapes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
