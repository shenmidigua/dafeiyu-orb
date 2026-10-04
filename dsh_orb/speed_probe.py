"""Is the audio download slow per connection, or slow overall?

The two answer opposite questions. If a single connection is capped but the host serves several at
once, the file can be fetched in parallel stripes and the wait collapses. If the host simply has
little bandwidth in total, parallelism changes nothing and the only fix is a different host or a
smaller file. Measure before choosing.

Also checks whether the download host is actually the API host, since a separate CDN would be a
different problem with different fixes.
"""
from __future__ import annotations

import json
import socket
import threading
import time
import urllib.parse
import urllib.request

BASE = 'https://api.milorapart.top/apis/AIvoice/'
UA = {'User-Agent': 'Mozilla/5.0'}

TEXT = '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。你要是还想继续测别的内容，直接说一声就行。'
SPEAKER = '小女孩'


def kb(seconds: float, size: int) -> str:
    if seconds <= 0:
        return '?'
    return f'{size / 1024 / seconds:6.1f} KB/s'


def timed_get(url: str, headers: dict | None = None, timeout: float = 120.0,
              sink: list | None = None, label: str = '') -> tuple[int, float, dict]:
    request = urllib.request.Request(url, headers={**UA, **(headers or {})})
    t0 = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        info = dict(response.headers)
        status = response.status
        total = 0
        first = None
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t0
            total += len(chunk)
            if sink is not None:
                sink.append(chunk)
    dt = time.perf_counter() - t0
    info['_ttfb'] = first
    info['_label'] = label
    return total, dt, info


def parallel(url: str, workers: int, size: int) -> dict:
    """Fetch the same file in `workers` contiguous stripes and report the aggregate rate."""
    edge = size // workers
    ranges = []
    for i in range(workers):
        start = i * edge
        end = size - 1 if i == workers - 1 else (i + 1) * edge - 1
        ranges.append((start, end))

    results: list[tuple[int, float]] = []
    errors: list[str] = []
    lock = threading.Lock()

    def one(start: int, end: int) -> None:
        try:
            n, dt, _ = timed_get(url, {'Range': f'bytes={start}-{end}'})
            with lock:
                results.append((n, dt))
        except Exception as e:  # noqa: BLE001
            with lock:
                errors.append(f'{type(e).__name__}: {e}')

    threads = [threading.Thread(target=one, args=r) for r in ranges]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    wall = time.perf_counter() - t0
    got = sum(n for n, _ in results)
    return {'workers': workers, 'wall': wall, 'bytes': got, 'errors': errors,
            'per_thread': [round(dt, 2) for _, dt in results]}


def main() -> int:
    query = urllib.parse.urlencode({'text': TEXT, 'speaker': SPEAKER})
    url_api = BASE + '?' + query
    print(f'text {len(TEXT)} chars, speaker {SPEAKER}')

    t0 = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(url_api, headers=UA), timeout=180) as r:
        body = json.loads(r.read().decode())
    api_dt = time.perf_counter() - t0
    url = body.get('url')
    print(f'  api      {api_dt:6.2f}s   {body.get("msg")}')
    print(f'  file url {url}')
    host = urllib.parse.urlparse(url).netloc
    print(f'  file host {host}   api host {urllib.parse.urlparse(BASE).netloc}'
          f'   same={host == urllib.parse.urlparse(BASE).netloc}')
    if not url:
        return 1

    print()
    print('--- single connection, three times ---')
    size = 0
    for i in range(3):
        sink: list = []
        size, dt, info = timed_get(url, sink=sink, label=f'single#{i}')
        print(f'  run {i}  {size:>8,} B  {dt:6.2f}s  {kb(dt, size)}'
              f'   ttfb={info["_ttfb"]:.2f}s  status=200'
              f'   accept-ranges={info.get("Accept-Ranges")}  enc={info.get("Content-Encoding")}')

    print()
    print('--- range support ---')
    try:
        n, dt, info = timed_get(url, {'Range': 'bytes=0-1023'})
        print(f'  Range 0-1023 -> got {n} B, {dt:.2f}s, content-range={info.get("Content-Range")}')
    except Exception as e:  # noqa: BLE001
        print(f'  Range request failed: {type(e).__name__}: {e}')

    print()
    print('--- parallel stripes over the same file ---')
    for workers in (2, 4, 8):
        out = parallel(url, workers, size)
        agg = out['bytes'] / out['wall'] if out['wall'] else 0
        print(f'  {workers} workers  got {out["bytes"]:>8,} B in {out["wall"]:6.2f}s'
              f'  ->  {agg / 1024:6.1f} KB/s aggregate'
              f'   per-thread {out["per_thread"]}'
              f'{"" if not out["errors"] else "  errors=" + str(out["errors"][:2])}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
