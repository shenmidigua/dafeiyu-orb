"""Where the time in one Edge request actually goes, and whether one connection can carry many turns.

Two things this settles.

The first is a correction. The number this switch was sold on - "0.48s to first audio" - was measured
from *after* the websocket was open, so it never included getting the websocket open. End to end the
same text measures 1.5-2.4s, and if most of that is the handshake then the delay is not in the
synthesis and no amount of tuning there will help.

The second follows from the first. The orb asks for one sentence per request, so a three-sentence
reply pays the handshake three times: measured at 5.43s in hand versus 1.88s for the same text in a
single request. Real Edge holds one connection open and sends each sentence down it, which would make
the second and later sentences cost only their own synthesis. Worth confirming before building on it.

Runs with the interpreter the proxy itself uses: D:\\tools\\indextts\\py311\\python.exe
"""

from __future__ import annotations

import asyncio
import socket
import ssl
import sys
import time
import uuid

sys.path.insert(0, r"D:\tools\edgetts")

import websockets  # noqa: E402

import edge_server as edge  # noqa: E402

HOST = "speech.platform.bing.com"

TURNS = [
    "收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。",
    "你要是还想继续测别的内容，直接说一声就行。",
    "另外朗读的后端已经换掉了，现在这句话是新的服务合成的。",
]


def dial_cost() -> float:
    """Time each layer of getting a connection up, on its own."""
    print("one fresh connection, layer by layer")

    started = time.perf_counter()
    addresses = socket.getaddrinfo(HOST, 443, type=socket.SOCK_STREAM)
    dns = time.perf_counter() - started
    ip = addresses[0][4][0]

    started = time.perf_counter()
    raw = socket.create_connection((HOST, 443), timeout=15)
    tcp = time.perf_counter() - started

    started = time.perf_counter()
    tls = ssl.create_default_context().wrap_socket(raw, server_hostname=HOST)
    tls_cost = time.perf_counter() - started
    tls.close()

    async def upgrade() -> float:
        url = (f"{edge.WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={edge.sec_ms_gec()}"
               f"&Sec-MS-GEC-Version={edge.SEC_MS_GEC_VERSION}")
        started = time.perf_counter()
        async with websockets.connect(url, additional_headers=edge.HEADERS,
                                      max_size=None, open_timeout=15):
            return time.perf_counter() - started

    ws_cost = asyncio.run(upgrade())
    print(f"  dns {dns * 1000:5.0f}ms   tcp {tcp * 1000:5.0f}ms   tls {tls_cost * 1000:5.0f}ms"
          f"   ws upgrade {ws_cost * 1000:5.0f}ms   ({ip})")
    total = dns + tcp + tls_cost + ws_cost
    print(f"  -> dialling costs about {total:.2f}s before a single character is synthesised")
    return total


async def reused() -> None:
    print()
    print("the same three sentences, one connection, one config frame")
    url = (f"{edge.WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={edge.sec_ms_gec()}"
           f"&Sec-MS-GEC-Version={edge.SEC_MS_GEC_VERSION}")
    dialled = time.perf_counter()
    async with websockets.connect(url, additional_headers=edge.HEADERS,
                                  max_size=None, open_timeout=15) as ws:
        print(f"  connection open after {time.perf_counter() - dialled:.2f}s")
        for index, text in enumerate(TURNS, 1):
            try:
                # The real loop, not a copy of it - see the note on `speak_on` in edge_server.py.
                audio, first, done = await edge.speak_on(ws, edge.DEFAULT_VOICE, text,
                                                         with_config=index == 1)
            except Exception as error:  # noqa: BLE001
                print(f"  sentence {index}: FAILED  {type(error).__name__}: {str(error)[:120]}")
                return
            print(f"  sentence {index}: {len(text):>3} chars -> {len(audio) / 1024:5.1f} KB"
                  f"   first {first:5.2f}s   total {done:5.2f}s")
    print(f"  all three finished {time.perf_counter() - dialled:.2f}s after dialling began")
    print("  (compare: dialling once and asking for all three in one request, and dialling three"
          " times — see edge_bench.py)")


def main() -> int:
    dial_cost()
    asyncio.run(reused())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
