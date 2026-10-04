"""Why is the handshake refused? Read what the endpoint actually says.

A 403 with no body tells nothing. The response usually carries a header or a short reason that
distinguishes a stale token from an unaccepted origin from a withdrawn endpoint, and the fix is
different in each case.
"""
from __future__ import annotations

import asyncio
import hashlib
import time

import websockets

TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
WIN_EPOCH = 11644473600

VARIANTS = [
    ('bing, token, origin, version',
     'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
     {'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'},
     '1-130.0.2849.68'),
    ('bing, token, no origin, version',
     'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
     {},
     '1-130.0.2849.68'),
    ('bing, token only, no version',
     'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1',
     {'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'},
     None),
    ('msedgeservices, token, origin, version',
     'wss://api.msedgeservices.com/tts/cognitiveservices/websocket/v1',
     {'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold'},
     '1-130.0.2849.68'),
]


def gec() -> str:
    ticks = time.time() + WIN_EPOCH
    ticks -= ticks % 300.0
    ticks *= 1e9 / 100.0
    return hashlib.sha256(f'{ticks:.0f}{TOKEN}'.encode()).hexdigest().upper()


async def attempt(label: str, base: str, headers: dict, version: str | None) -> None:
    params = f'TrustedClientToken={TOKEN}'
    if version:
        params += f'&Sec-MS-GEC={gec()}&Sec-MS-GEC-Version={version}'
    url = f'{base}?{params}'
    try:
        async with websockets.connect(url, additional_headers=headers, open_timeout=12) as ws:
            print(f'  {label:42} CONNECTED  subprotocol={ws.subprotocol}')
    except websockets.exceptions.InvalidStatus as e:
        r = e.response
        body = getattr(r, 'body', b'')
        text = body.decode('utf8', 'replace')[:300] if isinstance(body, (bytes, bytearray)) else str(body)[:300]
        print(f'  {label:42} HTTP {r.status_code}')
        for k in ('x-azure-ref', 'x-msedge-ref', 'www-authenticate', 'content-type',
                  'date', 'server', 'x-cache'):
            if k in r.headers:
                print(f'       {k}: {r.headers[k]}')
        if text.strip():
            print(f'       body: {text.strip()}')
    except Exception as e:  # noqa: BLE001
        print(f'  {label:42} {type(e).__name__}: {e}')


async def main() -> int:
    for label, base, headers, version in VARIANTS:
        await attempt(label, base, headers, version)
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
