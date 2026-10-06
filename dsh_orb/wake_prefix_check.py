"""Check that the prefix negatives are what the boundary fix assumes they are.

`extract` now writes a second file beside the positives: the same clips, windowed one, two and three
ring slots *before* the phrase's end, labelled negative. Four properties make that set worth training
on, and each of them fails silently in production if it stops holding:

  1. **In step.** One prefix batch per positive batch, same clip order, same names, same count. The two
     files are read as parallel arrays of clip ids, so a single clip dropping out of one shifts every
     id after it — and the shifted set is then split across the fold fence by different clips than the
     positives, which puts a clip's phrase in the held-out fold and its own prefix in training.
  2. **The expected count per clip.** Two windows per warm-up variant, three variants, and the offset
     rotates with the variant, so each offset in the band is seen behind two of the three preceding
     conversations. Fewer than the full count and the ring contents can become part of the label
     again — the failure `WARM_VARIANTS` exists to prevent.
  3. **Earlier, not equal.** No prefix window may equal any of the same clip's positive windows. This
     is the mislabelling that would look like a fix and be a no-op: labelling the positive window
     again, at weight 3, teaches the model that the phrase is both yes and no.
  4. **Mass.** The band has to stay a minority of the positive count. The last attempt at this defect
     tripled one phrase family's share of the negatives and cost ten times the false alarms; the
     check refuses a set that has grown the same way.

Usage:
    wake_prefix_check.py                 # the real feature files under ~/wakeword/data/features
    wake_prefix_check.py --smoke         # rebuild from four clips, seconds instead of a full extract
    wake_prefix_check.py --model M.onnx  # additionally: prefix must score below the threshold while
                                         # the positives score above it. This is the gate that says the
                                         # retrain did what it was for, so it runs on a sample.

`failure, not exit(0)`, for everything here: this file is the thing `fault_prefix.py` measures, and an
assertion that only prints has no teeth.
"""

from __future__ import annotations

import argparse
import pathlib
import shutil
import sys
import tempfile

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_dataset  # noqa: E402
import wake_train  # noqa: E402

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    if not condition:
        FAILURES.append(message)


def load(directory: pathlib.Path, side: str):
    x = np.load(directory / f"{side}.npy")
    clips = np.load(directory / f"{side}-clips.npy")
    import json
    names = json.loads((directory / f"{side}-names.json").read_text(encoding="utf-8"))
    return x, clips, names


def verify(directory: pathlib.Path) -> None:
    positive_x, positive_clips, positive_names = load(directory, "positive")
    prefix_x, prefix_clips, prefix_names = load(directory, "prefix")
    print(f"  positives: {positive_x.shape[0]} windows / {len(positive_names)} clips")
    print(f"  prefixes:  {prefix_x.shape[0]} windows / {len(prefix_names)} clips")

    check(positive_x.shape[1:] == prefix_x.shape[1:],
          f"window shape differs: positives {positive_x.shape[1:]} against prefixes "
          f"{prefix_x.shape[1:]}")

    # 1. In step.
    check(prefix_names == positive_names,
          f"clip names are not in step: {len(prefix_names)} prefix names against "
          f"{len(positive_names)} positive names")
    check(len(prefix_names) == len(positive_names), "clip counts differ")

    # 2. One per warm-up variant, and 3. every one of them strictly before the phrase's end.
    import collections
    expected = wake_dataset.WARM_VARIANTS * wake_dataset.PREFIX_WINDOWS_PER_VARIANT
    per_clip = collections.Counter(prefix_clips.tolist())
    wrong_count = {clip: n for clip, n in per_clip.items() if n != expected}
    check(not wrong_count,
          f"{len(wrong_count)} clip(s) do not have exactly {expected} prefix windows, e.g. "
          f"{sorted(wrong_count.items())[:4]}")
    check(sorted(per_clip) == list(range(len(positive_names))),
          f"prefix clip ids do not cover every positive clip: {len(per_clip)} of "
          f"{len(positive_names)}")

    positive_by_clip: dict[int, list[np.ndarray]] = collections.defaultdict(list)
    for window, clip in zip(positive_x, positive_clips.tolist()):
        positive_by_clip[clip].append(window)
    duplicates = 0
    for window, clip in zip(prefix_x, prefix_clips.tolist()):
        for good in positive_by_clip.get(int(clip), []):
            if window.shape == good.shape and np.array_equal(window, good):
                duplicates += 1
                break
    check(duplicates == 0,
          f"{duplicates} prefix window(s) are byte-identical to a positive window of the same clip. "
          f"That is the labelling the fix exists to avoid: the same audio is being called yes and no, "
          f"and the negative is weighted {wake_train.HARD_NEGATIVE_WEIGHT}x.")

    # 4. Mass.
    share = prefix_x.shape[0] / max(1, positive_x.shape[0])
    print(f"  prefix/positive window ratio: {share*100:.0f}%")
    check(0.05 <= share <= 0.60,
          f"prefix windows are {share*100:.0f}% of the positive count, outside the 5-60% band. The "
          f"band is not arbitrary: a set that has grown past it is the mass change that took the "
          f"false alarms from 0.0 to 34.8 per hour when it was tried on a phrase family.")


