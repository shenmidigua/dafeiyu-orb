"""Build the microphone file for one whole spoken turn: wake by voice, then say something.

`two_round_mic.wav` was cut for the single-word model - its wake words are lifted from the
`positives` directory, which now holds the doubled phrase, but the two clips it takes are the two
*oldest* files there and predate the change. On the doubled model it never wakes at all, which a
run reports as "the engine stayed listening" rather than as "the file is stale".

So the wake word is synthesised here rather than taken from the dataset: a clip from training is
one the model may have memorised, and this file exists to watch the page, not to grade the model.

Layout, and why each gap is the length it is:

    silence 7 s   > DICTATION_NO_SPEECH_MS (6000), so an unattended gap closes as "nothing heard"
    the phrase    synthesised, doubled
    silence 1.2 s the word's own tail must not be clipped by the sentence starting
    a sentence    something for the dictation to hear and auto-send
    silence 5 s   > silenceMs (3800), so the utterance actually closes instead of running on
    silence 15 s  so the loop does not immediately wake the ball again while the probe is watching

Usage: make_spoken_turn_mic.py [--voice zh-CN-XiaoxiaoNeural]
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
OUT = pathlib.Path(__file__).parent / "spoken_turn_mic.wav"

BEFORE_WORD_S = 7.0
AFTER_WORD_S = 1.2
AFTER_SENTENCE_S = 5.0
TAIL_S = 15.0

WAKE = "大肥鱼大肥鱼"
SENTENCE = "帮我看一下桌面上的这个文件"


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(RATE * seconds), dtype=np.float32)


def write(path: pathlib.Path, track: np.ndarray) -> None:
    """Normalise before writing: Chromium plays the file as-is, and a quiet file can sit under the
    VAD's threshold — a run that proves nothing while looking like a run that proved something."""
    peak = float(np.max(np.abs(track))) or 1.0
    pcm = np.clip(track / peak * 0.7, -1.0, 1.0)
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((pcm * 32767.0).astype("<i2").tobytes())
    print(f"  {path.name}: {len(track) / RATE:.1f} s, peak {peak:.3f} -> 0.7")


async def build(voice: str) -> int:
    link = await wake_tts.Connection.open()
    try:
        wake = await link.say(voice, WAKE)
        utterance = await link.say(voice, SENTENCE)
    finally:
        await link.close()
    print(f"  wake      {WAKE}  {len(wake) / RATE:.2f} s")
    print(f"  utterance {SENTENCE}  {len(utterance) / RATE:.2f} s")

    track = np.concatenate([
        silence(BEFORE_WORD_S),
        wake,
        silence(AFTER_WORD_S),
        utterance,
        silence(AFTER_SENTENCE_S),
        silence(TAIL_S),
    ])
    write(OUT, track)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voice", default=wake_tts.VOICES[0])
    args = parser.parse_args()
    print(f"  voice: {args.voice}")
    print()
    return asyncio.run(build(args.voice))


if __name__ == "__main__":
    raise SystemExit(main())
