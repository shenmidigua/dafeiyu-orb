"""Find which output formats the Edge read-aloud endpoint will actually accept.

`raw-16khz-16bit-mono-pcm` is an Azure format name and Edge answers it with a bare
`Unsupported Edge output format`, closing the socket. The set Edge accepts is undocumented and is not
the set Azure documents, so it is measured here instead of assumed.

Each candidate needs its own connection: the format frame is the first thing a session sends and a
rejected one kills the session, so there is no way to ask twice on one socket.
"""

from __future__ import annotations

import asyncio
import sys
import time
import uuid

sys.path.insert(0, r"D:\tools\edgetts")
import edge_server as es  # noqa: E402

import websockets  # noqa: E402

CANDIDATES = [
    "audio-24khz-48kbitrate-mono-mp3",       # known good: what the orb plays today
    "audio-24khz-96kbitrate-mono-mp3",
    "audio-24khz-160kbitrate-mono-mp3",
    "audio-16khz-32kbitrate-mono-mp3",
    "audio-16khz-64kbitrate-mono-mp3",       # ideal: already 16 kHz, so no resample needed
    "audio-16khz-128kbitrate-mono-mp3",
    "audio-48khz-96kbitrate-mono-mp3",
    "riff-16khz-16bit-mono-pcm",
    "riff-24khz-16bit-mono-pcm",
    "raw-16khz-16bit-mono-pcm",
    "raw-24khz-16bit-mono-pcm",
    "webm-16khz-16bit-mono-opus",
    "webm-24khz-16bit-mono-opus",
    "ogg-16khz-16bit-mono-opus",
    "ogg-24khz-16bit-mono-opus",
]

TEXT = "大肥鱼"
VOICE = "zh-CN-XiaoyiNeural"


def sniff(data: bytes) -> str:
    """Name the container from its first bytes, so a success is not just 'some bytes arrived'."""
    if data[:4] == b"RIFF":
        return "RIFF/WAV"
    if data[:3] == b"ID3":
        return "MP3 (ID3)"
    if data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "MP3 (sync)"
    if data[:4] == b"OggS":
        return "OGG"
    if data[:4] == b"\x1a\x45\xdf\xa3":
        return "WebM/Matroska"
    return f"? head={data[:4].hex()}"


async def attempt(fmt: str) -> str:
    url = (f"{es.WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={es.sec_ms_gec()}"
           f"&Sec-MS-GEC-Version={es.SEC_MS_GEC_VERSION}")
    started = time.perf_counter()
    try:
        async with websockets.connect(url, additional_headers=es.HEADERS, max_size=None,
                                      open_timeout=15.0) as ws:
            await ws.send(es.config_message(fmt))
            request_id = uuid.uuid4().hex
            stamp = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())
            await ws.send(f"X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\n"
                          f"X-Timestamp:{stamp}Z\r\nPath:ssml\r\n\r\n{es.ssml(VOICE, TEXT)}")
            pieces: list[bytes] = []
            while True:
                message = await asyncio.wait_for(ws.recv(), 20.0)
                if isinstance(message, bytes):
                    header_length = int.from_bytes(message[:2], "big")
                    if b"Path:audio" in message[2:2 + header_length]:
                        pieces.append(message[2 + header_length:])
                elif "Path:turn.end" in message:
                    break
            data = b"".join(pieces)
            elapsed = time.perf_counter() - started
            if not data:
                return f"EMPTY (accepted, no audio)  {elapsed:.2f}s"
            return f"OK  {len(data):>7} B  {sniff(data):<14} {elapsed:.2f}s"
    except Exception as error:  # noqa: BLE001
        detail = str(error).replace("\n", " ")[:78]
        return f"REJECTED  {type(error).__name__}: {detail}"


async def main() -> int:
    for fmt in CANDIDATES:
        print(f"  {fmt:34} {await attempt(fmt)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
