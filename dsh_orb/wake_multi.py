"""Record the same seconds from several input devices at once.

The earlier single-device capture came back at peak 0.065, which is a room, not a voice. Rather than
ask which microphone the user means, take all the plausible ones at the same time - the ball wakes
fine on one of them, so one of these files will contain the phrase.

Usage:
    python wake_multi.py --seconds 40 --out C:\\Users\\digua\\Desktop\\dsh-orb-cordis\\dsh_orb\\real
"""

from __future__ import annotations

import argparse
import pathlib
import threading

import numpy as np
import soundfile as sf

SAMPLE_RATE = 16_000
WANTED = ("麦克风 (Realtek(R) Audio)", "外部麦克风 (Realtek(R) Audio)", "VoiceMeeter")


def pick_devices(limit: int = 4) -> list[int]:
    import sounddevice as sd

    seen: set[str] = set()
    chosen: list[int] = []
    default = None
    try:
        default = sd.query_devices(kind="input")["name"]
    except Exception:
        default = None
    for index, device in enumerate(sd.query_devices()):
        if device["max_input_channels"] < 1:
            continue
        name = device["name"]
        if not any(key in name for key in WANTED):
            continue
        # WASAPI first: MME copies of the same physical mic are quieter and resampled twice.
        host = sd.query_hostapis(device["hostapi"])["name"]
        key = f"{name}|{host}"
        if key in seen:
            continue
        seen.add(key)
        if host.upper().startswith("WASAPI"):
            chosen.insert(0, index)
        else:
            chosen.append(index)
        if len(chosen) >= limit:
            break
    print(f"default input: {default}", flush=True)
    for index in chosen:
        device = sd.query_devices(index)
        host = sd.query_hostapis(device["hostapi"])["name"]
        print(f"  [{index}] {device['name']} ({host})", flush=True)
    return chosen


def record(index: int, seconds: float, out: pathlib.Path, results: dict[int, str]) -> None:
    import sounddevice as sd

    try:
        device = sd.query_devices(index)
        native = int(device["default_samplerate"]) or SAMPLE_RATE
        audio = sd.rec(int(seconds * native), samplerate=native, channels=1, dtype="float32",
                       device=index)
        sd.wait()
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        if native != SAMPLE_RATE:
            import librosa

            samples = librosa.resample(samples, orig_sr=native, target_sr=SAMPLE_RATE)
        path = out / f"mic{index}.wav"
        sf.write(str(path), samples, SAMPLE_RATE, subtype="PCM_16")
        peak = float(np.abs(samples).max())
        results[index] = f"{path.name} peak {peak:.3f} rms {float(np.sqrt((samples ** 2).mean())):.4f}"
    except Exception as error:  # one dead device must not take the others down
        results[index] = f"failed: {error}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=40.0)
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("real"))
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    results: dict[int, str] = {}
    threads = [threading.Thread(target=record, args=(index, args.seconds, args.out, results))
               for index in pick_devices()]
    print(f"recording {args.seconds:.0f}s on {len(threads)} devices, speak now", flush=True)
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    for index in sorted(results):
        print(f"  [{index}] {results[index]}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
