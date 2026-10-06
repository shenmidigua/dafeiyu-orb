"""Where, relative to the end of the phrase, does the model actually cross the threshold?

The ring slides one slot (128 ms) at a time, so a window's right edge walks through the phrase and the
label flips from negative to positive at exactly one slot: the window that first reaches the phrase's
last frame is a positive, and the window one slot earlier holds a *prefix* of the phrase — the same
audio the user produces when they stop early, which is how 「大肥鱼大肥」 tripped the orb.

`wake_dataset.extract` used to label the positive side and drop the prefix side rather than labelling
it, which left the model told about the prefix only through separately synthesised truncation clips —
and those carry utterance-final prosody, so they are not the same object as the prefix of a real
recording of the full phrase. That gap is what this probe found: on the deployed model the score was
already at the threshold one slot before the phrase ended.

`extract` now labels the prefix band as negatives — `wake_dataset.PREFIX_SLOTS`, and the band it
labels is the same subtraction this file does below. So this probe has a second job, and it is the one
that decides whether the change worked:

  * the column to read is `share >= threshold` at offsets -1, -2 and -3;
  * the run that motivated the change read **72.5% / 33.3% / 10.0%**, against 97.5% at offset 0;
  * a boundary that has been learned reads low there and climbs sharply at 0.

The threshold is a parameter rather than a constant so that the same profile can be read at the
deployed 0.95 and at whatever a future rule clamps to.

Reported as a profile: mean and worst score at each offset in slots from the phrase's last frame, over
many clips and several warm-ups, so the answer is a shape rather than an anecdote.

Usage:  <pipeline python> wake_boundary_probe.py [--clips 60] [--warm 3] [--model PATH]
"""

from __future__ import annotations

import argparse
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_dataset import pool_slice, prepare_positive  # noqa: E402
from wake_features import WINDOW_FRAMES, OrbFeatures, pcm16_from_wav, warmup_audio  # noqa: E402
from wake_features import warmup_length  # noqa: E402

POSITIVES = pathlib.Path(r"C:\Users\digua\wakeword\data\positives")
FILLER = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clips", type=int, default=60)
    parser.add_argument("--warm", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.95)
    parser.add_argument("--model", type=pathlib.Path,
                        default=pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx"))
    args = parser.parse_args()

    files = sorted(POSITIVES.glob("*.wav"))
    if not files:
        raise SystemExit(f"no positive clips under {POSITIVES}")
    step = max(1, len(files) // args.clips)
    files = files[::step][:args.clips]

    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)
    pool = sorted(FILLER.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    rng = random.Random(0)

    # offset in slots from the phrase's last frame -> every score seen at that offset
    profile: dict[int, list[float]] = {}
    skipped = 0
    for path in files:
        samples = pcm16_from_wav(path)
        prepared = prepare_positive(samples)
        if prepared is None:
            skipped += 1
            continue
        clip, require = prepared
        if require > WINDOW_FRAMES:
            skipped += 1
            continue
        nprng = np.random.default_rng(len(clip))
        for _ in range(args.warm):
            speech = pool_slice(pool_audio, rng, warmup_length()) if pool_audio else None
            warm = warmup_audio(nprng, speech)
            # Asked twice on purpose. The windows `extract` keeps as positives are exactly the ones
            # that have reached the phrase's last frame, and every other window is a prefix — that is
            # the label rule, and the index where the kept set starts is where the label flips. Taking
            # it from the two calls rather than from the slot arithmetic keeps this probe honest about
            # a boundary it would otherwise have to re-derive and could quietly get wrong.
            every = extractor.windows(clip, warm, 0)
            kept = extractor.windows(clip, warm, require)
            if every.shape[0] == 0 or kept.shape[0] == 0:
                continue
            first = every.shape[0] - kept.shape[0]
            if first < 0:
                continue
            scores = [float(session.run(None, {feed: w[None, :, :]})[0].ravel()[0])
                      for w in every]
            for index, value in enumerate(scores):
                profile.setdefault(index - first, []).append(value)

    print(f"  model: {args.model}")
    print(f"  clips: {len(files) - skipped} scored, {args.warm} warm-up(s) each")
    print()
    print("    offset   windows   mean score   worst score   share >= threshold")
    print("    (slots from the phrase's last frame — negative is a prefix, 0 is the full phrase)")
    print()
    for offset in sorted(profile):
        if offset < -8 or offset > 6:
            continue
        values = profile[offset]
        hits = sum(1 for v in values if v >= args.threshold)
        marker = "  <-- the phrase ends here" if offset == 0 else ""
        print(f"      {offset:>+3}    {len(values):>7}      {np.mean(values):.4f}       "
              f"{max(values):.4f}      {hits / len(values):>6.1%}{marker}")
    print()
    before = [v for offset, values in profile.items() if offset < 0 for v in values]
    at = [v for offset, values in profile.items() if offset >= 0 for v in values]
    if before and at:
        print(f"  before the phrase ends: mean {np.mean(before):.4f}, "
              f"{sum(1 for v in before if v >= args.threshold) / len(before):.1%} of windows at or "
              f"above {args.threshold}")
        print(f"  from the phrase's end:  mean {np.mean(at):.4f}, "
              f"{sum(1 for v in at if v >= args.threshold) / len(at):.1%} at or above")
        print()
        print("  A model that fires only from the end has a boundary; one whose prefix windows score")
        print("  like the phrase does not, and the truncation it fires on is the positive set's own")
        print("  prefix rather than anything the negative list did or did not contain.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
