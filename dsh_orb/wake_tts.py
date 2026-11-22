"""Synthesise wake-word training audio through the Edge read-aloud endpoint.

Why this exists rather than the official training notebook: openWakeWord ships a synthetic-sample
generator built on Piper, and openWakeWord's own documentation says it is English-only because every
TTS model it reaches for is trained on English. The notebook's other half — negative data, room
impulse responses, 2000 hours of precomputed English features — lives on HuggingFace, which this
machine cannot reach (TLS is reset mid-handshake).

Both halves are replaced here, and the replacement fits the deployment better than the original did.
The orb is spoken to in Chinese, in one room, by one person; negatives drawn from English YouTube
audio would have described somebody else's problem.

  * positives: the phrase itself, in every Chinese voice the endpoint offers, at several rates and
    pitches, plus carrier phrases so the model does not learn "the audio starts with 大肥鱼".
  * negatives: ordinary Chinese sentences (that is what surrounds the word in real use) and,
    crucially, the near-misses a Mandarin ear hears as 大肥鱼 — 大肥猪, 大飞鱼, 大白鱼, 打肥鱼 …

The endpoint only accepts three output formats and none of them is raw or 16 kHz — measured, not
assumed, by `wake_fmt_probe.py`. 24 kHz MP3 is taken and resampled here. The ratio is exactly 2:3,
so `resample_poly` is an exact rational resampler rather than an approximation, and decoding is
libsndfile's (1.2.2 reads MP3 natively), which is why no ffmpeg is needed on a machine that has none.

The handshake is not written here at all any more. It used to be *executed out of*
`D:\\tools\\edgetts\\edge_server.py` — that file used to carry the protocol constants (`WSS`, `TOKEN`,
`config_message`), and a second process could not import it because it opens its log at module scope.
That file was rewritten on 2026-11-16: the protocol moved into the `edge_tts` library it now vendors,
the constants this generator read stopped existing, and the read-aloud service speaks the same
protocol without exposing its pieces. So the generator calls `edge_tts` directly — the same library
the service runs — and the version token problem is the library's to keep current instead of ours.

`edge_tts` is found in the service's own vendor directory rather than installed for this interpreter,
for one reason: the voice ids, the prosody parameters and the returned MP3 are the service's contract,
and pinning the generator to the exact copy the service speaks through is what keeps the training
audio and the spoken replies the same kind of object.

Usage: wake_tts.py probe        # three voices, one phrase, report what came back
"""

from __future__ import annotations

import asyncio
import io
import pathlib
import sys
import time
import types
import uuid
import wave
from xml.sax.saxutils import escape

import numpy as np
import soundfile as sf
import websockets
from scipy.signal import resample_poly

# The read-aloud service the orb speaks through. Its constants go on the wire here too.
VENDOR = pathlib.Path(r"D:\tools\edgetts\vendor")
if str(VENDOR) not in sys.path:
    sys.path.insert(0, str(VENDOR))

import edge_tts  # noqa: E402  (path set up just above)

# Every turn dials its own session inside the library, so the connection is only a handle: this class
# exists because four other probes and the generator already call `open()`/`say()`/`close()` and
# there is no reason for them to learn a second vocabulary.


# The endpoint accepts exactly three formats and every 16 kHz, riff, raw and ogg variant it is asked
# for is refused with `Unsupported Edge output format` — see wake_fmt_probe.py. Of the three, this is
# the highest bitrate MP3; the WebM/Opus one is smaller but would need an Opus decoder, which
# libsndfile does not provide for that container.
AUDIO_FORMAT = "audio-24khz-96kbitrate-mono-mp3"

SOURCE_RATE = 24000
TARGET_RATE = 16000
UP, DOWN = TARGET_RATE // 8000, SOURCE_RATE // 8000        # 2:3, exact

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")

# Every Chinese voice the endpoint answers for. More voices is the single biggest lever on whether
# the model generalises to a speaker it has never heard — which, since the user is the only speaker
# who matters, really means "whether it still works on the day his voice is tired".
VOICES = [
    "zh-CN-XiaoxiaoNeural",
    "zh-CN-XiaoyiNeural",
    "zh-CN-YunjianNeural",
    "zh-CN-YunxiNeural",
    "zh-CN-YunxiaNeural",
    "zh-CN-YunyangNeural",
    "zh-CN-liaoning-XiaobeiNeural",
    "zh-CN-shaanxi-XiaoniNeural",
    "zh-HK-HiuGaaiNeural",
    "zh-HK-HiuMaanNeural",
    "zh-HK-WanLungNeural",
    "zh-TW-HsiaoChenNeural",
    "zh-TW-HsiaoYuNeural",
    "zh-TW-YunJheNeural",
]

