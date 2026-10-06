"""
Build the microphone file Chromium's fake capture device will loop over.

`--use-file-for-fake-audio-capture` wants one WAV, played from the start and looped forever. Two
wake words are packed into it with the silences the real thing has between them, so the page sees
exactly the sequence a person produces: wake, pause, sentence, long pause, wake again.

The silences are not cosmetic. `silenceMs` is 3800, so an utterance only closes after 47.5 frames
of quiet — a gap shorter than that is heard as part of the sentence, and the recorder keeps going
into the next wake word. The trailing silence therefore has to exceed `silenceMs`, and the leading
one has to exceed the 6 s the recorder waits before declaring an empty room.
"""

from __future__ import annotations

import pathlib
import sys
import wave

import numpy as np

RATE = 16000
DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
OUT = pathlib.Path(__file__).parent / "two_round_mic.wav"

# `silenceMs` in the profile is 3800 ms; give the close more than that so the recorder stops.
AFTER_SENTENCE_S = 5.0
# Longer than DICTATION_NO_SPEECH_MS (6000), so an unattended gap ends as "nothing heard"
# instead of recording the room.
BEFORE_WORD_S = 7.0
# The chime is a WebAudio tone on the speakers, not in this file; a short gap after the word keeps
# the word's own tail from being clipped by the leading silence of the next take.
AFTER_WORD_S = 1.2


def read(path: pathlib.Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        assert handle.getframerate() == RATE, f"{path} is not {RATE} Hz"
        assert handle.getsampwidth() == 2, f"{path} is not PCM16"
        assert handle.getnchannels() == 1, f"{path} is not mono"
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0


def silence(seconds: float) -> np.ndarray:
    return np.zeros(int(RATE * seconds), dtype=np.float32)


def build() -> pathlib.Path:
    # Two different positives, so the second round cannot pass because the model memorised one clip.
    words = sorted((DATA / "positives").glob("*.wav"))
    if len(words) < 2:
        raise SystemExit("need at least two positive clips")
    word_a, word_b = read(words[0]), read(words[1])

    # An ordinary sentence as the utterance. Its exact words do not matter here: the fake host
    # answers the transcript, not the recogniser, so this only has to be speech-shaped audio the
    # VAD will hear.
    fillers = sorted((DATA / "negatives").glob("filler-*.wav"))
    if not fillers:
        raise SystemExit("no filler clips to use as an utterance")
    sentence = read(fillers[0])

    track = np.concatenate([
        word_a, silence(AFTER_WORD_S),
        sentence, silence(AFTER_SENTENCE_S),
        silence(BEFORE_WORD_S),
        word_b, silence(AFTER_WORD_S),
        sentence, silence(AFTER_SENTENCE_S),
    ])

    peak = float(np.max(np.abs(track))) or 1.0
    # Chromium's fake capture plays the file as-is; a quiet file can leave the VAD below threshold
    # and the run then proves nothing. Normalise to a healthy level without clipping.
    pcm = np.clip(track / peak * 0.7, -1.0, 1.0)
    data = (pcm * 32767.0).astype("<i2")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(OUT), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes(data.tobytes())

    print(f"{OUT}")
    print(f"  {len(data) / RATE:.1f} s, {RATE} Hz mono PCM16, peak {peak:.3f} -> 0.7")
    print(f"  word A {words[0].name}, word B {words[1].name}, sentence {fillers[0].name}")
    return OUT


if __name__ == "__main__":
    try:
        build()
    except SystemExit as error:
        print(error, file=sys.stderr)
        raise
