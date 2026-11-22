"""Collect real-voice clips without asking the user to stand by.

Timing a recording against a chat message never works: the reply arrives seconds later and the useful
audio has already gone by. This listens instead, and cuts a clip whenever the room gets loud enough to
be speech, so the user can just talk.

Usage:
    python wake_capture.py --seconds 150 --out C:\\Users\\digua\\Desktop\\dsh-orb-cordis\\dsh_orb\\real
"""

from __future__ import annotations

import argparse
import pathlib
import time

import numpy as np
import soundfile as sf

SAMPLE_RATE = 16_000
FRAME = 160  # 10 ms
TRIGGER_RMS = 0.01   # well above this room's noise floor (~0.004), far below a voice
TRIGGER_FRAMES = 15  # 150 ms of loud frames before a clip starts
LEAD_FRAMES = 25     # keep 250 ms before the trigger, so the phrase is not clipped
TAIL_SECONDS = 1.2   # after the loud part ends
MIN_GAP_SECONDS = 0.8


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=150.0)
    parser.add_argument("--out", type=pathlib.Path, default=pathlib.Path("real"))
    parser.add_argument("--trigger", type=float, default=TRIGGER_RMS)
    parser.add_argument("--device", type=int, default=None)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    import sounddevice as sd

    info = sd.query_devices(device=args.device, kind="input")
    native = int(info["default_samplerate"]) or SAMPLE_RATE
    block = int(round(native * FRAME / SAMPLE_RATE))
    print(f"device {info['name']} @ {native} Hz, listening {args.seconds:.0f}s, trigger rms {args.trigger}",
          flush=True)

    clips: list[np.ndarray] = []
    recent: list[np.ndarray] = []   # rolling lead-in buffer
    pending: list[np.ndarray] = []
    loud = quiet = 0
    recording = False
    started = time.time()

    def flush() -> None:
        nonlocal pending, recording, loud, quiet
        if pending:
            audio = np.concatenate(pending)
            if native != SAMPLE_RATE:
                import librosa

                audio = librosa.resample(audio, orig_sr=native, target_sr=SAMPLE_RATE)
            clips.append(np.asarray(audio, dtype=np.float32))
            path = args.out / f"clip{len(clips):02d}.wav"
            sf.write(str(path), audio, SAMPLE_RATE, subtype="PCM_16")
            print(f"  clip {len(clips):02d}: {len(audio) / SAMPLE_RATE:.2f}s -> {path.name}", flush=True)
        pending = []
        recording = False
        loud = quiet = 0

    with sd.InputStream(samplerate=native, channels=1, dtype="float32", blocksize=block,
                        device=args.device) as stream:
        while time.time() - started < args.seconds:
            block_audio, _ = stream.read(block)
            mono = np.asarray(block_audio, dtype=np.float32).reshape(-1)
            rms = float(np.sqrt(np.mean(mono ** 2)))
            if not recording:
                recent.append(mono)
                recent = recent[-LEAD_FRAMES:]
                loud = loud + 1 if rms > args.trigger else 0
                if loud >= TRIGGER_FRAMES:
                    recording = True
                    pending = list(recent)
                    loud = 0
                    quiet = 0
            else:
                pending.append(mono)
                if rms > args.trigger:
                    quiet = 0
                else:
                    quiet += 1
                    if quiet >= int(TAIL_SECONDS * SAMPLE_RATE / FRAME):
                        flush()
                if len(pending) * FRAME > 6 * SAMPLE_RATE:
                    flush()
    if recording:
        flush()
    print(f"done: {len(clips)} clips in {time.time() - started:.0f}s", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
