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
import json
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

# The orb's own settings, so this probe can say whether the file it just measured is the file the orb
# is loading. It did not, and the gap is not hypothetical: the model `wake_train.py` exported was left
# in the output directory while `orb-wake.json` went on pointing at an older one, so a whole round of
# phrase work was verified against a file nobody was running. Nothing failed — that is the problem
# with a measurement that never asks where the model came from.
SETTINGS = pathlib.Path.home() / ".dsh" / "profiles" / "desktop" / "orb-wake.json"


def deployed_model() -> pathlib.Path | None:
    try:
        settings = json.loads(SETTINGS.read_text(encoding="utf8"))
        return pathlib.Path(settings["assetDirectory"]) / f"{settings.get('keyword', '')}.onnx"
    except Exception:
        return None


def digest(path: pathlib.Path) -> str:
    """Content, not path. The deployed copy is meant to be a different *file*, and comparing locations
    would go on warning about a deployment that is perfectly correct."""
    import hashlib
    return hashlib.sha256(path.read_bytes()).hexdigest()

# Preceding conversations each clip is scored behind. The training set now varies this dimension too
# (`wake_dataset.WARM_VARIANTS`), so a probe that fixed it at one would be measuring something the
# model was never asked to be robust to.
WARM_TRIES = 3

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
# The phrase said **once**. This is the group the whole change exists for: the previous model was
# trained on the single word, so it fired on every one of these by construction. If the new model
# still does, nothing has been fixed, whatever the aggregate numbers say.
SINGLE_WORD_NOTES = {
    "大肥鱼": "said once, alone — the commonest accidental trigger",
    "喂，大肥鱼": "said once, with a prefix",
}
SINGLE_WORD = [(phrase, SINGLE_WORD_NOTES.get(phrase, "said once, inside a sentence"))
               for phrase in wake_phrases.DOUBLED_MISREADS]

# The rest of the single-word family — the interjections, the unpunctuated readings, the trailing
# particles, the ones buried in a sentence. Reported as one group rather than line by line because the
# question it answers is "does the rule hold across the family", which is the question training was
# changed to answer; which individual phrasing is worst is `wake_candidate_probe.py`'s job.
SHAPES = [(phrase, "") for phrase in wake_phrases.SINGLE_WORD_SHAPES]

ADVERSARIAL_REST = [phrase for phrase in wake_phrases.ADVERSARIAL
                    if phrase not in {text for text, _ in TONE_ONLY + DIFFERENT_SOUNDS}
                    and phrase not in set(wake_phrases.DOUBLED_MISREADS)
                    and phrase not in set(wake_phrases.SINGLE_WORD_SHAPES)
                    and phrase not in set(wake_phrases.TRUNCATED_DOUBLES)]

