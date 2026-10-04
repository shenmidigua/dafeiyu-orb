"""Is 大肥鱼 separable in openWakeWord's embeddings at all?

This is the experiment worth running before any of the expensive work. openWakeWord's documentation
says it is English-only, and the reason given is the training data rather than the architecture — the
melspectrogram and embedding models are language-agnostic on paper, but "on paper" is not a
measurement, and its embedding model was fitted to English speech.

If the answer is no, everything downstream is wasted effort: no amount of augmentation or training
turns a representation that conflates 大肥鱼 with 大肥猪 into a working detector.

The test is deliberately weak on purpose. A logistic regression on flattened 16x96 windows is a far
worse classifier than the DNN that will actually be trained — so a *high* score here is strong
evidence the pipeline will work, while a *low* score means the DNN is being asked to find something
that is not there. It is a floor, not a forecast.

Scoring is clip-level, taking each clip's single most confident window, because that is how the
engine decides: one window above threshold fires the wake word.
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_phrases  # noqa: E402
import wake_tts  # noqa: E402
from wake_features import FeatureExtractor  # noqa: E402

# Six voices is enough to see whether the thing works, and cheap enough to iterate on. The full set
# is used once the pipeline is known to be sound.
PROBE_VOICES = wake_tts.VOICES[:6]
FILLER_PER_VOICE = 4

# The positive set has to be big enough for a grouped split to have something to learn from. One
# phrase in six voices is not: a fold holding a single positive can only memorise it, and the score
# that comes back describes the split rather than the embedding. Varying the carrier and the prosody
# is also what the real training set does, so the probe is asking the same question it will later.
CARRIERS = wake_phrases.POSITIVE_CARRIERS[:3]
PROSODY = [("+0%", "+0Hz"), ("+15%", "+0Hz"), ("-15%", "+0Hz"), ("+0%", "+15Hz")]


async def collect() -> list[tuple[int, str, str, np.ndarray]]:
    """Synthesise the probe set. Returns (label, text, voice, samples)."""
    link = await wake_tts.Connection.open()
    clips: list[tuple[int, str, str, np.ndarray]] = []
    try:
        for voice in PROBE_VOICES:
            for text in CARRIERS:
                for rate, pitch in PROSODY:
                    clips.append((1, text, voice, await link.say(voice, text, rate, pitch)))
            for text in wake_phrases.ADVERSARIAL:
                clips.append((0, text, voice, await link.say(voice, text)))
            # A fixed, not random, slice: the same sentences across voices keeps the comparison
            # between voices meaningful.
            for text in wake_phrases.FILLER[:FILLER_PER_VOICE]:
                clips.append((0, text, voice, await link.say(voice, text)))
    finally:
        await link.close()
    return clips


def featurise(clips):
    """Flatten every clip's windows, reporting the clip each window came from.

    Clip identity is carried explicitly rather than recomputed from frame arithmetic: the split has to
    keep a clip's windows together, and if the two ever disagreed the leak would be silent and the
    resulting score meaningless.
    """
    extractor = FeatureExtractor(ncpu=4)
    rows, labels, clip_ids, names = [], [], [], []
    for index, (label, text, voice, samples) in enumerate(clips):
        windows = extractor.windows(samples)
        if windows.shape[0] == 0:
            print(f"  (skipping {voice} {text!r}: shorter than one 80 ms frame)")
            continue
        rows.append(windows.reshape(windows.shape[0], -1))
        labels.append(np.full(windows.shape[0], label, dtype=np.int64))
        clip_ids.append(np.full(windows.shape[0], index, dtype=np.int64))
        names.append((text, voice))
    return np.vstack(rows), np.concatenate(labels), np.concatenate(clip_ids), names


def grouped_folds(labels: np.ndarray, clip_ids: np.ndarray):
    """Five folds, split by clip so no clip contributes to both sides."""
    unique = np.unique(clip_ids)
    clip_labels = np.array([labels[clip_ids == clip][0] for clip in unique])
    splitter = StratifiedKFold(n_splits=5, shuffle=True, random_state=0)
    for train_clips, test_clips in splitter.split(unique, clip_labels):
        train = np.concatenate([np.where(clip_ids == unique[i])[0] for i in train_clips])
        test = np.concatenate([np.where(clip_ids == unique[i])[0] for i in test_clips])
        yield train, test


def main() -> int:
    print("== synthesising the probe set ==")
    clips = asyncio.run(collect())
    positives = sum(1 for label, *_ in clips if label == 1)
    print(f"  {len(clips)} clips: {positives} positive, {len(clips) - positives} negative")
    print(f"  voices: {len(PROBE_VOICES)}")

    print()
    print("== extracting features ==")
    features, labels, clip_ids, names = featurise(clips)
    print(f"  {features.shape[0]} windows x {features.shape[1]} dims "
          f"({len(names)} clips, ~{features.shape[0]/max(1, len(names)):.0f} windows each)")

    # No `class_weight="balanced"` here, and that omission is the fix for the first run of this probe:
    # with the clip score taken as a maximum, weighting the minority class pushes the model into
    # calling nearly everything positive, so every long negative clip finds a window near 1.0 and the
    # clip AUC collapses to chance no matter how good the features are.
    model = LogisticRegression(max_iter=3000, C=0.05)
    print()
    print("== window-level separation (5-fold, grouped by clip) ==")
    window_scores = cross_val_predict(model, features, labels, cv=list(grouped_folds(labels, clip_ids)),
                                      method="predict_proba")[:, 1]
    print(f"  window AUC: {roc_auc_score(labels, window_scores):.4f}")
    positive_windows = window_scores[labels == 1]
    negative_windows = window_scores[labels == 0]
    print(f"  positives: mean {positive_windows.mean():.3f}  "
          f"p50 {np.percentile(positive_windows, 50):.3f}  "
          f"p90 {np.percentile(positive_windows, 90):.3f}")
    print(f"  negatives: mean {negative_windows.mean():.3f}  "
          f"p50 {np.percentile(negative_windows, 50):.3f}  "
          f"p90 {np.percentile(negative_windows, 90):.3f}  "
          f"p99 {np.percentile(negative_windows, 99):.3f}")

    # One window above threshold is all it takes to fire, so a clip is scored by its loudest window.
    best: dict[int, float] = {}
    for index, score in enumerate(window_scores):
        clip = int(clip_ids[index])
        best[clip] = max(best.get(clip, 0.0), float(score))
    clip_order = np.unique(clip_ids)
    clip_labels = np.array([labels[clip_ids == clip][0] for clip in clip_order])
    clip_values = np.array([best.get(int(clip), 0.0) for clip in clip_order])

    print()
    print("== clip-level separation (each clip by its best window) ==")
    print(f"  clip AUC: {roc_auc_score(clip_labels, clip_values):.4f}")
    print()

    positive_scores = sorted(clip_values[clip_labels == 1], reverse=True)
    negative_scores = sorted(clip_values[clip_labels == 0], reverse=True)
    print(f"  positives ({len(positive_scores)}), strongest first:")
    print("   ", " ".join(f"{score:.2f}" for score in positive_scores))
    print(f"  negatives ({len(negative_scores)}), strongest first:")
    print("   ", " ".join(f"{score:.2f}" for score in negative_scores[:12]),
          "..." if len(negative_scores) > 12 else "")
    print()

    weakest_positive = min(positive_scores) if positive_scores else 0.0
    strongest_negative = max(negative_scores) if negative_scores else 0.0
    if weakest_positive > strongest_negative:
        print(f"  SEPARABLE — every positive is at least {weakest_positive:.2f} and every negative at")
        print(f"  most {strongest_negative:.2f}: a threshold anywhere between them works. The embedding")
        print("  space carries the distinction, so the DNN has something to learn. Proceed.")
    else:
        overlap = sum(1 for score in negative_scores if score >= weakest_positive)
        print(f"  OVERLAP — {overlap} negative clip(s) score at or above the weakest positive")
        print(f"  (weakest positive {weakest_positive:.2f}, strongest negative {strongest_negative:.2f}).")
        print("  A linear probe is not the DNN, so this is a warning rather than a verdict; more")
        print("  negatives and more voices are the first things to try.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
