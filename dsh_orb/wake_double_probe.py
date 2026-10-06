"""Does saying 大肥鱼 twice produce two detections, and how far apart?

The classifier's input is a fixed `[1,16,96]` window — 16 embedding frames at 80 ms each, so its
receptive field is 1.28 s. A doubled phrase runs about 2 s, which is *longer than the window*, and
that decides the whole design:

  * If the model emits two separated peaks on a doubled clip, the fix can live in the engine — arm on
    the first detection, wake on the second — and no retraining is needed.
  * If it emits one smeared peak, the engine has nothing to count, and the phrase has to be made
    shorter (or the model's window widened) before a repeat can mean anything.

`wake_probe_phrases.py` only reports the per-clip maximum, which cannot tell those apart. This prints
the window-by-window score curve instead, plus rising edges, so the shape is visible rather than
assumed.

Usage: wake_double_probe.py [--voices 3] [--threshold 0.95]
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_tts  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

MODEL = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")

# 80 ms per embedding frame, which is the hop between neighbouring windows.
FRAME_MS = 80
# Two peaks closer than this are the same detection ringing, not a second utterance.
MERGE_MS = 320

PHRASES = [
    ("大肥鱼", "the single word, as trained"),
    ("大肥鱼大肥鱼", "doubled, no pause"),
    ("大肥鱼，大肥鱼", "doubled, comma pause"),
    ("大肥鱼。大肥鱼", "doubled, sentence break"),
]


async def record(voices: list[str]):
    link = await wake_tts.Connection.open()
    clips = []
    try:
        for voice in voices:
            for text, _ in PHRASES:
                # Rate is pinned: the point is the shape of the curve, not speaker spread, and
                # +25% is the rate the earlier evaluation flagged as the recall weak spot.
                for rate in ("+0%", "+25%"):
                    clips.append((voice, rate, text, await link.say(voice, text, rate=rate)))
    finally:
        await link.close()
    return clips


def curve(session, feed, extractor, samples, pool_audio, warm_rng) -> np.ndarray:
    windows = warm_windows(extractor, samples, pool_audio, warm_rng,
                           np.random.default_rng(len(samples)))
    if windows.shape[0] == 0:
        return np.zeros(0, dtype=np.float32)
    return np.array([float(session.run(None, {feed: window[None, :, :]})[0].ravel()[0])
                     for window in windows], dtype=np.float32)


def detections(scores: np.ndarray, threshold: float) -> list[int]:
    """Rising edges above the threshold: window indices where the score crosses up.

    A single utterance rings the classifier for several consecutive windows, so crossing up once per
    utterance is the count a repeat-gate would actually see. Peaks merged by `MERGE_MS` collapse into
    the earliest window of the group.
    """
    edges = []
    for index in range(len(scores)):
        if scores[index] < threshold:
            continue
        if index and scores[index - 1] >= threshold:
            continue
        if edges and (index - edges[-1]) * FRAME_MS < MERGE_MS:
            continue
        edges.append(index)
    return edges


def sparkline(scores: np.ndarray) -> str:
    blocks = "▁▂▃▄▅▆▇█"
    return "".join(blocks[min(7, int(max(0.0, value) * 8))] for value in scores)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices", type=int, default=3)
    parser.add_argument("--threshold", type=float, default=0.95)
    args = parser.parse_args()

    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; run wake_train.py first")

    voices = wake_tts.VOICES[:args.voices]
    print(f"  model     {MODEL.name}")
    print(f"  voices    {', '.join(voices)}")
    print(f"  threshold {args.threshold}")
    print()

    clips = asyncio.run(record(voices))
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)

    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    warm_rng = random.Random(0)

    # group -> list of (seconds, curve, detections)
    results: dict[str, list] = {}
    for voice, rate, text, samples in clips:
        scores = curve(session, feed, extractor, samples, pool_audio, warm_rng)
        seconds = len(samples) / 16000
        results.setdefault(text, []).append((voice, rate, seconds, scores,
                                             detections(scores, args.threshold)))

    print("  ---- the score curve, one line per clip ----")
    print("       `|` marks the end of the clip's speech; `^` marks a rising edge over threshold")
    print()
    for text, note in PHRASES:
        print(f"  == {text}  ({note}) ==")
        for voice, rate, seconds, scores, edges in results.get(text, []):
            marks = [" "] * len(scores)
            for index in edges:
                marks[index] = "^"
            print(f"    {voice[6:]:10} {rate:5} {seconds:4.2f}s  {sparkline(scores)}")
            print(f"    {'':10} {'':5} {'':5}  {''.join(marks)}")
            peak = float(scores.max()) if len(scores) else 0.0
            gaps = [f"{(edges[i + 1] - edges[i]) * FRAME_MS} ms" for i in range(len(edges) - 1)]
            print(f"    {'':10} {'':5} peak {peak:.3f}  detections {len(edges)}"
                  + (f"  gaps {' , '.join(gaps)}" if gaps else ""))
            print()
        print()

    print("  ---- summary ----")
    for text, note in PHRASES:
        rows = results.get(text, [])
        counts = [len(edges) for _, _, _, _, edges in rows]
        peaks = [float(scores.max()) if len(scores) else 0.0 for _, _, _, scores, _ in rows]
        durations = [seconds for _, _, seconds, _, _ in rows]
        two = sum(1 for count in counts if count >= 2)
        print(f"    {text:8} clips {len(rows)}  2+ detections {two}/{len(rows)}"
              f"  detections {counts}  peak min {min(peaks):.3f}"
              f"  duration {min(durations):.2f}-{max(durations):.2f}s")
    print()

    doubled = results.get("大肥鱼大肥鱼", [])
    single = results.get("大肥鱼", [])
    if doubled and all(len(edges) < 2 for *_, edges in doubled):
        print("  The doubled phrase does NOT separate into two detections — its peaks merge. A")
        print("  repeat-gate in the engine therefore has nothing to count, and 大肥鱼×2 as a single")
        print("  trained positive is fighting a window shorter than the phrase.")
    elif doubled and single:
        print("  The doubled phrase separates into two detections on the no-pause reading, so a")
        print("  repeat-gate is measurable — check the gaps above against how fast a person repeats.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