# Truncations of the doubled phrase itself — a syllable missing from one half or from both. Its own
# group, because the two groups above attack the phrase said **once** and a truncation is still said
# twice. Added after the user reported 大肥大肥 and 大肥鱼大肥 both waking the orb, when neither group
# covered them: `wake_phrases.TRUNCATED_DOUBLES` carries the measurement that came first.
TRUNCATED = [(phrase, "a syllable missing from the doubled phrase")
             for phrase in wake_phrases.TRUNCATED_DOUBLES]


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
            for text, _ in SINGLE_WORD + SHAPES + TRUNCATED:
                clips.append((voice, text, await link.say(voice, text)))
            # The true positives, in every carrier and every voice, so a low score on the negatives
            # can be told apart from a model that simply does not work on this voice.
            for text in wake_phrases.POSITIVE_CARRIERS:
                clips.append((voice, text, await link.say(voice, text)))
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
    print(f"  model: {MODEL}")
    live = deployed_model()
    if live is None:
        print("  deployed: unknown — the orb's settings could not be read")
    elif live.exists() and digest(live) == digest(MODEL):
        print("  deployed: the same bytes — the orb is loading what is being measured")
    else:
        print(f"  deployed: {live}")
        print("  *** that is a DIFFERENT model — the numbers below describe a file nobody is running.")
        print("      Copy the measured file into the asset directory before believing any of it. ***")
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

    def best_score(samples: np.ndarray) -> tuple[float, float]:
        """Worst case and best case over several preceding conversations.

        One warm-up is not a measurement here. The same phrase in the same voice was scored at 0.001
        behind one filler slice and at 0.999 behind another (`_rate_probe.py`), and in deployment the
        context is whatever happened to be said at the time — so the number that matters is the
        highest score across contexts, and the low is carried beside it to show how wide the spread
        is. A phrase whose spread straddles the threshold is not "almost classified"; it is
        unclassified, and averaging it away would hide exactly the defect this probe exists to find.
        """
        peaks: list[float] = []
        for _ in range(WARM_TRIES):
            windows = warm_windows(extractor, samples, pool_audio, warm_rng,
                                   np.random.default_rng(len(samples)))
            if windows.shape[0] == 0:
                peaks.append(0.0)
                continue
            peaks.append(float(max(session.run(None, {feed: window[None, :, :]})[0].ravel()[0]
                                    for window in windows)))
        return max(peaks), min(peaks)

    scores: dict[str, list[tuple[float, float]]] = {}
    for voice, text, samples in clips:
        scores.setdefault(text, []).append(best_score(samples))

    def report(title: str, entries) -> tuple[int, int]:
        print(f"  == {title} ==")
        fired = 0
        for text, note in entries:
            values = scores.get(text, [])
            if not values:
                continue
            peak = max(high for high, _ in values)
            low = min(low for _, low in values)
            hits = sum(1 for high, _ in values if high >= args.threshold)
            fired += hits
            verdict = "FIRES" if hits else "quiet"
            print(f"    {text:6} {note:42} peak {peak:6.3f}  low {low:6.3f}  "
                  f"{hits}/{len(values)} {verdict}")
        print(f"    -> {fired} clip(s) at or above {args.threshold} across {len(entries)*len(voices)}")
        print()
        return fired, len(entries) * len(voices)

    tone_fired, tone_total = report("tone-only neighbours (hard for a non-tonal embedding)",
                                    TONE_ONLY)
    distinct_fired, distinct_total = report("different sounds (firing here is a real defect)",
                                            DIFFERENT_SOUNDS)
    rest_fired, rest_total = report("the rest of the adversarial list",
                                    [(text, "") for text in ADVERSARIAL_REST])
    once_fired, once_total = report("THE PHRASE SAID ONCE (what this model must not hear)",
                                    SINGLE_WORD)
    shapes_fired, shapes_total = report("THE SINGLE-WORD FAMILY (interjections, particles, buried)",
                                        SHAPES)
    trunc_fired, trunc_total = report("TRUNCATIONS OF THE DOUBLED PHRASE (a syllable missing)",
                                      TRUNCATED)

    per_carrier = {carrier: scores.get(carrier, []) for carrier in wake_phrases.POSITIVE_CARRIERS}
    control = [high for values in per_carrier.values() for high, _ in values]
    silent = [carrier for carrier, values in per_carrier.items()
              if not values or max(high for high, _ in values) < args.threshold]
    print("  == true positives (the phrase said twice) ==")
    for carrier, values in per_carrier.items():
        if not values:
            continue
        print(f"    {carrier:16} peak {max(high for high, _ in values):6.3f}  "
              f"low {min(low for _, low in values):6.3f}  "
              f"{sum(1 for high, _ in values if high >= args.threshold)}/{len(values)} fire")
    print()

    print("  ---- summary ----")
    print(f"    phrase x2   must fire    {sum(1 for v in control if v >= args.threshold)}/{len(control)}")
    print(f"    phrase x1   must not     {once_fired}/{once_total}")
    print(f"    x1 family   must not     {shapes_fired}/{shapes_total}")
    print(f"    truncations must not     {trunc_fired}/{trunc_total}")
    print(f"    tone-only neighbours     {tone_fired}/{tone_total}")
    print(f"    different sounds         {distinct_fired}/{distinct_total}")
    print(f"    other adversarial        {rest_fired}/{rest_total}")
    print()
    if not control:
        print("  No true positives were scored at all — the probe is the problem, not the model.")
    elif silent:
        print(f"  Recall is incomplete: {silent} do not always reach {args.threshold}. A wake word that")
        print("  misses is worse than one that hears too much, so fix this before reading the")
        print("  negatives — either lower the threshold or retrain.")
    elif once_fired == 0 and shapes_fired == 0 and trunc_fired == 0:
        print("  Every reading of the phrase fires, and nothing that shares its syllables does — not in")
        print(f"  any of the {len(SHAPES)} shapes the single-word family carries, and not in any of the")
        print(f"  {len(TRUNCATED)} ways a syllable can go missing from the doubled phrase. That is the")
        print("  rule, learned rather than memorised; what is left is real speech, which only the orb")
        print("  can measure.")
    else:
        print(f"  {once_fired} reading(s) of the phrase said once, {shapes_fired} of its family, and")
        print(f"  {trunc_fired} truncation(s) of the doubled phrase still fire — exactly the accidental")
        print("  trigger the change was meant to remove. Note")
        print("  that raising the threshold cannot fix a family member whose run is long: measure the")
        print("  run first (`wake_candidate_probe.py`), because a long one means the model is wrong,")
        print("  not the rule.")
    print()
    print("  Read the tone-only line last: firing there is a limit of a non-tonal embedding model,")
    print("  not a defect in this phrase.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
