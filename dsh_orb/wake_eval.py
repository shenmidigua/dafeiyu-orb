"""Evaluate the exported `dafeiyu.onnx` the way the orb will run it, and pick a threshold.

This scores the ONNX file, not the PyTorch checkpoint. That is deliberate: the artifact that ships is
the graph, and every previous failure in this project came from a difference between what was tested
and what ran. `wake_train.py` already proved the two agree numerically to 5e-7; this checks the graph
against audio.

The numbers are reported two ways, because they answer different questions:

  * **Clip level** — "if the user says 大肥鱼, does the orb wake?" One window above threshold fires, so
    a clip is scored by its best window.
  * **Window level** — "how often does it fire while nobody is saying it?" A window is emitted roughly
    every 128 ms of speech, so the filler window rate converts directly into false alarms per hour.

The split comes from `folds-*.npy`, written by the trainer. Re-deriving it here would mean replaying
the trainer's RNG in the same order, and getting that subtly wrong would report a training score as a
held-out one.
"""

from __future__ import annotations

import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
FEATURE_DIR = DATA / "features"
MODEL = FEATURE_DIR / "dafeiyu.onnx"
REPORT = FEATURE_DIR / "dafeiyu-eval.json"

# One window lands about every 1.6 audio frames of 80 ms on this path (wake.js pushes 5 mel frames per
# frame and consumes 8 per embedding), so a window represents ~128 ms of audio.
WINDOW_MS = 128.0

# What the shipped classifier scores on the same negative material, for context on whether a trained
# model is actually better than the one it replaces. It has never heard Chinese, so this is a floor.
THRESHOLDS = (0.30, 0.40, 0.50, 0.60, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95)


def score_clips(session, extractor, files: list[pathlib.Path], rng, pool_audio: list[np.ndarray],
                batch_note: str = "") -> tuple[np.ndarray, np.ndarray]:
    """Best-window score per clip, plus the raw window scores.

    Each clip is preceded by a warm-up, because that is the state the embedding ring is in whenever
    the orb is listening. Scoring clips from a cold ring measures a condition that never occurs and
    is wrong in the optimistic direction — see `wake_features.WARMUP_FRAMES`.

    Every window is scored, not only the ones a positive label would accept: the engine fires on any
    window above threshold, so the maximum over all of them is what decides whether the orb wakes.
    """
    feed = session.get_inputs()[0].name
    best = []
    all_windows = []
    for index, path in enumerate(files, 1):
        windows = warm_windows(extractor, pcm16_from_wav(path), pool_audio, rng,
                               np.random.default_rng(index))
        if windows.shape[0] == 0:
            best.append(0.0)
            continue
        scores = np.array([session.run(None, {feed: window[None, :, :]})[0].ravel()[0]
                           for window in windows], dtype=np.float32)
        best.append(float(scores.max()))
        all_windows.append(scores)
        if index % 250 == 0:
            print(f"    {batch_note}{index}/{len(files)}")
    return (np.array(best, dtype=np.float32),
            np.concatenate(all_windows) if all_windows else np.zeros(0, dtype=np.float32))


