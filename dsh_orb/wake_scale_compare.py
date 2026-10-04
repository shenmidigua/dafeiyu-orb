"""Which input scale should the training features be built at?

`wake.js` hands the melspectrogram model raw AudioWorklet floats in [-1, 1]. openWakeWord's own
Python hands it int16-valued floats. Measured on the shipped mel model, the two outputs are
perfectly correlated and separated by a constant 90.3 — which is 10*log10(32767**2), the signature of
a plain `10*log10(energy)` with no normalisation inside the model. After the `/10 + 2` transform both
paths apply, that is a fixed offset of 9.03 sitting on top of a signal that spans about four units.

So one of the two is feeding the embedding model outside the range it was fitted to. `AudioFeatures`
initialises its mel buffer to `np.ones(...)`, i.e. 1.0, and the float path's real speech lands near
1.0 while the int16 path's lands near 10 — which is suggestive, not conclusive. The question that
decides it is the one that matters downstream: which path makes 大肥鱼 *separable*.

Three candidates, same probe as `wake_separability.py`, same data:

  orb-float    scale=1.0       exactly what the orb runs today
  orb-int16    scale=32767.0   what the orb would run after a one-line change to wake.js
  oww-int16    openWakeWord's own Python, as the reference implementation

If orb-int16 clearly beats orb-float, the fix is worth making: the embedding model would be getting
in-distribution input, and both the trained classifier and the existing hey_jarvis would sharpen.

Real synthesised clips are used rather than a fresh probe set, so the comparison runs against the
data the model will actually be trained on.
"""

from __future__ import annotations

import pathlib
import random
import sys

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedKFold, cross_val_predict

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_dataset import pool_from, warm_windows  # noqa: E402
from wake_features import OrbFeatures, FeatureExtractor, pcm16_from_wav  # noqa: E402

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
POSITIVE_DIR = DATA / "positives"
NEGATIVE_DIR = DATA / "negatives"

# Enough clips to make the AUC meaningful, few enough that three variants stay quick. Grouped
# cross-validation needs several clips per fold on the positive side or it measures the split.
POSITIVES = 150
NEGATIVES = 150

# Where the model fires is a threshold on one window, so a clip is judged by its best window.
FOLDS = 5


