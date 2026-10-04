"""Which domestic TTS routes actually answer from this machine, and how fast?

Two groups, because they fail differently. The cloud vendors' endpoints can only be handshaken
without a key - that still proves the route is open and shows the network floor. The free
no-key endpoints can be asked for real audio, which is the only way to compare them against the
route already running.
"""
from __future__ import annotations

import json
import socket
import ssl
import time
import urllib.parse
import urllib.request

TEXT = '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。'

CLOUD = [
    ('火山引擎/豆包', 'openspeech.bytedance.com'),
    ('火山引擎/豆包 v2', 'openspeech.bytedance.com'),
    ('阿里 dashscope', 'dashscope.aliyuncs.com'),
    ('阿里 NLS', 'nls-gateway-cn-shanghai.aliyuncs.com'),
    ('腾讯云 TTS', 'tts.cloud.tencent.com'),
    ('讯飞 TTS', 'tts-api.xfyun.cn'),
    ('MiniMax', 'api.minimaxi.com'),
    ('MiniMax 国际', 'api.minimax.chat'),
    ('硅基流动', 'api.siliconflow.cn'),
]

FREE = [
    ('百度 tts.baidu.com',
     'http://tts.baidu.com/text2audio?' + urllib.parse.urlencode(
         {'tex': TEXT, 'cuid': 'probe', 'lan': 'ZH', 'ctp': '1', 'pdt': '301',
          'vol': '9', 'rate': '32', 'per': '0'})),
    ('搜狗 fanyi.sogou.com',
     'https://fanyi.sogou.com/reventondc/synthesis?' + urllib.parse.urlencode(
         {'text': TEXT, 'speed': '1', 'lang': 'zh-CHS', 'speaker': '6'})),
    ('有道 tts.youdao.com',
     'http://tts.youdao.com/fanyivoice?' + urllib.parse.urlencode(
         {'word': TEXT, 'le': 'zh', 'keyfrom': 'speaker-target'})),
]


def tls_reach(host: str, port: int = 443, timeout: float = 6.0) -> str:
    t0 = time.perf_counter()
    try:
        raw = socket.create_connection((host, port), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return f'FAIL {type(e).__name__}'
    try:
        ssl.create_default_context().wrap_socket(raw, server_hostname=host).close()
        return f'ok {time.perf_counter() - t0:.2f}s'
    except ssl.SSLError as e:
        return f'tcp ok, tls {e.__class__.__name__} {time.perf_counter() - t0:.2f}s'
    except Exception as e:  # noqa: BLE001
        return f'tcp ok, tls FAIL {type(e).__name__}'


def free_tts(label: str, url: str) -> None:
    t0 = time.perf_counter()
    request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    try:
        with urllib.request.urlopen(request, timeout=25) as r:
            body = r.read()
            ctype = r.headers.get('Content-Type', '?')
            status = r.status
    except Exception as e:  # noqa: BLE001
        print(f'  {label:26} {type(e).__name__}: {str(e)[:60]}  ({time.perf_counter() - t0:.1f}s)')
        return
    dt = time.perf_counter() - t0
    kind = 'AUDIO' if ('audio' in ctype or body[:2] in (b'\xff\xfb', b'\xff\xf3', b'ID')) else 'NOT AUDIO'
    head = body[:70].decode('utf8', 'replace').replace('\n', ' ') if kind == 'NOT AUDIO' else ''
    print(f'  {label:26} HTTP {status}  {ctype:22} {len(body):>7,} B  {dt:5.2f}s  {kind} {head}')
    if kind == 'AUDIO':
        path = f'/tmp/free-{label.split()[0]}.mp3'
        open(path, 'wb').write(body)
        print(f'       saved {path}')


def main() -> int:
    print(f'text {len(TEXT)} chars')
    print()
    print('cloud vendor routes (handshake only, no key available):')
    for label, host in CLOUD:
        print(f'  {label:24} {host:38} {tls_reach(host)}')
    print()
    print('free no-key endpoints, asked for real audio:')
    for label, url in FREE:
        free_tts(label, url)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
