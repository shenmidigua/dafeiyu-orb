"""Cut the speech out of the capture and score it at several input gains.

The captured voice sits at rms ~0.02 where the training clips sit at rms ~0.08, so the same phrase
arrives about 6 dB quieter than the model has ever seen. This walks the gain to find out whether the
model simply wants louder input, which is a fix the engine can apply, or whether it does not recognise
the voice at any gain, which is a fix only more data can make.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np
import soundfile as sf

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from wake_features import OrbFeatures, warmup_audio  # noqa: E402

FEATURE_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\features")
RATE = 16_000


def main() -> int:
    source = pathlib.Path(sys.argv[1])
    start, end = float(sys.argv[2]), float(sys.argv[3])
    phrase = sys.argv[4] if len(sys.argv) > 4 else "xiaodi"

    audio, rate = sf.read(str(source), dtype="float32")
    clip = audio[int(start * rate):int(end * rate)]
    sf.write(str(pathlib.Path("_clip.wav")), clip, rate)
    print(f"clip {len(clip) / rate:.1f}s rms {float(np.sqrt(np.mean(clip ** 2))):.4f}")

    import onnxruntime as ort

    session = ort.InferenceSession(str(FEATURE_DIR / f"{phrase}.onnx"), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name
    rng = np.random.default_rng(0)
    warm = warmup_audio(rng)

    for gain in (1, 2, 4, 8, 16):
        extractor = OrbFeatures(ncpu=4, scale=1.0)
        windows = extractor.windows(np.asarray(clip * gain, dtype=np.float32), warmup=warm)
        if len(windows) == 0:
            print(f"  gain x{gain:<3} no windows")
            continue
        scores = np.array([float(session.run(None, {feed: w[None, :, :]})[0].ravel()[0]) for w in windows])
        print(f"  gain x{gain:<3} windows {len(scores):3d}  max {scores.max():.3f}  "
              f"mean {scores.mean():.3f}  >0.35: {int((scores > 0.35).sum())}")
        print("     " + " ".join(f"{value:.2f}" for value in scores))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