# Spoken rate and pitch. The endpoint takes these as SSML prosody, which is a free way to buy speaker
# variation: the same voice at -25% rate and +20 Hz pitch is a different acoustic object, and a wake
# word has to survive exactly that kind of drift.
RATES = ["-25%", "-15%", "-8%", "+0%", "+8%", "+15%", "+25%"]
PITCHES = ["-20Hz", "-10Hz", "+0Hz", "+10Hz", "+20Hz", "+30Hz"]


def ssml(voice: str, text: str, rate: str = "+0%", pitch: str = "+0Hz") -> str:
    """Wrap `text` for synthesis, with the prosody under our control.

    The service's own `ssml()` fixes prosody at neutral, which is right for reading a reply aloud and
    useless for building a training set.
    """
    return ("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
            f"<voice name='{voice}'><prosody pitch='{pitch}' rate='{rate}' volume='+0%'>"
            f"{escape(text)}</prosody></voice></speak>")


def to_pcm16(audio: bytes) -> np.ndarray:
    """Decode 24 kHz MP3 and resample to 16 kHz mono float32.

    Passing the container in memory rather than through a temporary file keeps a generator that
    makes tens of thousands of clips from touching the disk twice per clip.

    `format="MP3"` is deliberately *not* passed, which reads backwards but is what works: soundfile
    raises `TypeError: Not allowed for existing files` for a file-like object that is given a format,
    and libsndfile sniffs the container from its first bytes anyway. Measured in `wake_mp3_probe.py`.
    """
    samples, rate = sf.read(io.BytesIO(audio), dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if rate != SOURCE_RATE:
        # Should not happen, but a silent rate mismatch would poison every feature downstream.
        raise RuntimeError(f"expected {SOURCE_RATE} Hz from the endpoint, got {rate} Hz")
    return resample_poly(samples, UP, DOWN).astype(np.float32)


def write_wav(path: pathlib.Path, samples: np.ndarray) -> None:
    """16 kHz mono PCM16. Stated rather than inferred — the feature models assume it, silently."""
    clipped = np.clip(samples, -1.0, 1.0)
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(2)
        handle.setframerate(TARGET_RATE)
        handle.writeframes((clipped * 32767.0).astype("<i2").tobytes())


class Connection:
    """One handle for many turns.

    It used to hold a websocket open across turns, because dialling cost over a second while a turn
    cost a fraction of one. That is no longer how audio arrives: `edge_tts` opens a session per
    utterance, and pretending otherwise would mean reimplementing it. Eight workers still run at
    once — that concurrency, not the socket reuse, is what keeps a five-thousand-clip stage inside
    half an hour.
    """

    def __init__(self) -> None:
        self.turns = 0

    @classmethod
    async def open(cls) -> "Connection":
        """Kept as the one way to start: every caller already spells the stage this way."""
        return cls()

    async def say(self, voice: str, text: str, rate: str = "+0%", pitch: str = "+0Hz",
                  timeout: float = 30.0) -> np.ndarray:
        """One request, returning 16 kHz mono float32."""
        communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        pieces: list[bytes] = []

        async def collect() -> None:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    pieces.append(chunk["data"])

        await asyncio.wait_for(collect(), timeout)
        if not pieces:
            # A voice id that the endpoint has retired comes back as a successful stream with no
            # audio in it, so an empty answer has to be a failure here or the clip stage writes a
            # zero-length wav and calls it a clip.
            raise RuntimeError(f"no audio from {voice} for {text[:12]!r}")
        self.turns += 1
        return to_pcm16(b"".join(pieces))

    async def close(self) -> None:
        """Nothing to hang up: the library closed the session at the end of the turn."""
async def probe() -> int:
    """Confirm the decode-and-resample chain, and report what it produced.

    Peak amplitude is printed because the failure this guards against is silent: a resampler applied
    twice, or a float/int16 unit mistake, yields audio of the right length and the wrong scale, which
    would train a model on nonsense without anything looking broken.
    """
    DATA.mkdir(parents=True, exist_ok=True)
    link = await Connection.open()
    try:
        for voice in VOICES[:3]:
            samples = await link.say(voice, "大肥鱼")
            path = DATA / f"probe-{voice}.wav"
            write_wav(path, samples)
            print(f"  {voice:34} {samples.shape[0]:>6} samples  {samples.shape[0]/TARGET_RATE:5.2f}s"
                  f"  peak {np.abs(samples).max():.3f}  {path.name}")
        print(f"  turns on one connection: {link.turns}")
    finally:
        await link.close()
    return 0


def main() -> int:
    command = sys.argv[1] if len(sys.argv) > 1 else "probe"
    if command == "probe":
        return asyncio.run(probe())
    print(f"unknown command {command!r}; expected probe")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
