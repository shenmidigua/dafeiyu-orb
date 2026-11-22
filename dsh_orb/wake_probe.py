"""Score real microphone audio with a keyword model, the way the orb's engine scores it.

Why this exists: every number the training chain reports comes from TTS clips. A model can score
0.999 on fourteen synthetic voices and still miss the one throat standing in front of the microphone,
and no amount of threshold tuning fixes that. This probe answers the only question that decides
whether to lower the threshold or to record more data.

The pipeline is the device's: 16 kHz mono float32, mel -> `embedding_model.onnx` -> 28-slot ring ->
classifier. `OrbFeatures(scale=1.0)` reproduces `wake.js` (`scale=1.0` is the device path; 32767 is
openWakeWord's Python path and is a different signal entirely).

Usage:
    python wake_probe.py --phrase xiaodi --record 12
    python wake_probe.py --phrase xiaodi --wav some.wav
"""

from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from wake_features import OrbFeatures, warmup_audio  # noqa: E402

FEATURE_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\features")
SAMPLE_RATE = 16_000


def capture(seconds: float, device: int | None) -> np.ndarray:
    """Record `seconds` of mono audio, resampled to 16 kHz."""
    import sounddevice as sd

    info = sd.query_devices(device=device, kind="input")
    native = int(info["default_samplerate"]) or SAMPLE_RATE
    frames = int(seconds * native)
    print(f"  recording {seconds:.1f}s from {info['name']} at {native} Hz ...", flush=True)
    audio = sd.rec(frames, samplerate=native, channels=1, dtype="float32", device=device)
    sd.wait()
    samples = np.asarray(audio, dtype=np.float32).reshape(-1)
    if native != SAMPLE_RATE:
        import librosa

        samples = librosa.resample(samples, orig_sr=native, target_sr=SAMPLE_RATE)
    return np.asarray(samples, dtype=np.float32)


def read_wav(path: pathlib.Path) -> np.ndarray:
    import librosa

    samples, rate = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return np.asarray(samples, dtype=np.float32)


def score(samples: np.ndarray, phrase: str, scale: float) -> tuple[np.ndarray, int]:
    import onnxruntime as ort

    model = FEATURE_DIR / f"{phrase}.onnx"
    if not model.exists():
        raise SystemExit(f"{model} missing")
    session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
    feed = session.get_inputs()[0].name

    extractor = OrbFeatures(ncpu=4, scale=scale)
    # The orb's ring is never empty when someone speaks; keep the probe's ring warm with real speech
    # so the windows it scores are the same shape the device sees.
    rng = np.random.default_rng(0)
    warm = warmup_audio(rng)
    windows = extractor.windows(samples, warmup=warm)
    if len(windows) == 0:
        return np.zeros(0), 0
    scores = np.array([float(session.run(None, {feed: window[None, :, :]})[0].ravel()[0])
                       for window in windows])
    return scores, len(windows)


def report(samples: np.ndarray, phrase: str, scale: float, threshold: float) -> None:
    peak = float(np.abs(samples).max()) if len(samples) else 0.0
    rms = float(np.sqrt(np.mean(samples ** 2))) if len(samples) else 0.0
    print(f"  audio: {len(samples) / SAMPLE_RATE:.1f}s  peak {peak:.3f}  rms {rms:.4f}")
    scores, count = score(samples, phrase, scale)
    if count == 0:
        print("  no windows: clip too short or silent")
        return
    step = 0.128
    at = int(np.argmax(scores))
    print(f"  windows {count}  max {scores.max():.3f} (at {at * step:.2f}s)  "
          f"mean {scores.mean():.3f}  above {threshold}: {int((scores > threshold).sum())}")
    line = "  "
    for index, value in enumerate(scores):
        line += f"{value:.2f} "
        if (index + 1) % 10 == 0:
            print(line)
            line = "  "
    if line.strip():
        print(line)
    print(f"  longest run above {threshold}: {longest_run(scores, threshold)} windows")


def longest_run(scores: np.ndarray, threshold: float) -> int:
    best = run = 0
    for value in scores:
        run = run + 1 if value > threshold else 0
        best = max(best, run)
    return best


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--phrase", default="xiaodi")
    parser.add_argument("--record", type=float, default=0.0, help="seconds to record from the microphone")
    parser.add_argument("--wav", type=pathlib.Path, default=None)
    parser.add_argument("--device", type=int, default=None)
    parser.add_argument("--scale", type=float, default=1.0, help="1.0 mirrors wake.js; 32767 mirrors openWakeWord Python")
    parser.add_argument("--threshold", type=float, default=0.55)
    parser.add_argument("--save", type=pathlib.Path, default=None, help="keep the recording as a wav")
    args = parser.parse_args()

    if args.wav is not None:
        samples = read_wav(args.wav)
    elif args.record > 0:
        samples = capture(args.record, args.device)
    else:
        raise SystemExit("pass --record <seconds> or --wav <file>")

    if args.save is not None:
        import soundfile

        args.save.parent.mkdir(parents=True, exist_ok=True)
        soundfile.write(str(args.save), samples, SAMPLE_RATE)
        print(f"  saved {args.save}")
    report(samples, args.phrase, args.scale, args.threshold)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