def verify_model(directory: pathlib.Path, model: pathlib.Path, limit: int) -> None:
    """Prefix windows must score below the threshold, positives above it."""
    import onnxruntime as ort

    positive_x, positive_clips, _ = load(directory, "positive")
    prefix_x, _, _ = load(directory, "prefix")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name

    def scores(x: np.ndarray) -> np.ndarray:
        sample = x[:limit] if limit else x
        return np.array([session.run(None, {name: w[None, :, :]})[0].ravel()[0] for w in sample],
                        dtype=np.float32)

    pos = scores(positive_x)
    pre = scores(prefix_x)
    print(f"  {model.name}: positives mean {pos.mean():.4f} (min {pos.min():.4f}) "
          f"over {len(pos)} windows")
    print(f"  {model.name}: prefixes  mean {pre.mean():.4f} (max {pre.max():.4f}) "
          f"over {len(pre)} windows")
    threshold = 0.95
    check(float(pre.max()) < threshold,
          f"a prefix window scores {pre.max():.4f}, at or above the {threshold} threshold. The model "
          f"still says yes to the phrase before it has finished, which is the defect this set exists "
          f"to remove.")
    check(float(pos.mean()) > threshold,
          f"the positives average {pos.mean():.4f}, below the {threshold} threshold. The boundary was "
          f"pushed past the phrase itself.")


def build_smoke(clips: int) -> pathlib.Path:
    """Run the real `extract` over a handful of real clips, into a temporary directory."""
    workspace = pathlib.Path(tempfile.mkdtemp(prefix="wake-prefix-check-"))
    source = sorted(wake_dataset.POSITIVE_DIR.glob("*.wav"))[:clips]
    if not source:
        raise SystemExit(f"no wav files under {wake_dataset.POSITIVE_DIR}")
    staged = workspace / "positives"
    staged.mkdir()
    for path in source:
        shutil.copyfile(path, staged / path.name)
    wake_dataset.FEATURE_DIR = workspace
    wake_dataset.extract(staged, workspace / "positive.npy", "positive",
                         pool_dir=wake_dataset.NEGATIVE_DIR)
    return workspace


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--smoke", action="store_true",
                        help="rebuild from a few clips instead of reading the real feature files")
    parser.add_argument("--clips", type=int, default=4, help="how many clips --smoke stages")
    parser.add_argument("--model", type=pathlib.Path, default=None,
                        help="also check this classifier's scores on a sample of both sets")
    parser.add_argument("--limit", type=int, default=400, help="windows per set for --model")
    parser.add_argument("--directory", type=pathlib.Path, default=None,
                        help="feature directory to read instead of the real one")
    args = parser.parse_args()

    if args.smoke:
        directory = build_smoke(args.clips)
        print(f"  smoke directory: {directory}")
    else:
        directory = args.directory or wake_train.FEATURE_DIR

    verify(directory)
    if args.model is not None:
        verify_model(directory, args.model, args.limit)

    if FAILURES:
        print()
        for message in FAILURES:
            print(f"  FAIL  {message}")
        print(f"  {len(FAILURES)} check(s) failed")
        return 1
    print("  all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
