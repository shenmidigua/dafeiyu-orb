"""How many embedding frames does a phrase occupy?

The classifier's ring is counted in *embedding* frames, and one embedding frame is not 80 ms. The
renderer's cadence is `wake.js`'s: one 1280-sample frame (80 ms) yields five 32-bin mel frames, and
one embedding consumes `MEL_STEP = 8` of them, so a ring slot advances every 8 x 16 ms = **128 ms**.
Every sizing decision in the pipeline is in those slots, so guessing at the hop would mis-size the
ring by a factor of 1.6.

This measures the speech span of each candidate phrase directly, by trimming silence off the TTS
output and dividing by the hop, so the ring can be chosen from a number rather than from a hunch.

Usage: wake_span_probe.py [--voices 3]
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_tts  # noqa: E402
import wake_features  # noqa: E402

# One ring slot: MEL_STEP mel frames, each of them 16 ms (five per 80 ms input frame).
HOP_MS = wake_features.OrbFeatures.MEL_STEP * (80.0 / wake_features.OrbFeatures.MEL_FRAMES_PER_CALL)

PHRASES = [
    ("大肥鱼", 1),
    ("大肥鱼大肥鱼", 2),
    ("喂，大肥鱼大肥鱼", 2),
]

# Below this RMS a frame counts as silence. Generous on purpose: TTS tail noise should be trimmed,
# while a quiet final syllable should not be cut off the phrase, because cutting it would understate
# the span and under-size the ring.
SILENCE_RMS = 0.004


def speech_span(samples: np.ndarray) -> tuple[float, float]:
    """(start, end) seconds of the talking part, by frame RMS."""
    frame = wake_features.FRAME_SAMPLES
    count = len(samples) // frame
    if count == 0:
        return 0.0, 0.0
    rows = samples[:count * frame].reshape(count, frame)
    rms = np.sqrt((rows ** 2).mean(axis=1))
    loud = np.where(rms > SILENCE_RMS)[0]
    if len(loud) == 0:
        return 0.0, 0.0
    return float(loud[0] * frame / 16000), float((loud[-1] + 1) * frame / 16000)


async def main_async(voices: list[str], rates: list[str]) -> int:
    link = await wake_tts.Connection.open()
    rows = []
    try:
        for voice in voices:
            for text, syllables in PHRASES:
                for rate in rates:
                    samples = await link.say(voice, text, rate=rate)
                    start, end = speech_span(samples)
                    span = end - start
                    rows.append((voice, text, rate, span, span * 1000 / HOP_MS, syllables))
    finally:
        await link.close()

    print(f"  hop: {HOP_MS:.0f} ms per ring slot "
          f"(MEL_STEP {wake_features.OrbFeatures.MEL_STEP} x 16 ms)")
    print()
    print(f"  {'voice':10} {'phrase':8} {'rate':6} {'speech':>7} {'slots':>6}  {'ms/syllable':>11}")
    for voice, text, rate, span, slots, syllables in rows:
        print(f"  {voice[6:]:10} {text:8} {rate:6} {span:6.2f}s {slots:6.1f}"
              f"  {span * 1000 / syllables:11.0f}")

    print()
    print("  ---- worst case per phrase (the ring must hold this) ----")
    for text, syllables in PHRASES:
        subset = [row for row in rows if row[1] == text]
        worst = max(row[4] for row in subset)
        best = min(row[4] for row in subset)
        print(f"    {text:8} slots {best:.1f} .. {worst:.1f}   "
              f"-> ring must be >= {int(np.ceil(worst))} (+ margin for a prefix)")
    print()

    doubled = max(row[4] for row in rows if row[1] == "大肥鱼大肥鱼")
    single = max(row[4] for row in rows if row[1] == "大肥鱼")
    print(f"  A single 大肥鱼 spans {single:.1f} slots and the doubled one {doubled:.1f}.")
    print(f"  Today's ring is {wake_features.WINDOW_FRAMES}. "
          f"{'The doubled phrase does NOT fit — that is the finding.' if doubled > wake_features.WINDOW_FRAMES else 'It fits today; check the rates.'}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=3)
    args = parser.parse_args()
    voices = wake_tts.VOICES[:args.voices]
    rates = ["-25%", "+0%", "+25%"]
    print(f"  voices: {', '.join(voices)}")
    print(f"  rates:  {', '.join(rates)}")
    print()
    return asyncio.run(main_async(voices, rates))


if __name__ == "__main__":
    raise SystemExit(main())
