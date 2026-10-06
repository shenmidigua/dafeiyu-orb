"""Build the two microphone files that decide whether the new wake word works.

Chromium's `--use-file-for-fake-audio-capture` loops one WAV forever, so each file is the whole
experiment: a stretch of unrelated talking (the ring is never empty in real use), a short gap, then
the phrase. Exactly one thing differs between the pair — the phrase itself — so a difference in what
the orb does is a difference about the phrase and nothing else.

  * `wake-mic-doubled.wav` — 大肥鱼大肥鱼, the trained wake word. The orb must wake.
  * `wake-mic-single.wav`  — 大肥鱼, the phrase said once. The orb must **not** wake: that is the
    false trigger this whole change exists to remove, and it is the reading that must be measured and
    not assumed.
  * `wake-mic-truncated-*.wav` — the doubled phrase with a syllable missing, one file per way it can
    go missing. Also must **not** wake, and these are the two the user actually hit: the phrase said
    twice was already covered, and a truncation is still said twice, so the single-word pair above
    could never have caught it.

Both are synthesised fresh rather than lifted from the training set, because a clip from training is
one the model may have memorised — and because the two have to come from the same voice and rate to
be comparable at all.

Usage: make_wake_mic.py [--voice zh-CN-XiaoxiaoNeural] [--suffix ""]
"""

from __future__ import annotations

import argparse
import asyncio
import pathlib
import sys
import wave

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_tts  # noqa: E402

RATE = 16000
DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
OUT_DIR = pathlib.Path(__file__).parent

# Talking before the phrase, so the embedding ring is warm with speech rather than with silence: the
# easier of the two conditions the dataset trains for, and the one that hides nothing.
WARMUP_S = 6.0
# A beat between the talking and the phrase, as a person leaves before saying a wake word.
GAP_S = 0.5
# After the phrase, long enough that a detection is unambiguous and the loop cannot splice the tail of
# one repetition onto the head of the next.
TAIL_S = 1.6

PHRASES = [
    ("doubled", "大肥鱼大肥鱼"),
    ("single", "大肥鱼"),
    # The doubled phrase with a syllable missing. Both are still said twice, which is what separates
    # them from `single` above and what the adversarial list was missing until the user reported them.
    ("truncated-both", "大肥大肥"),    # 鱼 dropped from both halves
    ("truncated-tail", "大肥鱼大肥"),  # the final 鱼 dropped
    # The doubled phrase with material between the halves — the third family the user reported. Both
    # halves are complete and in order, they just do not touch, so the single-word and truncation
    # files above cannot see it. Also said twice, and also must not wake.
    ("interrupted", "大肥鱼嗯大肥鱼"),        # a hesitation — the worst measured of the family
    ("interrupted-count", "大肥鱼一二三大肥鱼"),  # a count — the exact phrase the user reported
]


def read(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != RATE or handle.getsampwidth() != 2 or handle.getnchannels() != 1:
            raise SystemExit(f"{path} is not 16 kHz mono PCM16")
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(RATE * seconds), dtype=np.float32)


def write(path: pathlib.Path, track: np.ndarray) -> None:
    """Normalise, then write. Chromium plays the file as-is, and a quiet file can sit below the VAD's
    threshold — a run that proves nothing while looking like a run that proved something."""
    peak = float(np.max(np.abs(track))) or 1.0
    pcm = np.clip(track / peak * 0.7, -1.0, 1.0)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((pcm * 32767.0).astype("<i2").tobytes())
    print(f"  {path.name}: {len(track) / RATE:.1f} s, peak {peak:.3f} -> 0.7")


async def build(voice: str, suffix: str) -> int:
    # Warm-up material: ordinary sentences, spliced to length. Drawn from the filler clips rather
    # than a fresh synthesis so nothing here depends on the endpoint at test time.
    fillers = sorted((DATA / "negatives").glob("filler-*.wav"))
    if not fillers:
        raise SystemExit(f"no filler clips under {DATA / 'negatives'}; run the dataset first")
    pieces: list[np.ndarray] = []
    total = 0
    for path in fillers:
        piece = read(path)
        pieces.append(piece)
        total += len(piece)
        if total >= int(WARMUP_S * RATE):
            break
    warmup = np.concatenate(pieces)[:int(WARMUP_S * RATE)]

    link = await wake_tts.Connection.open()
    try:
        for label, text in PHRASES:
            phrase = await link.say(voice, text)
            print(f"  {label:8} {text:8} speech {len(phrase) / RATE:.2f} s")
            write(OUT_DIR / f"wake-mic-{label}{suffix}.wav",
                  np.concatenate([warmup, silence(GAP_S), phrase, silence(TAIL_S)]))
    finally:
        await link.close()

    print()
    print("  Both files carry the same 6 s of talking and the same gap. Only the phrase differs, so a")
    print("  difference in the orb's behaviour is about the phrase.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", default=wake_tts.VOICES[0])
    parser.add_argument("--suffix", default="",
                        help="appended to the file names, so several voices can coexist on disk")
    args = parser.parse_args()
    print(f"  voice: {args.voice}")
    print()
    return asyncio.run(build(args.voice, args.suffix))


if __name__ == "__main__":
    raise SystemExit(main())
