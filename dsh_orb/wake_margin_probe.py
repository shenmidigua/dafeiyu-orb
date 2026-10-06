"""How much room is there between the positives and the negatives, in windows?

`wake_rule_probe.py` answered "does run-3 quiet the orb" and the answer was yes: zero held-out
negatives survive it. That is a verdict, not a margin, and the two are different questions. A rule
that lands exactly on the boundary between the two populations looks perfect on the day it is chosen
and fails on the first clip that arrives slightly shifted — which, for a model trained and evaluated
entirely on synthetic voices, is the expected outcome rather than an unlucky one.

So this measures the distance rather than the verdict:

  * For every positive, the longest run of consecutive windows above the threshold. Its lower
    percentile is the ceiling on how strict the rule can get for free.
  * For every negative, the same statistic. Its maximum is the floor the rule has to clear.
  * The gap between those two numbers is the margin, and it is what says whether the deployed
    `CONSECUTIVE_WINDOWS = 3` is a considered choice or a coincidence.

Everything is clip level and without cooldown on purpose. The question here is "can this clip ever
produce such a run", and folding the cooldown in would mix in how many alarms a clip produces, which
`wake_rule_probe.py` already owns.

Run with the interpreter the rest of the wake-word pipeline uses (see `wake_pipeline.py`):

    D:\\tools\\indextts\\py311\\python.exe wake_margin_probe.py [--limit 40]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_rule_probe as rule  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

REPORT = rule.FEATURE_DIR / "dafeiyu-margin-probe.json"

# The deployed threshold first, then the neighbourhood, so the shape of the gap can be seen rather
# than only its value at one point.
THRESHOLDS = (0.90, 0.95, 0.97, 0.99)

# The run lengths worth a verdict, because they are the candidate rules: 3 is shipped.
CANDIDATE_RUNS = (2, 3, 4, 5, 6, 8)


def longest_run(scores: np.ndarray, threshold: float) -> int:
    """Longest stretch of consecutive windows strictly above `threshold`.

    Strictly above, matching `wake.js`'s `score > threshold`. `>=` would move the answer on the clips
    that sit exactly on the line, which is precisely the population this file exists to look at.
    """
    best = 0
    current = 0
    for value in scores:
        if value > threshold:
            current += 1
            if current > best:
                best = current
        else:
            current = 0
    return best


def describe(values: list[int]) -> dict:
    array = np.array(values, dtype=np.int32)
    return {
        "n": int(array.size),
        "p01": int(np.percentile(array, 1)),
        "p05": int(np.percentile(array, 5)),
        "p25": int(np.percentile(array, 25)),
        "p50": int(np.percentile(array, 50)),
        "max": int(array.max()),
        "share_at_least": {str(k): float((array >= k).mean()) for k in CANDIDATE_RUNS},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0,
                        help="score only the first N clips of each set (plumbing smoke test)")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()

    if not rule.MODEL.exists():
        raise SystemExit(f"{rule.MODEL} does not exist; run wake_train.py first")

    import torch
    held_out_fold = torch.load(rule.CHECKPOINT, map_location="cpu").get("fold")

    positives = sorted((rule.DATA / "positives").glob("positive-*.wav"))
    adversarial = sorted((rule.DATA / "negatives").glob("adversarial-*.wav"))
    filler = sorted((rule.DATA / "negatives").glob("filler-*.wav"))
    positive_folds = np.load(rule.FEATURE_DIR / "folds-positive.npy")
    negative_folds = np.load(rule.FEATURE_DIR / "folds-negative.npy")
    positive_names = json.loads((rule.FEATURE_DIR / "positive-names.json").read_text(encoding="utf-8"))
    negative_names = json.loads((rule.FEATURE_DIR / "negative-names.json").read_text(encoding="utf-8"))

    def select(files, names, folds, only_held_out):
        index = {name: position for position, name in enumerate(names)}
        keep = []
        for path in files:
            position = index.get(path.name)
            if position is None:
                continue
            if (folds[position] == held_out_fold) == only_held_out:
                keep.append(path)
        return keep

    held_positive = select(positives, positive_names, positive_folds, True)
    held_adversarial = select(adversarial, negative_names, negative_folds, True)
    held_filler = select(filler, negative_names, negative_folds, True)
    print(f"  model {rule.MODEL.name}, held-out fold {held_out_fold}")
    print(f"  held-out clips: {len(held_positive)} positive, {len(held_adversarial)} near-miss, "
          f"{len(held_filler)} filler")

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    session = ort.InferenceSession(str(rule.MODEL), providers=["CPUExecutionProvider"],
                                   sess_options=options)
    extractor = OrbFeatures(ncpu=args.threads)
    pool = [pcm16_from_wav(path) for path in held_filler]
    rng = random.Random(0)

    print("  scoring positives ...")
    pos = rule.clip_scores(session, extractor, held_positive, rng, pool, "positives ", args.limit)
    print("  scoring near-misses ...")
    near = rule.clip_scores(session, extractor, held_adversarial, rng, pool, "near-miss ", args.limit)
    print("  scoring filler ...")
    fill = rule.clip_scores(session, extractor, held_filler, rng, pool, "filler ", args.limit)

    rows = []
    print()
    for threshold in THRESHOLDS:
        pos_runs = [longest_run(scores, threshold) for scores in pos]
        near_runs = [longest_run(scores, threshold) for scores in near]
        fill_runs = [longest_run(scores, threshold) for scores in fill]
        neg_runs = [max(a, b) for a, b in zip(near_runs, fill_runs)]

        pos_stats = describe(pos_runs)
        near_stats = describe(near_runs)
        fill_stats = describe(fill_runs)

        print(f"  == threshold {threshold:.2f} ==")
        print(f"    longest run, positives : p05 {pos_stats['p05']:>2}  p25 {pos_stats['p25']:>2}  "
              f"p50 {pos_stats['p50']:>2}")
        print(f"    longest run, near-miss : p50 {near_stats['p50']:>2}  "
              f"p95 {int(np.percentile(near_runs, 95)):>2}  max {near_stats['max']:>2}")
        print(f"    longest run, filler    : p50 {fill_stats['p50']:>2}  "
              f"p95 {int(np.percentile(fill_runs, 95)):>2}  max {fill_stats['max']:>2}")
        print(f"    {'rule':>6} {'recall':>8} {'neg clips surviving':>21}")
        for k in CANDIDATE_RUNS:
            recall = float(np.mean([run >= k for run in pos_runs]))
            survivors = int(np.sum([run >= k for run in neg_runs]))
            near_survivors = int(np.sum([run >= k for run in near_runs]))
            fill_survivors = int(np.sum([run >= k for run in fill_runs]))
            print(f"    run{k:<3} {recall:8.1%} {survivors:>8}  "
                  f"({near_survivors} near-miss + {fill_survivors} filler)")
        print()
        rows.append({
            "threshold": threshold,
            "positive": pos_stats,
            "near_miss": near_stats,
            "filler": fill_stats,
            "rules": [
                {
                    "k": k,
                    "recall": float(np.mean([run >= k for run in pos_runs])),
                    "near_miss_clips_surviving": int(np.sum([run >= k for run in near_runs])),
                    "filler_clips_surviving": int(np.sum([run >= k for run in fill_runs])),
                }
                for k in CANDIDATE_RUNS
            ],
        })

    # The verdict, stated as the two numbers that decide it: how strict the rule can get before a
    # held-out positive fails, and how far the strictness has to go before a held-out negative
    # survives. If those cross, the populations overlap and no run length fixes this; if they do not,
    # the gap is the margin and its width is the whole result.
    print("  ---- where the two populations are, in run length ----")
    for row in rows:
        threshold = row["threshold"]
        print(f"    thr {threshold:.2f}: worst positive run p01={row['positive']['p01']}, "
              f"best negative run max={max(row['near_miss']['max'], row['filler']['max'])}, "
              f"gap={row['positive']['p01'] - max(row['near_miss']['max'], row['filler']['max'])}")
    print()
    print("  A negative gap means a held-out positive is indistinguishable from a held-out negative")
    print("  by duration alone, and the rule has no margin to spend.")
    print()
    print("  Caveat this file cannot answer: every clip here is synthetic and every voice in the")
    print("  held-out fold was heard during training. Real speech is the unmeasured axis.")

    REPORT.write_text(json.dumps({"model": str(rule.MODEL), "held_out_fold": held_out_fold,
                                  "window_ms": rule.WINDOW_MS, "limit": args.limit,
                                  "rows": rows}, indent=2), encoding="utf-8")
    print(f"  report: {REPORT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
