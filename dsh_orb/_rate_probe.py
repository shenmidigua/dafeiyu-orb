"""Does the model fire on 喂，大肥鱼 only at normal speed?

The diagnostic claim behind the retrain is specific and cheap to falsify: the near-miss negatives
were synthesised at -15% and +15% only, never at +0%, so a phrase the model is supposed to reject
should score high at normal speed and low at the speeds it was actually trained on. If that pattern
does not appear, the coverage gap is not the explanation and retraining would be wasted work.

Usage: _rate_probe.py
"""

from __future__ import annotations

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

# The phrases the shipped model fires on, plus the bare word as a control: if the bare word is quiet
# at every speed while the prefixed one is loud only at +0%, the gap is about coverage and not about
# "大肥鱼 is simply too close to 大肥鱼大肥鱼".
PHRASES = ["喂，大肥鱼", "大肥鱼在吗", "大肥鱼"]
RATES = ["+0%", "-15%", "+15%"]
VOICES = wake_tts.VOICES[:3]


async def record() -> list[tuple[str, str, str, np.ndarray]]:
    link = await wake_tts.Connection.open()
    clips: list[tuple[str, str, str, np.ndarray]] = []
    try:
        for voice in VOICES:
            for text in PHRASES:
                for rate in RATES:
                    clips.append((voice, text, rate, await link.say(voice, text, rate)))
    finally:
        await link.close()
    return clips


def main() -> int:
    clips = asyncio.run(record())
    session = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    extractor = OrbFeatures(ncpu=4)

    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]

    print(f"  {'voice':16} {'phrase':10} {'rate':6} {'peak':>7}  verdict")
    print("  " + "-" * 54)
    # One generator for the whole run, exactly as `wake_probe_phrases.py` does it, so a peak here can
    # be compared with a peak there. The warm-up differs per clip either way; what matters is that it
    # differs the same way in both probes.
    warm_rng = random.Random(0)
    for voice, text, rate, samples in clips:
        windows = warm_windows(extractor, samples, pool_audio, warm_rng,
                               np.random.default_rng(len(samples)))
        best = max((float(session.run(None, {feed: w[None, :, :]})[0].ravel()[0])
                    for w in windows), default=0.0)
        mark = "FIRES" if best >= 0.95 else "quiet"
        print(f"  {voice:16} {text:10} {rate:6} {best:7.3f}  {mark}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
