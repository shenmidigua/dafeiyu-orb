"""Time to first audio from the streaming endpoint, with the handshake the current client sends.

The earlier attempt was refused because the parameters were stale, not because the route is closed:
the version string is tied to a Chromium build, a connection id is required, and the session
carries a muid cookie. Reconstructed from the published client so the comparison is against a
working connection rather than a rejected one.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import sys
import time
import uuid

import websockets

TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
WIN_EPOCH = 11644473600
CHROMIUM = '143.0.3650.75'
MAJOR = CHROMIUM.split('.')[0]
SEC_MS_GEC_VERSION = f'1-{CHROMIUM}'

WSS = ('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
       f'?TrustedClientToken={TOKEN}')

HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                   f' (KHTML, like Gecko) Chrome/{MAJOR}.0.0.0 Safari/537.36 Edg/{MAJOR}.0.0.0'),
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'en-US,en;q=0.9',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    'Cookie': f'muid={secrets.token_hex(16).upper()};',
}

TEXT = ('收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。'
        '你要是还想继续测别的内容，直接说一声就行。')

VOICES = [
    ('zh-CN-XiaoyiNeural', '活泼年轻女声'),
    ('zh-CN-XiaoshuangNeural', '儿童音'),
    ('zh-CN-XiaoxiaoNeural', '通用女声'),
    ('zh-CN-liaoning-XiaobeiNeural', '东北女声'),
]

FORMATS = [
    ('audio-24khz-48kbitrate-mono-mp3', '48 kbps'),
    ('audio-24khz-96kbitrate-mono-mp3', '96 kbps'),
    ('audio-16khz-32kbitrate-mono-mp3', '32 kbps'),
]


def sec_ms_gec() -> str:
    ticks = time.time() + WIN_EPOCH
    ticks -= ticks % 300.0
    ticks *= 1e9 / 100.0
    return hashlib.sha256(f'{ticks:.0f}{TOKEN}'.encode('ascii')).hexdigest().upper()


def ssml(voice: str, text: str) -> str:
    return ("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
            f"<voice name='{voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>"
            f"{text}</prosody></voice></speak>")


async def synth(voice: str, fmt: str = 'audio-24khz-48kbitrate-mono-mp3',
                save: str | None = None) -> dict:
    rid = uuid.uuid4().hex
    url = (f'{WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={sec_ms_gec()}'
           f'&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}')
    out: dict = {'voice': voice, 'fmt': fmt, 'chunks': 0, 'bytes': 0, 'audio': b''}

    async with websockets.connect(url, additional_headers=HEADERS,
                                  max_size=None, open_timeout=15) as ws:
        t0 = time.perf_counter()
        config = {"context": {"synthesis": {"audio": {
            "metadataoptions": {"sentenceBoundaryEnabled": "false", "wordBoundaryEnabled": "false"},
            "outputFormat": fmt}}}}
        stamp = time.strftime('%a %b %d %Y %H:%M:%S GMT+0000', time.gmtime())
        await ws.send(f'X-Timestamp:{stamp}\r\nContent-Type:application/json; charset=utf-8\r\n'
                      f'Path:speech.config\r\n\r\n{json.dumps(config)}')
        await ws.send(f'X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\n'
                      f'X-Timestamp:{stamp}Z\r\nPath:ssml\r\n\r\n{ssml(voice, TEXT)}')

        out['first_audio'] = None
        async for message in ws:
            now = time.perf_counter() - t0
            if isinstance(message, bytes):
                if len(message) < 2:
                    continue
                n = int.from_bytes(message[:2], 'big')
                header = message[2:2 + n].decode('utf8', 'replace')
                if 'Path:audio' in header:
                    payload = message[2 + n:]
                    if out['first_audio'] is None:
                        out['first_audio'] = now
                    out['chunks'] += 1
                    out['bytes'] += len(payload)
                    out['audio'] += payload
            elif 'Path:turn.end' in message:
                out['total'] = now
                break
            else:
                out.setdefault('frames', []).append(message[:120])

    if save and out['bytes']:
        with open(save, 'wb') as fh:
            fh.write(out['audio'])
    return out


async def main() -> int:
    print(f'text {len(TEXT)} chars')
    print(f'{"voice":32} {"fmt":>8} {"first":>8} {"total":>8} {"KB":>7}')
    for voice, label in VOICES:
        try:
            r = await synth(voice)
            first = r.get('first_audio')
            first_s = f'{first:.2f}s' if first else '-'
            total_s = f'{r.get("total", 0):.2f}s' if r.get('total') else '-'
            print(f'{voice:32} {label:>8} {first_s:>8} {total_s:>8} {r["bytes"] / 1024:>7.1f}')
        except Exception as e:  # noqa: BLE001
            print(f'{voice:32} {label:>8} {"-":>8} {"-":>8} {"-":>7}  '
                  f'{type(e).__name__}: {e}')

    print()
    print('formats, same voice:')
    for fmt, label in FORMATS:
        try:
            r = await synth('zh-CN-XiaoyiNeural', fmt)
            first = r.get('first_audio')
            print(f'  {label:>8}  first={(f"{first:.2f}s" if first else "-"):>7}  '
                  f'bytes={r["bytes"]:>7,}')
        except Exception as e:  # noqa: BLE001
            print(f'  {label:>8}  {type(e).__name__}: {e}')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
