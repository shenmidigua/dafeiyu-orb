"""Score the acceptance files offline, before anything is packaged or installed.

The four `wake-mic-*.wav` files are what `wake_accept.py` plays into a real orb. Packaging takes a
build, an install and four Electron launches, so a model that would fail is worth finding here first
- and the reading here is the same arithmetic the orb does, just without the browser.

Two things are deliberately mirrored from `wake.js` rather than done the convenient way:

* **The ring starts at zero and the file's own 6 s of talking fills it.** No warm-up is prepended;
  prepending one would be a kinder test than the orb it stands in for.
* **A window is skipped until every slot in it holds audio.** The orb instead pre-fills the ring with
  a quiet-room embedding at load (`silenceEmbedding`) and only falls back to the guard if that is not
  available, so its first scored windows are quiet-dominated rather than absent. Skipping is the
  cheaper equivalent: a quiet-dominated ring measures 0.0001 on this model where a zero-dominated one
  measures 0.86-0.98 on any audio at all, so the windows left out here are ones the orb would have
  scored as nothing. That peak is reported beside the real one so the difference stays visible.

A file is expected to fire iff its name says `doubled`. Nothing here reads the orb, so a PASS is not
the acceptance result - it is permission to spend the time getting one. `wake_accept.py` is the real
one; this exists so a model that would fail is found before a build rather than after.

Usage: wake_accept_offline.py [--threshold 0.95]
"""

from __future__ import annotations

import argparse
import math
import pathlib
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_features as wf  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

HERE = pathlib.Path(__file__).parent
MODEL = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")


def window_end_ms(index: int) -> float:
    """When window `index` (0-based) stops, in ms of stream time.

    The first embedding cannot exist until `MEL_WINDOW_FRAMES` mel frames have accumulated, and the
    buffer gains `MEL_FRAMES_PER_CALL` per frame while losing `MEL_STEP` per embedding, so window `i`
    is produced by frame `ceil((76 + 8i) / 5)` and covers audio up to `80 * frames` ms. The naive
    `(i + 1) * 128` understates the early ones by seconds.
    """
    frames = math.ceil((wf.MEL_WINDOW_FRAMES + wf.OrbFeatures.MEL_STEP * index)
                       / wf.OrbFeatures.MEL_FRAMES_PER_CALL)
    return frames * 80.0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threshold", type=float, default=0.95)
    args = parser.parse_args()

    files = sorted(HERE.glob("wake-mic-*.wav"))
    if not files:
        raise SystemExit("no wake-mic-*.wav; run make_wake_mic.py first")

    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)
    slots = wf.WINDOW_FRAMES

    print(f"  model     {MODEL.name}  ({slots} slots)")
    print(f"  threshold {args.threshold}")
    print()
    print(f"  {'file':24} {'expect':6} {'peak':>7} {'at':>7} {'over':>7}   "
          f"{'cold':>7}  verdict")
    print("  " + "-" * 76)

    bad = 0
    for path in files:
        samples = pcm16_from_wav(path)
        windows = extractor.windows(samples, None, require_clip_embeddings=0)
        if windows.shape[0] <= slots:
            print(f"  {path.name:24} {'-':6} {'-':>7} {'-':>7} {'-':>7}   {'-':>7}  too short")
            bad += 1
            continue
        scores = np.array([float(session.run(None, {feed: w[None, :, :]})[0].ravel()[0])
                           for w in windows])
        # Same guard as `runModels`: the first `slots - 1` windows are partly zeros.
        cold_peak = float(scores[:slots - 1].max())
        live = scores[slots - 1:]
        peak = float(live.max())
        index = int(live.argmax()) + slots - 1
        over = float((live >= args.threshold).mean()) * 100
        expect_fire = "doubled" in path.name
        fires = peak >= args.threshold
        verdict = "ok" if fires == expect_fire else "WOULD FAIL"
        bad += fires != expect_fire
        print(f"  {path.name:24} {'fire' if expect_fire else 'quiet':6} {peak:7.3f} "
              f"{window_end_ms(index) / 1000:6.2f}s {over:6.1f}%   {cold_peak:7.3f}  {verdict}")

    print()
    print("  `cold` is the peak over the windows `wake.js` refuses to score. 0.98 there on every file,")
    print("  whatever it says, is the artefact the guard exists to keep out of the decision.")
    print()
    if bad:
        print(f"  {bad} of {len(files)} file(s) would not behave as expected at {args.threshold}.")
        return 1
    print(f"  All {len(files)} files would behave as expected at {args.threshold}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
