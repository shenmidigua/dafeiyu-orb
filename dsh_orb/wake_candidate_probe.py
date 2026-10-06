"""Would a different phrasing buy anything? Measure the evidence, not the intuition.

The proposal was "嘿，大肥鱼". Changing a wake word means re-synthesising the whole dataset, re-running
feature extraction, retraining and re-validating — hours of work whose outcome is decided by one
quantity that can be measured far more cheaply: **how many classifier windows the phrase holds up.**

The shipped rule wants three consecutive windows above the threshold, and a window advances one ring
slot (128 ms). So a phrase that spans six slots can support a three-window rule with three to spare;
one that spans four has no room at all. That is the argument, and it is a number.

Two things are reported per candidate:

  * **span** — the talking part of the clip, in slots, trimmed by RMS. Voice and rate independent: it
    comes from `wake_span_probe.py`, whose hop arithmetic is the same one the ring is sized with.
  * **the shipped model's own reading** — what `dafeiyu.onnx` scores on it, peak and longest run
    above the deployed threshold. A phrase the model has never been trained on is only a near-miss to
    it, so these are not predictions of a future model; they are the control that says the model
    discriminates the phrasing at all, and that the measurement is wired up.

Run with the interpreter the rest of the wake-word pipeline uses (see `wake_pipeline.py`):

    D:\\tools\\indextts\\py311\\python.exe wake_candidate_probe.py [--voices 14] [--rates 3]
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

import wake_tts  # noqa: E402
import wake_span_probe  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

MODEL = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")
REPORT = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu-candidate-probe.json")

# Deployed threshold, so "longest run" is the quantity the shipped rule actually consumes.
THRESHOLD = 0.95

# `CONSECUTIVE_WINDOWS` in `packages/helper/assets/wake.js`. Duplicated rather than imported because
# the two live in different languages; if they ever disagree, this probe stops describing the orb.
RULE_WINDOWS = 3

# The candidates. The first two are controls: one is what the orb had before the doubled phrase, the
# other is what it ships today. Every entry is (phrase, syllables, why it is in the list).
CANDIDATES = [
    ("大肥鱼", 3, "the original single word — replaced because it was far too easy to trip"),
    ("大肥鱼大肥鱼", 6, "SHIPPED — the phrase said twice"),
    ("嘿，大肥鱼", 4, "the proposal: a prefix in front of the single word"),
    ("嘿，大肥鱼，嘿，大肥鱼", 8, "the proposal doubled — longer, but nobody says this by accident"),
]

# Phrases the model *was* trained to reject, and the point of the second table. "喂，大肥鱼" is in
# `wake_phrases.DOUBLED_MISREADS`, so it went into training as a negative — a high score on it is not
# a phrasing preference, it is the learned boundary failing to hold on a surface form it has seen.
# "嗯，大肥鱼" and "那个，大肥鱼" were never trained, and are the generalisation version of the same
# question: does a prefix in front of the single word change what the model hears?
NEAR_MISS_CONTROLS = [
    ("喂，大肥鱼", 4, "trained as a negative — a high score here is the boundary failing"),
    ("嗯，大肥鱼", 4, "never trained; the same shape as 嘿，大肥鱼"),
    ("那个，大肥鱼", 5, "never trained; a prefix from the shipped carrier list"),
]

# Preceding conversations each clip is scored behind, matching `wake_probe_phrases.WARM_TRIES`: a
# phrase's score depends on the ring's contents, and one warm-up is not a measurement here.
WARM_TRIES = 3


async def record(voices: list[str], rates: list[str]):
    link = await wake_tts.Connection.open()
    clips = []
    try:
        for voice in voices:
            for text, _, _ in CANDIDATES + NEAR_MISS_CONTROLS:
                for rate in rates:
                    samples = await link.say(voice, text, rate=rate)
                    start, end = wake_span_probe.speech_span(samples)
                    clips.append((voice, text, rate, samples, end - start))
    finally:
        await link.close()
    return clips


def longest_run(scores: np.ndarray, threshold: float) -> int:
    best = current = 0
    for value in scores:
        if value > threshold:
            current += 1
            best = max(best, current)
        else:
            current = 0
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=len(wake_tts.VOICES))
    parser.add_argument("--rates", type=int, default=3)
    args = parser.parse_args()

    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; run wake_train.py first")

    voices = wake_tts.VOICES[:args.voices]
    # Neutral, slow and fast: span is rate dependent, and a phrase has to survive the drift.
    rates = ["-25%", "+0%", "+25%"][:args.rates] if args.rates <= 3 else wake_tts.RATES
    print(f"  voices: {len(voices)}   rates: {', '.join(rates)}")
    print(f"  model: {MODEL.name}   threshold: {THRESHOLD}")
    print()

    clips = asyncio.run(record(voices, rates))
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)

    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    warm_rng = random.Random(0)

    hop_ms = wake_span_probe.HOP_MS
    per_phrase: dict[str, list[tuple[float, float, int]]] = {}
    for voice, text, rate, samples, span in clips:
        peaks = []
        runs = []
        for _ in range(WARM_TRIES):
            windows = warm_windows(extractor, samples, pool_audio, warm_rng,
                                   np.random.default_rng(len(samples) + WARM_TRIES))
            if windows.shape[0] == 0:
                peaks.append(0.0)
                runs.append(0)
                continue
            scores = np.array([session.run(None, {feed: window[None, :, :]})[0].ravel()[0]
                               for window in windows], dtype=np.float32)
            peaks.append(float(scores.max()))
            runs.append(longest_run(scores, THRESHOLD))
        # Worst case over contexts, matching `wake_probe_phrases.py`: the number that matters is the
        # highest score across contexts, because deployment context is whatever was just said.
        per_phrase.setdefault(text, []).append((max(peaks), span * 1000 / hop_ms, max(runs)))

    def table(title: str, group) -> dict:
        print(f"  == {title} ==")
        print(f"  {'phrase':26} {'syll':>5} {'slots (min..max)':>17} {'peak':>7} {'max run':>8} "
              f"{'clips firing':>13}")
        print("  " + "-" * 84)
        out = {}
        for text, syllables, _ in group:
            rows = per_phrase.get(text, [])
            if not rows:
                continue
            slots = [row[1] for row in rows]
            peaks = [row[0] for row in rows]
            runs = [row[2] for row in rows]
            low, high = min(slots), max(slots)
            fires = sum(1 for run in runs if run >= RULE_WINDOWS)
            out[text] = {
                "syllables": syllables,
                "slots_min": low, "slots_max": high,
                "seconds_at_hop": round(high * hop_ms / 1000, 2),
                "model_peak": round(max(peaks), 3),
                "model_longest_run_at_0.95": max(runs),
                "clips_meeting_shipped_rule": fires,
                "clips_scored": len(rows),
            }
            print(f"  {text:26} {syllables:5} {low:7.1f}..{high:<8.1f} {max(peaks):7.3f} "
                  f"{max(runs):8} {fires:6}/{len(rows):<6}")
        print()
        return out

    summary = table("the phrasing candidates", CANDIDATES)
    controls = table("phrases the model should already refuse", NEAR_MISS_CONTROLS)

    print("  ---- what a longer span buys ----")
    for text, syllables, note in CANDIDATES:
        if text not in summary:
            continue
        worst = summary[text]["slots_min"]
        # The rule needs `RULE_WINDOWS` consecutive windows, and a window is one slot, so the
        # remainder is how many extra shots the phrase gives the model before its plateau must end.
        print(f"    {text:26} {worst:5.1f} slots at its shortest -> "
              f"{worst - RULE_WINDOWS:+.1f} beyond the rule's {RULE_WINDOWS} windows")
    print()
    print("  Span is a property of the phrase, so it survives being retrained. The peak and run")
    print("  columns are the *current* model's reading of phrasing it was never trained on — read")
    print("  the span line for the decision, and the controls for whether this model is even")
    print("  holding the line it was trained to hold.")
    print()
    for text, syllables, note in CANDIDATES:
        print(f"    {text:26} {note}")
    print()
    trained_high = [text for text, _, _ in NEAR_MISS_CONTROLS
                    if controls.get(text, {}).get("model_peak", 0) >= THRESHOLD]
    if trained_high:
        print(f"  Note: {trained_high} reaches {THRESHOLD} on a model that was trained to refuse it.")
        print("  That is the boundary not holding on a surface form it has seen, and it is worth")
        print("  reading before blaming the phrase for what the orb does in a real room.")

    # The finding is a property of this model on this phrasing, so it is written down with enough
    # context to be compared against whatever the next training run produces.
    REPORT.write_text(json.dumps({
        "model": str(MODEL), "threshold": THRESHOLD, "rule_windows": RULE_WINDOWS,
        "voices": len(voices), "rates": rates,
        "candidates": summary, "near_miss_controls": controls,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"  report: {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
