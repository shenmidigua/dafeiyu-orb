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

The handshake is not duplicated here. `D:\\tools\\edgetts\\edge_server.py` is the read-aloud service
the orb actually uses, and its constants are the ones that go out on the wire; the version string in
particular is load-bearing and must not drift, so it is read from that file rather than retyped.

Read, but not `import`ed — and that distinction cost an afternoon. The service opens its log file at
module scope and holds the handle for its whole life. That is correct for the service; for a second
process importing it, it is fatal, because the running service owns the file:

    PermissionError: [Errno 13] Permission denied: 'D:\\tools\\edgetts\\logs\\edge-server.log'

The service is running whenever the orb can speak, which is exactly when this generator wants to
produce training audio. So `_load_service()` executes the source with that one line neutered and
nothing else changed: same constants, same `sec_ms_gec`, same `config_message`, one owner of the log.

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
EDGE_SERVER = pathlib.Path(r"D:\tools\edgetts\edge_server.py")


def _load_service() -> types.ModuleType:
    """Load the read-aloud service's protocol half without touching its log file.

    Executed rather than imported so one line can be substituted: the service does
    `_LOG_HANDLE = LOG_PATH.open("a", ...)` at module scope and keeps it, so a second process can
    never import it while the service is up. Everything else — TOKEN, WSS, HEADERS, sec_ms_gec,
    config_message, and above all CHROMIUM, whose value the endpoint validates — comes through
    verbatim. Retyping those would let the client version quietly stop matching what Microsoft
    expects, and the failure mode of that is a 403 with no hint in it.
    """
    source = EDGE_SERVER.read_text(encoding="utf-8")
    original = '_LOG_HANDLE = LOG_PATH.open("a", encoding="utf-8")'
    if original not in source:
        raise RuntimeError(f"{EDGE_SERVER} no longer opens its log the way this expects; "
                           "check whether the handle is still created at module scope")
    source = source.replace(
        original, '_LOG_HANDLE = open(__import__("os").devnull, "w", encoding="utf-8")')
    # A native-fault dump is only meaningful in the process that owns the service.
    source = source.replace("faulthandler.enable(file=_LOG_HANDLE)",
                            "pass  # faulthandler deliberately not enabled for this loader")
    module = types.ModuleType("edge_protocol")
    module.__file__ = str(EDGE_SERVER)          # LOG_PATH is derived from it
    exec(compile(source, str(EDGE_SERVER), "exec"), module.__dict__)
    return module


es = _load_service()

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
    """One websocket, reused for many turns.

    Reusing matters here for the same reason it mattered at playback: the handshake costs over a
    second while a turn costs a fraction of one, so dialling per clip would make this generator an
    order of magnitude slower than it needs to be.
    """

    def __init__(self, ws) -> None:
        self.ws = ws
        self.turns = 0

    @classmethod
    async def open(cls) -> "Connection":
        url = (f"{es.WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={es.sec_ms_gec()}"
               f"&Sec-MS-GEC-Version={es.SEC_MS_GEC_VERSION}")
        ws = await websockets.connect(url, additional_headers=es.HEADERS, max_size=None,
                                      open_timeout=20.0)
        # The format frame is per-session, so it is sent once, here, rather than per turn.
        await ws.send(es.config_message(AUDIO_FORMAT))
        return cls(ws)

    async def say(self, voice: str, text: str, rate: str = "+0%", pitch: str = "+0Hz",
                  timeout: float = 30.0) -> np.ndarray:
        """One request, returning 16 kHz mono float32."""
        request_id = uuid.uuid4().hex
        stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
        await self.ws.send(f"X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\n"
                           f"X-Timestamp:{stamp}Z\r\nPath:ssml\r\n\r\n{ssml(voice, text, rate, pitch)}")
        pieces: list[bytes] = []
        while True:
            message = await asyncio.wait_for(self.ws.recv(), timeout)
            if isinstance(message, bytes):
                header_length = int.from_bytes(message[:2], "big")
                if b"Path:audio" in message[2:2 + header_length]:
                    pieces.append(message[2 + header_length:])
            elif "Path:turn.end" in message:
                break
        self.turns += 1
        return to_pcm16(b"".join(pieces))

    async def close(self) -> None:
        await self.ws.close()


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
