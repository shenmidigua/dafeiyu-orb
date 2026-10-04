"""Are the false accepts caused by the words, or by the splice?

Held-out filler clips cross 0.75 at a rate of ~1.9%, yet every FILLER sentence scores below 0.26 on
its own. Something about the stored clips differs from the sentences in them: each is six sentences
concatenated and then cut into windows, so every window boundary is a hard discontinuity — two
unrelated waveforms meeting at full amplitude.

`pool_slice` already admits this in a comment ("Six sentences cut together with hard joins is not
what a quiet room sounds like"). This measures whether it is the problem, by changing the joins
while holding the words fixed:

  * `edge fade` — a 40 ms ramp at both ends of the clip. Same words, same join positions, but the
    discontinuity becomes a fade. If the score falls, the join was doing it.
  * `slowed` — every sample duplicated, so the words are at half speed and the same joins are twice
    as far apart. If the score falls, the model is reacting to joins arriving in quick succession.
  * `resampled` — a round trip through a band-limited resampler and back, no timing change at all.
    This is the control: it touches bandwidth and nothing else. If this drops the score too, the
    effect was never about splicing.

Usage:
    python wake_splice_probe.py [--threshold 0.75] [--limit 120]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

import numpy as np
from scipy.signal import resample_poly

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_dataset import pool_slice  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav, warmup_audio, warmup_length  # noqa: E402
from wake_noise_probe import ClipScorer  # noqa: E402

FEATURE_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\features")
DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
MODEL = FEATURE_DIR / "dafeiyu.onnx"
SILENCE = 0.003
HELD_OUT_FOLD = 4


def held_out_filler() -> list[pathlib.Path]:
    """The clips `wake_eval.py` calls held out, so the number here means the same thing it does there."""
    names = json.loads((FEATURE_DIR / "negative-names.json").read_text(encoding="utf-8"))
    folds = np.load(FEATURE_DIR / "folds-negative.npy")
    index = {name: position for position, name in enumerate(names)}
    out = []
    for path in sorted(DATA.glob("negatives/filler-*.wav")):
        position = index.get(path.name)
        if position is not None and folds[position] == HELD_OUT_FOLD:
            out.append(path)
    return out


def fade_edges(samples: np.ndarray, ms: float = 40.0) -> np.ndarray:
    """Ramp the clip in and out, so a window boundary crossing this point meets near-silence."""
    width = int(ms * 16)
    if len(samples) <= 2 * width:
        return samples
    ramp = np.linspace(0.0, 1.0, width, dtype=np.float32)
    out = samples.copy()
    out[:width] *= ramp
    out[-width:] *= ramp[::-1]
    return out


def slow_down(samples: np.ndarray) -> np.ndarray:
    """Half speed, by sample repetition rather than resampling: the words stay the same words."""
    return np.repeat(samples, 2).astype(np.float32)


def resample_round_trip(samples: np.ndarray) -> np.ndarray:
    """Band-limit and return to the original rate. No timing change, no join removed."""
    limited = resample_poly(samples, 3, 4)
    if len(limited) < len(samples):
        return samples
    return resample_poly(limited[:len(samples)], 4, 3)[:len(samples)].astype(np.float32)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--threshold", type=float, default=0.75)
    parser.add_argument("--limit", type=int, default=120)
    args = parser.parse_args()

    clips = held_out_filler()
    if not clips:
        print("no held-out filler found; run wake_dataset.py features first")
        return 1
    clips = clips[:args.limit]
    pool = [pcm16_from_wav(path) for path in clips]
    extractor = OrbFeatures(ncpu=4)
    scorer = ClipScorer(extractor, MODEL)

    print(f"model {MODEL}")
    print(f"{args.threshold:.2f} threshold, {len(clips)} held-out filler clips\n")
    print(f"{'variant':>16}  {'mean':>7}  {'p95':>7}  {'max':>7}  {'crossed':>8}")

    results: dict[str, dict[str, float]] = {}
    for label, transform in [("original", lambda a: a),
                             ("edge fade", fade_edges),
                             ("slowed 2x", slow_down),
                             ("resampled", resample_round_trip)]:
        rng = random.Random(7)
        nprng = np.random.default_rng(7)
        scores = []
        for path in clips:
            speech = transform(pcm16_from_wav(path).astype(np.float32))
            warm_speech = pool_slice(pool, rng, warmup_length())
            warm = warmup_audio(nprng, warm_speech) if warm_speech is not None \
                else (nprng.standard_normal(warmup_length()) * SILENCE).astype(np.float32)
            score = scorer.peak(speech, warm, 0)
            if not np.isnan(score):
                scores.append(score)
        values = np.array(scores)
        crossed = float((values >= args.threshold).mean())
        results[label] = {"mean": float(values.mean()), "p95": float(np.percentile(values, 95)),
                          "max": float(values.max()), "crossed": crossed, "n": values.size}
        print(f"{label:>16}  {values.mean():7.3f}  {np.percentile(values, 95):7.3f}  "
              f"{values.max():7.3f}  {crossed:8.1%}")

    out = MODEL.parent / "splice-probe.json"
    out.write_text(json.dumps({"threshold": args.threshold, "results": results},
                              indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())