"""Which Chinese voices exist, and what does the fast route actually cost end to end?

Pulls the catalogue so a voice can be chosen on evidence, saves a sample to listen to, and then
runs the same sentence through both services so the two numbers come from one sitting rather than
from recordings made under different conditions.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request
import uuid

import websockets

TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
WIN_EPOCH = 11644473600
CHROMIUM = '143.0.3650.75'
MAJOR = CHROMIUM.split('.')[0]
VOICE_LIST = ('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud'
              '/voices/list')
EDGE_WSS = ('wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
            f'?TrustedClientToken={TOKEN}')
EDGE_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                   f' (KHTML, like Gecko) Chrome/{MAJOR}.0.0.0 Safari/537.36 Edg/{MAJOR}.0.0.0'),
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Pragma': 'no-cache',
    'Cache-Control': 'no-cache',
    'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
}
MILORA = 'https://api.milorapart.top/apis/AIvoice/'
UA = {'User-Agent': 'Mozilla/5.0'}

TEXT = ('收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。'
        '你要是还想继续测别的内容，直接说一声就行。')
OUT = 'C:/Users/digua/WorkBuddy/2026-10-03-03-52-24/aivoice'


def gec() -> str:
    ticks = time.time() + WIN_EPOCH
    ticks -= ticks % 300.0
    ticks *= 1e9 / 100.0
    return hashlib.sha256(f'{ticks:.0f}{TOKEN}'.encode('ascii')).hexdigest().upper()


# ---------------------------------------------------------------- voice catalogue


def voices() -> list[dict]:
    url = (f'{VOICE_LIST}?trustedclienttoken={TOKEN}&Sec-MS-GEC={gec()}'
           f'&Sec-MS-GEC-Version=1-{CHROMIUM}')
    request = urllib.request.Request(url, headers={'User-Agent': EDGE_HEADERS['User-Agent']})
    with urllib.request.urlopen(request, timeout=30) as r:
        return json.loads(r.read().decode())


# ---------------------------------------------------------------- edge route


async def edge_say(text: str, voice: str, fmt: str = 'audio-24khz-48kbitrate-mono-mp3',
                   save: str | None = None) -> dict:
    rid = uuid.uuid4().hex
    url = (f'{EDGE_WSS}&ConnectionId={uuid.uuid4().hex}&Sec-MS-GEC={gec()}'
           f'&Sec-MS-GEC-Version=1-{CHROMIUM}')
    headers = dict(EDGE_HEADERS)
    headers['Cookie'] = f'muid={secrets.token_hex(16).upper()};'
    out: dict = {'chunks': 0, 'bytes': 0, 'audio': b'', 'first': None}
    async with websockets.connect(url, additional_headers=headers, max_size=None,
                                  open_timeout=15) as ws:
        t0 = time.perf_counter()
        stamp = time.strftime('%a %b %d %Y %H:%M:%S GMT+0000', time.gmtime())
        await ws.send(f'X-Timestamp:{stamp}\r\nContent-Type:application/json; charset=utf-8\r\n'
                      'Path:speech.config\r\n\r\n'
                      + json.dumps({"context": {"synthesis": {"audio": {
                          "metadataoptions": {"sentenceBoundaryEnabled": "false",
                                              "wordBoundaryEnabled": "false"},
                          "outputFormat": fmt}}}}))
        ssml = ("<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>"
                f"<voice name='{voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>"
                f'{text}</prosody></voice></speak>')
        await ws.send(f'X-RequestId:{rid}\r\nContent-Type:application/ssml+xml\r\n'
                      f'X-Timestamp:{stamp}Z\r\nPath:ssml\r\n\r\n{ssml}')
        async for message in ws:
            now = time.perf_counter() - t0
            if isinstance(message, bytes):
                if len(message) < 2:
                    continue
                n = int.from_bytes(message[:2], 'big')
                if b'Path:audio' in message[2:2 + n]:
                    payload = message[2 + n:]
                    if out['first'] is None:
                        out['first'] = now
                    out['chunks'] += 1
                    out['bytes'] += len(payload)
                    out['audio'] += payload
            elif 'Path:turn.end' in message:
                out['total'] = now
                break
    if save and out['bytes']:
        open(save, 'wb').write(out['audio'])
    return out


# ---------------------------------------------------------------- milora route


def milora_say(text: str, speaker: str = '小女孩', save: str | None = None) -> dict:
    query = urllib.parse.urlencode({'text': text, 'speaker': speaker})
    out: dict = {}
    t0 = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(MILORA + '?' + query, headers=UA),
                                timeout=180) as r:
        url = json.loads(r.read().decode()).get('url')
    out['api'] = time.perf_counter() - t0
    if not url:
        return out
    t1 = time.perf_counter()
    first = None
    body = b''
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        while True:
            chunk = r.read(65536)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t1
            body += chunk
    out['download'] = time.perf_counter() - t1
    out['first'] = out['api'] + first
    out['total'] = out['api'] + out['download']
    out['bytes'] = len(body)
    if save and body:
        open(save, 'wb').write(body)
    return out


async def main() -> int:
    import os
    cat = voices()
    zh = [v for v in cat if v['Locale'].startswith('zh')]
    print(f'catalogue: {len(cat)} voices, {len(zh)} Chinese')
    print()
    print('Chinese voices:')
    for v in sorted(zh, key=lambda x: (x['Locale'], x['ShortName'])):
        print(f"  {v['ShortName']:38} {v['Gender']:6} {v['Locale']:6} "
              f"{v.get('VoiceTag', {}).get('ContentCategories', '')} "
              f"{v.get('VoiceTag', {}).get('VoicePersonalities', '')}")
    print()

    voice = 'zh-CN-XiaoyiNeural'
    print(f'--- edge route, {voice}, {len(TEXT)} chars ---')
    edges = []
    for i in range(3):
        r = await edge_say(TEXT, voice, save=os.path.join(OUT, 'edge-小女孩.mp3') if i == 0 else None)
        edges.append(r)
        print(f'  run {i}: first={r["first"]:.2f}s  total={r["total"]:.2f}s  '
              f'{r["bytes"]:,} B  chunks={r["chunks"]}')
    print()

    print(f'--- milora route, 小女孩, {len(TEXT)} chars ---')
    miloras = []
    for i in range(3):
        r = milora_say(TEXT, save=os.path.join(OUT, 'milora-小女孩.mp3') if i == 0 else None)
        miloras.append(r)
        if 'total' in r:
            print(f'  run {i}: api={r["api"]:.2f}s  download={r["download"]:.2f}s  '
                  f'total={r["total"]:.2f}s  {r["bytes"]:,} B  first byte at {r["first"]:.2f}s')
        else:
            print(f'  run {i}: FAILED {json.dumps(r, ensure_ascii=False)}')
    print()

    ef = statistics.median(e['first'] for e in edges)
    et = statistics.median(e['total'] for e in edges)
    mf = statistics.median(m['first'] for m in miloras if 'first' in m)
    mt = statistics.median(m['total'] for m in miloras if 'total' in m)
    print(f'{"":22}{"first audio":>13}{"complete":>11}{"size":>11}')
    print(f'{"edge (streaming)":22}{ef:>12.2f}s{et:>10.2f}s{edges[0]["bytes"]:>10,}B')
    print(f'{"milora (file+cdn)":22}{mf:>12.2f}s{mt:>10.2f}s'
          f'{statistics.median(m["bytes"] for m in miloras if "bytes" in m):>10,.0f}B')
    print(f'{"speed-up":22}{mf / ef:>12.1f}x{mt / et:>10.1f}x')
    return 0


if __name__ == '__main__':
    raise SystemExit(asyncio.run(main()))