def main() -> int:
    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; run wake_train.py first")

    # The held-out fold comes from the trainer's own checkpoint rather than being assumed, so this
    # file cannot silently evaluate a model on the clips it was fitted to.
    checkpoint = FEATURE_DIR / "dafeiyu.pt"
    if not checkpoint.exists():
        raise SystemExit(f"{checkpoint} missing; run wake_train.py first")
    import torch
    held_out_fold = torch.load(checkpoint, map_location="cpu").get("fold")

    positives = sorted((DATA / "positives").glob("positive-*.wav"))
    negatives = sorted((DATA / "negatives").glob("adversarial-*.wav"))
    filler = sorted((DATA / "negatives").glob("filler-*.wav"))

    # Fold arrays are positional over the clips that survived feature extraction — 1455 of the 1470
    # positive wavs, the short ones having produced no window at all. So clips are matched by filename
    # through the manifests rather than by position in the directory listing, which would shift by the
    # dropped clips and quietly score trained-on audio as held out.
    positive_folds = np.load(FEATURE_DIR / "folds-positive.npy")
    negative_folds = np.load(FEATURE_DIR / "folds-negative.npy")
    positive_names = json.loads((FEATURE_DIR / "positive-names.json").read_text(encoding="utf-8"))
    negative_names = json.loads((FEATURE_DIR / "negative-names.json").read_text(encoding="utf-8"))

    def select(files: list[pathlib.Path], names: list[str], folds: np.ndarray, only_held_out: bool):
        """Filter to the clips whose fold matches, looking the fold up by filename."""
        index = {name: position for position, name in enumerate(names)}
        keep = []
        for path in files:
            position = index.get(path.name)
            if position is None:
                continue
            is_held_out = folds[position] == held_out_fold
            if is_held_out == only_held_out:
                keep.append(path)
        return keep

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    extractor = OrbFeatures(ncpu=4)
    print(f"  model {MODEL.name}, held-out fold {held_out_fold}")
    print("  every number below is from clips the model never saw.")

    print("  scoring held-out positives ...")
    held_positive = select(positives, positive_names, positive_folds, True)
    print("  scoring held-out near-misses ...")
    held_adversarial = select(negatives, negative_names, negative_folds, True)
    print("  scoring held-out filler ...")
    held_filler = select(filler, negative_names, negative_folds, True)
    print(f"  held-out clips: {len(held_positive)} positive, {len(held_adversarial)} near-miss, "
          f"{len(held_filler)} filler")

    # Warm-up material, drawn from the held-out filler only. It fills the ring before every scored
    # clip, and the ring is most of every window, so warm-up drawn from training material would make
    # the "held out" claim false for the bulk of the input.
    held_pool = [pcm16_from_wav(path) for path in held_filler]
    if not held_pool:
        raise SystemExit("no held-out filler to warm up with; the numbers would not mean anything")

    import random
    warm_rng = random.Random(0)
    positive_best, positive_windows = score_clips(session, extractor, held_positive, warm_rng,
                                                  held_pool, "positives ")
    adversarial_best, adversarial_windows = score_clips(session, extractor, held_adversarial, warm_rng,
                                                        held_pool, "near-miss ")
    filler_best, filler_windows = score_clips(session, extractor, held_filler, warm_rng,
                                              held_pool, "filler ")

    print()
    print(f"  {'threshold':>10} {'recall':>8} {'near-miss clip FP':>18} {'filler clip FP':>15} "
          f"{'filler win FP':>14} {'FA/hour':>9}")
    print("  " + "-" * 80)
    rows = []
    for threshold in THRESHOLDS:
        recall = float((positive_best >= threshold).mean())
        hard_fp = float((adversarial_best >= threshold).mean())
        filler_fp = float((filler_best >= threshold).mean())
        window_fp = float((filler_windows >= threshold).mean())
        # Only meaningful while speech is present — the orb gates on VAD, so silence never reaches the
        # classifier and there is nothing to count there.
        per_hour = window_fp * (3_600_000.0 / WINDOW_MS)
        rows.append({"threshold": threshold, "recall": recall, "near_miss_clip_fp": hard_fp,
                     "filler_clip_fp": filler_fp, "filler_window_fp": window_fp,
                     "false_alarms_per_hour_of_speech": per_hour})
        print(f"  {threshold:10.2f} {recall:8.1%} {hard_fp:18.1%} {filler_fp:15.1%} "
              f"{window_fp:14.2%} {per_hour:9.1f}")

    pooled_positive = np.concatenate([np.ones(positive_best.size), np.zeros(adversarial_best.size),
                                      np.zeros(filler_best.size)])
    pooled_values = np.concatenate([positive_best, adversarial_best, filler_best])
    from sklearn.metrics import roc_auc_score
    pooled_auc = roc_auc_score(pooled_positive, pooled_values)

    print()
    print(f"  held-out clip AUC (positives vs both negative kinds): {pooled_auc:.4f}")
    print(f"  positive clip scores: p05 {np.percentile(positive_best, 5):.3f}  "
          f"p50 {np.percentile(positive_best, 50):.3f}")
    print(f"  near-miss scores    : p50 {np.percentile(adversarial_best, 50):.3f}  "
          f"p95 {np.percentile(adversarial_best, 95):.3f}  "
          f"p99 {np.percentile(adversarial_best, 99):.3f}")
    print(f"  filler scores       : p50 {np.percentile(filler_best, 50):.3f}  "
          f"p95 {np.percentile(filler_best, 95):.3f}  "
          f"p99 {np.percentile(filler_best, 99):.3f}")

    # Chosen, not maximised: a wake word that sometimes ignores its owner is worse than one that
    # occasionally misunderstands a near-miss, because the user cannot tell whether it is broken.
    # The rule is therefore "highest threshold still keeping recall at or above 97%".
    viable = [row for row in rows if row["recall"] >= 0.97]
    chosen = max(viable, key=lambda row: row["threshold"]) if viable else max(
        rows, key=lambda row: row["recall"])
    print()
    print(f"  chosen threshold: {chosen['threshold']:.2f}  "
          f"(recall {chosen['recall']:.1%}, near-miss clip FP {chosen['near_miss_clip_fp']:.1%}, "
          f"filler clip FP {chosen['filler_clip_fp']:.1%}, "
          f"{chosen['false_alarms_per_hour_of_speech']:.1f} false alarms/hour of speech)")

    report = {"model": str(MODEL), "held_out_fold": held_out_fold,
              "clips": {"positive": len(held_positive), "near_miss": len(held_adversarial),
                        "filler": len(held_filler)},
              "clip_auc": pooled_auc, "thresholds": rows, "chosen": chosen}
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"  report: {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
