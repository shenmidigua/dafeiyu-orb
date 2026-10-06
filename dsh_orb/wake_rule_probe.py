"""Does the *decision rule* actually quiet the orb, or only the threshold?

The shipped engine fires the moment one window crosses `threshold`. A window lands every 128 ms of
speech, so an hour of talking is ~28k chances to cross, and `wake_eval.py` measures the residue as
8.9 false alarms per hour of speech at the deployed 0.95. Everything above 0.95 that the grid can
reach (0.99, where the helper clamps) moves that number not at all, because no filler window was
scoring in between. So the threshold is, in practice, already spent.

That leaves the rule. Three candidates, all evaluated on the same held-out clips `wake_eval.py`
used, with the ring warmed exactly as training does it:

  single  the shipped rule: one window above threshold fires
  run     k *consecutive* windows above threshold fire (kills isolated spikes)
  mean    the mean of the last k windows above threshold (softer; keeps most of a real peak)

Firing is simulated rather than counted, because the engine is not memoryless: it goes deaf for
`COOLDOWN_MS` after a detection, so a long run of high windows is one alarm, not twenty. Counting
raw windows would overstate every rule equally and hide the difference the user actually hears.

Run with the interpreter the rest of the wake-word pipeline uses (see `wake_pipeline.py`):

    D:\\tools\\indextts\\py311\\python.exe wake_rule_probe.py [--limit 40]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
import time

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
FEATURE_DIR = DATA / "features"
MODEL = FEATURE_DIR / "dafeiyu.onnx"
CHECKPOINT = FEATURE_DIR / "dafeiyu.pt"
REPORT = FEATURE_DIR / "dafeiyu-rule-probe.json"

MODEL_DIR = pathlib.Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\dsh-voice-dialog\assets")

# One window per 128 ms of speech, and 2.5 s of deafness after every detection: both copied from
# `wake.js` rather than guessed, because the whole point is to model the shipped engine.
WINDOW_MS = 128.0
COOLDOWN_MS = 2500.0

# The step matters as much as the range. 0.99 is where the helper clamps, so it is the roof; 0.96 and
# 0.97 are in the grid because that is where the user's remaining false wakes read on the meter, and a
# line drawn between two adjacent sample points would be a guess about a population nobody measured.
# Read the two columns together: `fires/hour` is what a higher line buys, `recall` is what it costs,
# and on this corpus an earlier run found the buy to be *nothing* while the cost is not.
THRESHOLDS = (0.95, 0.96, 0.97, 0.98, 0.99)
# `run 4` and `run 5` are here for the prefix-negative model. Labelling the positive clips' own prefix
# windows moved the boundary off the phrase's last slot, and the margin that opened up is *between* the
# phrase and the truncations rather than under the threshold: measured with `wake_truncation_probe.py`
# at five voices and ten warm-ups, the whole phrase holds seven consecutive windows where the worst
# truncation holds three. At `run 4` that gap is a decision; at `run 3` it is a coin toss, which is why
# the remaining truncation fires in one voice out of five on a run of exactly three.
RULES = (
    ("single", 1),
    ("run", 2),
    ("run", 3),
    ("run", 4),
    ("run", 5),
    ("mean", 2),
    ("mean", 3),
)


def clip_scores(session, extractor, files, rng, pool, note="", limit=0):
    """Ordered window scores per clip — the order is the point, `run` needs it.

    One window per call. Batching would be the obvious speedup and does not work: the exported
    graph pins the leading dimension to 1 (`Got: 21 Expected: 1`), which is also why `wake.js`
    runs one window at a time in production.
    """
    feed = session.get_inputs()[0].name
    out: list[np.ndarray] = []
    started = time.time()
    considered = 0
    for path in files:
        if limit and considered >= limit:
            break
        considered += 1
        windows = warm_windows(extractor, pcm16_from_wav(path), pool, rng,
                               np.random.default_rng(considered))
        if windows.shape[0] == 0:
            out.append(np.zeros(0, dtype=np.float32))
            continue
        scores = np.empty(windows.shape[0], dtype=np.float32)
        for index in range(windows.shape[0]):
            scores[index] = session.run(None, {feed: windows[index][None, :, :]})[0].ravel()[0]
        out.append(scores)
        if considered % 200 == 0:
            print(f"    {note}{considered} clips, {time.time() - started:.0f}s", flush=True)
    print(f"    {note}{considered} clips, {time.time() - started:.0f}s", flush=True)
    return out


def fired_runs(scores: np.ndarray, threshold: float, mode: str, k: int,
               cooldown_windows: float) -> tuple[int, bool]:
    """Simulate the engine over one clip: how many detections, and did it detect at all.

    The rule decides which windows *ask* to fire; the cooldown decides which of those actually do,
    which is what makes a 3-window rule and a 1-window rule comparable on the same clip.
    """
    if scores.size == 0:
        return 0, False
    above = scores > threshold
    if mode == "single":
        candidates = above
    elif mode == "run":
        candidates = np.zeros_like(above)
        if scores.size >= k:
            stacked = np.ones(scores.size, dtype=bool)
            for offset in range(k):
                stacked[:offset + 1] = False
                shifted = np.zeros_like(above)
                shifted[offset:] = above[:scores.size - offset]
                stacked &= shifted
            candidates = stacked
    elif mode == "mean":
        # Mean of the trailing k windows: a real phrase holds the peak up for a few windows, an
        # isolated spike does not survive the division by k.
        smoothed = np.convolve(scores, np.ones(k) / k, mode="full")[:scores.size]
        candidates = smoothed > threshold
    else:
        raise ValueError(mode)

    fires = 0
    last = -cooldown_windows
    for index in np.flatnonzero(candidates):
        if index - last > cooldown_windows:
            fires += 1
            last = index
    return fires, fires > 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=0,
                        help="score only the first N clips of each set (plumbing smoke test)")
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--folds", type=int, default=5,
                        help="fold count the model was trained with; only used if the checkpoint "
                             "is missing, and the held-out fold is `folds - 1`")
    args = parser.parse_args()

    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; run wake_train.py first")

    # The checkpoint is the natural place to read the held-out fold number from, and it is not always
    # there: `wake_train.py` overwrites `dafeiyu.pt` on every run, so a run that is later rejected takes
    # the previous checkpoint with it — which is what happened, and it made this probe unrunnable.
    # The number is not actually lost: only the *number* needs recovering, because the assignment
    # itself is on disk in `folds-*.npy`, and the number is derived (`fold = folds - 1`). Recovering it
    # silently would be the dangerous version: a wrong fold number still produces a full table of
    # plausible numbers, measured against clips the model was trained on, and nothing would look wrong.
    # So the source is named in the output.
    if CHECKPOINT.exists():
        import torch
        held_out_fold = torch.load(CHECKPOINT, map_location="cpu").get("fold")
        origin = CHECKPOINT.name
    else:
        held_out_fold = args.folds - 1
        origin = f"derived from --folds {args.folds} ({CHECKPOINT.name} is missing)"

    positives = sorted((DATA / "positives").glob("positive-*.wav"))
    adversarial = sorted((DATA / "negatives").glob("adversarial-*.wav"))
    filler = sorted((DATA / "negatives").glob("filler-*.wav"))
    positive_folds = np.load(FEATURE_DIR / "folds-positive.npy")
    negative_folds = np.load(FEATURE_DIR / "folds-negative.npy")
    positive_names = json.loads((FEATURE_DIR / "positive-names.json").read_text(encoding="utf-8"))
    negative_names = json.loads((FEATURE_DIR / "negative-names.json").read_text(encoding="utf-8"))

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
    print(f"  model {MODEL.name} (sha aside), held-out fold {held_out_fold} from {origin}")
    print(f"  held-out clips: {len(held_positive)} positive, {len(held_adversarial)} near-miss, "
          f"{len(held_filler)} filler")

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"],
                                   sess_options=_session_options(args.threads))
    extractor = OrbFeatures(ncpu=args.threads)
    pool = [pcm16_from_wav(path) for path in held_filler]
    rng = random.Random(0)
    print("  scoring positives ...")
    pos = clip_scores(session, extractor, held_positive, rng, pool, "positives ", args.limit)
    print("  scoring near-misses ...")
    near = clip_scores(session, extractor, held_adversarial, rng, pool, "near-miss ", args.limit)
    print("  scoring filler ...")
    fill = clip_scores(session, extractor, held_filler, rng, pool, "filler ", args.limit)

    cooldown_windows = COOLDOWN_MS / WINDOW_MS
    windows_per_hour = 3_600_000.0 / WINDOW_MS
    total_filler_windows = float(sum(scores.size for scores in fill)) or 1.0

    rows = []
    print()
    print(f"  {'rule':>8} {'thr':>6} {'recall':>8} {'near-miss FP':>13} {'filler FP':>10} "
          f"{'fires/hour':>11} {'saved':>7}")
    print("  " + "-" * 72)
    baseline = {}
    for threshold in THRESHOLDS:
        for mode, k in RULES:
            label = f"{mode}{k}" if mode != "single" else "single"
            pos_hits = [fired_runs(scores, threshold, mode, k, cooldown_windows) for scores in pos]
            near_hits = [fired_runs(scores, threshold, mode, k, cooldown_windows)
                         for scores in near]
            fill_hits = [fired_runs(scores, threshold, mode, k, cooldown_windows) for scores in fill]
            recall = float(np.mean([hit for _, hit in pos_hits]))
            near_fp = float(np.mean([hit for _, hit in near_hits]))
            filler_fp = float(np.mean([hit for _, hit in fill_hits]))
            fires = float(sum(count for count, _ in fill_hits))
            per_hour = fires / total_filler_windows * windows_per_hour
            if label == "single":
                baseline[threshold] = per_hour
            saved = 1.0 - per_hour / baseline[threshold] if baseline.get(threshold) else 0.0
            rows.append({"rule": label, "k": k, "mode": mode, "threshold": threshold,
                         "recall": recall, "near_miss_clip_fp": near_fp,
                         "filler_clip_fp": filler_fp,
                         "fires_per_hour_of_speech": per_hour,
                         "saved_vs_single": saved})
            print(f"  {label:>8} {threshold:6.2f} {recall:8.1%} {near_fp:13.1%} {filler_fp:10.1%} "
                  f"{per_hour:11.1f} {saved:7.1%}")

    print()
    print("  fires/hour is over held-out filler windows only, matching `wake_eval.py`'s denominator")

    # The residual flips between rules have to be looked at individually: "the run rule removed 90%
    # of alarms" is worthless if the alarms it kept are the loud ones.
    print()
    for threshold in THRESHOLDS:
        single = [fired_runs(scores, threshold, "single", 1, cooldown_windows) for scores in fill]
        run3 = [fired_runs(scores, threshold, "run", 3, cooldown_windows) for scores in fill]
        kept = [index for index, ((_, s), (_, r)) in enumerate(zip(single, run3)) if s and r]
        print(f"  thr {threshold:.2f}: single fires on {sum(1 for _, s in single if s)} filler "
              f"clips, run3 still fires on {sum(1 for _, r in run3 if r)}"
              f"{'; survivors: ' + ', '.join(held_filler[i].name for i in kept[:6]) if kept else ''}")

    REPORT.write_text(json.dumps({"model": str(MODEL), "held_out_fold": held_out_fold,
                                  "cooldown_ms": COOLDOWN_MS, "window_ms": WINDOW_MS,
                                  "limit": args.limit, "rows": rows}, indent=2),
                      encoding="utf-8")
    print(f"  report: {REPORT}")
    return 0


def _session_options(threads: int):
    options = ort.SessionOptions()
    options.intra_op_num_threads = threads
    return options


if __name__ == "__main__":
    raise SystemExit(main())
