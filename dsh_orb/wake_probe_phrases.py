"""Which near-misses does the trained model actually fire on?

`wake_eval.py` reports that about one near-miss clip in eight crosses the threshold, and an aggregate
number is the wrong level of detail for that: the adversarial list mixes two very different things.

  * **Tone-only neighbours.** 大飞鱼, 大肺鱼 and 大肥鱼 differ in the tone of one syllable and nothing
    else. 飞 is first tone, 肥 and 肺 are second and fourth. Telling them apart is a pitch-accent
    judgement, and the embedding model underneath was fitted to English speech, which does not carry
    tone. Firing on those is close to the floor of what this architecture can do, and a human
    mishearing them in a noisy room is not implausible either.
  * **Everything else.** 大肥猪, 大白鱼, 打飞机, 带鱼 — different sounds in different positions. Firing
    on those is a real defect, because nothing about them is close.

The dataset on disk cannot answer this: `wake_dataset.py` names clips by write order, and eight
workers pulling from one queue means `adversarial-000123.wav` has no recoverable phrase. So this runs
a small, purpose-built set where the mapping is known by construction.

Usage: wake_probe_phrases.py [--voices 3]
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

import wake_phrases  # noqa: E402
import wake_tts  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

MODEL = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")

# Split by *why* they are hard, so the result can be read rather than just counted. A phrase's tone
# pattern is written out because that is the whole argument for whether a miss here is acceptable.
TONE_ONLY = [
    ("大飞鱼", "dà fēi yú — 飞 is tone 1, 肥 is tone 2, same onset and rime"),
    ("大肺鱼", "dà fèi yú — 肺 is tone 4, same onset and rime"),
]
DIFFERENT_SOUNDS = [
    ("大肥猪", "dà féi zhū — shares 大肥, different final syllable"),
    ("大白鱼", "dà bái yú — different middle syllable"),
    ("大肥牛", "dà féi niú — shares 大肥, different final syllable"),
    ("大鲤鱼", "dà lǐ yú — different middle syllable"),
    ("带鱼", "dài yú — two syllables, different first syllable"),
    ("打飞机", "dǎ fēi jī — different second and third syllables"),
]
ADVERSARIAL_REST = [phrase for phrase in wake_phrases.ADVERSARIAL
                    if phrase not in {text for text, _ in TONE_ONLY + DIFFERENT_SOUNDS}]


async def record(voices: list[str]):
    """Synthesise every probe phrase in every voice, on one connection."""
    link = await wake_tts.Connection.open()
    clips = []
    try:
        for voice in voices:
            for text, _ in TONE_ONLY + DIFFERENT_SOUNDS:
                clips.append((voice, text, await link.say(voice, text)))
            for text in ADVERSARIAL_REST:
                clips.append((voice, text, await link.say(voice, text)))
            # A true positive in every voice, so a low score on the negatives can be told apart from
            # a model that simply does not work on this voice.
            clips.append((voice, "大肥鱼", await link.say(voice, "大肥鱼")))
    finally:
        await link.close()
    return clips


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.75)
    args = parser.parse_args()

    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; run wake_train.py first")

    voices = wake_tts.VOICES[:args.voices]
    print(f"  voices: {', '.join(voices)}")
    print(f"  threshold: {args.threshold}")
    print()

    clips = asyncio.run(record(voices))
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)

    # Warm-up material, so the ring is in the state it is in when the orb is listening rather than
    # starting from the zeros a from-scratch run leaves behind.
    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    warm_rng = random.Random(0)

    def best_score(samples: np.ndarray) -> float:
        windows = warm_windows(extractor, samples, pool_audio, warm_rng,
                               np.random.default_rng(len(samples)))
        if windows.shape[0] == 0:
            return 0.0
        return float(max(session.run(None, {feed: window[None, :, :]})[0].ravel()[0]
                         for window in windows))

    scores: dict[str, list[float]] = {}
    for voice, text, samples in clips:
        scores.setdefault(text, []).append(best_score(samples))

    def report(title: str, entries) -> tuple[int, int]:
        print(f"  == {title} ==")
        fired = 0
        for text, note in entries:
            values = scores.get(text, [])
            if not values:
                continue
            peak = max(values)
            hits = sum(1 for value in values if value >= args.threshold)
            fired += hits
            verdict = "FIRES" if hits else "quiet"
            print(f"    {text:6} {note:52} peak {peak:6.3f}  {hits}/{len(values)} {verdict}")
        print(f"    -> {fired} clip(s) at or above {args.threshold} across {len(entries)*len(voices)}")
        print()
        return fired, len(entries) * len(voices)

    tone_fired, tone_total = report("tone-only neighbours (hard for a non-tonal embedding)",
                                    TONE_ONLY)
    distinct_fired, distinct_total = report("different sounds (firing here is a real defect)",
                                            DIFFERENT_SOUNDS)
    rest_fired, rest_total = report("the rest of the adversarial list",
                                    [(text, "") for text in ADVERSARIAL_REST])

    control = scores.get("大肥鱼", [])
    print("  == true positives (the wake word itself) ==")
    print(f"    大肥鱼 peak {max(control):.3f}  "
          f"{sum(1 for value in control if value >= args.threshold)}/{len(control)} fire")
    print()

    print("  ---- summary ----")
    print(f"    wake word            {sum(1 for v in control if v >= args.threshold)}/{len(control)}")
    print(f"    tone-only neighbours {tone_fired}/{tone_total}")
    print(f"    different sounds     {distinct_fired}/{distinct_total}")
    print(f"    other adversarial    {rest_fired}/{rest_total}")
    print()
    if distinct_fired == 0 and control and min(control) >= args.threshold:
        print("  The confusions are confined to tone-only pairs, which is the closest this")
        print("  architecture can be expected to get. Ship it and test with a real voice.")
    elif distinct_fired:
        print("  Real defects above: phrases that do not sound like the wake word are firing. More")
        print("  negatives drawn from those exact sounds is the fix; raise the threshold meanwhile.")
    else:
        print("  Check the true-positive control above first — a quiet control means the probe, not")
        print("  the model, is the problem.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