def sample() -> list[tuple[int, pathlib.Path]]:
    """A deterministic slice of the real dataset, balanced across the two negative kinds."""
    rng = random.Random(0)
    positives = sorted(POSITIVE_DIR.glob("positive-*.wav"))
    adversarial = sorted(NEGATIVE_DIR.glob("adversarial-*.wav"))
    filler = sorted(NEGATIVE_DIR.glob("filler-*.wav"))
    if not positives or not adversarial or not filler:
        raise SystemExit(f"dataset incomplete under {DATA}; run wake_dataset.py synth first")

    chosen: list[tuple[int, pathlib.Path]] = [(1, path) for path in rng.sample(positives, POSITIVES)]
    # Split evenly: the adversarial words are the hard negatives and the filler is the easy mass, and
    # a probe dominated by either one answers a different question than the one being asked.
    chosen += [(0, path) for path in rng.sample(adversarial, NEGATIVES // 2)]
    chosen += [(0, path) for path in rng.sample(filler, NEGATIVES // 2)]
    rng.shuffle(chosen)
    return chosen


def windows_for(clips, extractor) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Flatten every clip's windows, carrying clip identity so folds never split a clip.

    Every clip is preceded by a warm-up. Comparing scales on cold rings would compare them in a state
    the orb is never in — see `wake_features.WARMUP_FRAMES` — and would have judged the scale question
    on audio that does not occur.
    """
    pool_audio = pool_from(NEGATIVE_DIR, limit=400)
    warm_rng = random.Random(0)
    rows, labels, clip_ids = [], [], []
    for index, (label, path) in enumerate(clips):
        windows = warm_windows(extractor, pcm16_from_wav(path), pool_audio, warm_rng,
                               np.random.default_rng(index))
        if windows.shape[0] == 0:
            continue
        rows.append(windows.reshape(windows.shape[0], -1))
        labels.append(np.full(windows.shape[0], label, dtype=np.int64))
        clip_ids.append(np.full(windows.shape[0], index, dtype=np.int64))
    return np.vstack(rows), np.concatenate(labels), np.concatenate(clip_ids)


def grouped_folds(labels: np.ndarray, clip_ids: np.ndarray):
    unique = np.unique(clip_ids)
    clip_labels = np.array([labels[clip_ids == clip][0] for clip in unique])
    splitter = StratifiedKFold(n_splits=FOLDS, shuffle=True, random_state=0)
    for train_clips, test_clips in splitter.split(unique, clip_labels):
        yield (np.concatenate([np.where(clip_ids == unique[i])[0] for i in train_clips]),
               np.concatenate([np.where(clip_ids == unique[i])[0] for i in test_clips]))


def probe(name: str, extractor, clips) -> dict:
    features, labels, clip_ids = windows_for(clips, extractor)
    model = LogisticRegression(max_iter=3000, C=0.05)
    scores = cross_val_predict(model, features, labels, cv=list(grouped_folds(labels, clip_ids)),
                               method="predict_proba")[:, 1]

    best: dict[int, float] = {}
    for index, score in enumerate(scores):
        clip = int(clip_ids[index])
        best[clip] = max(best.get(clip, 0.0), float(score))
    order = np.unique(clip_ids)
    clip_labels = np.array([labels[clip_ids == clip][0] for clip in order])
    clip_values = np.array([best.get(int(clip), 0.0) for clip in order])

    positive_values = clip_values[clip_labels == 1]
    negative_values = clip_values[clip_labels == 0]
    weakest_positive = float(positive_values.min())
    strongest_negative = float(negative_values.max())
    result = {
        "name": name,
        "clip_auc": roc_auc_score(clip_labels, clip_values),
        "window_auc": roc_auc_score(labels, scores),
        "pos_p10": float(np.percentile(positive_values, 10)),
        "neg_p90": float(np.percentile(negative_values, 90)),
        "weakest_positive": weakest_positive,
        "strongest_negative": strongest_negative,
        "overlap": int((negative_values >= weakest_positive).sum()),
        "neg_total": int(negative_values.size),
    }
    return result


def main() -> int:
    clips = sample()
    positive_count = sum(1 for label, _ in clips if label == 1)
    print(f"  {len(clips)} clips: {positive_count} positive, {len(clips) - positive_count} negative")
    print()

    variants = [
        ("orb-float", OrbFeatures(ncpu=4, scale=1.0)),
        ("orb-int16", OrbFeatures(ncpu=4, scale=32767.0)),
        ("oww-int16", FeatureExtractor(ncpu=4)),
    ]

    results = [probe(name, extractor, clips) for name, extractor in variants]

    print(f"  {'variant':12} {'clip AUC':>9} {'win AUC':>9} {'pos p10':>8} {'neg p90':>8} "
          f"{'overlap':>9}")
    print("  " + "-" * 62)
    for result in results:
        print(f"  {result['name']:12} {result['clip_auc']:9.4f} {result['window_auc']:9.4f} "
              f"{result['pos_p10']:8.3f} {result['neg_p90']:8.3f} "
              f"{result['overlap']:4d}/{result['neg_total']:<4d}")
    print()

    ranked = sorted(results, key=lambda item: item["clip_auc"], reverse=True)
    winner = ranked[0]
    print(f"  BEST: {winner['name']}  (clip AUC {winner['clip_auc']:.4f}, "
          f"{winner['overlap']}/{winner['neg_total']} negatives at or above the weakest positive)")
    print()
    float_result = next(item for item in results if item["name"] == "orb-float")
    int16_result = next(item for item in results if item["name"] == "orb-int16")
    gap = int16_result["clip_auc"] - float_result["clip_auc"]
    print(f"  orb-int16 minus orb-float: {gap:+.4f} clip AUC")
    if gap > 0.02:
        print("  -> Scaling the frame to int16 inside wake.js is worth doing: the embedding model is")
        print("     getting in-distribution input, and the gain is real, not noise.")
    elif gap < -0.02:
        print("  -> Leave wake.js alone. Whatever the offset does to the embedding model, the")
        print("     shipped path is the one that separates better.")
    else:
        print("  -> Within noise. Keep the shipped path (no code change) and train on orb-float;")
        print("     the two differ by a constant the embedding model evidently absorbs.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
