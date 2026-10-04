"""How much does striping actually buy, measured rather than sampled once?

The first pass showed four stripes beating one, which is worth having, and two stripes losing to
one, which is not credible and probably noise. Re-download the same file at several widths, repeat
each, and report medians so the number that ends up in the code is a measured one.
"""
from __future__ import annotations

import json
import statistics
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = 'https://api.milorapart.top/apis/AIvoice/'
UA = {'User-Agent': 'Mozilla/5.0'}
SPEAKER = '小女孩'
TEXT = '收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。你要是还想继续测别的内容，直接说一声就行。'
ROUNDS = 3
WIDTHS = (1, 2, 4, 6, 8, 12, 16)


def fetch(url: str, headers: dict | None = None, timeout: float = 180.0) -> tuple[int, float, float]:
    """> (bytes, seconds, seconds to first byte)"""
    request = urllib.request.Request(url, headers={**UA, **(headers or {})})
    t0 = time.perf_counter()
    with urllib.request.urlopen(request, timeout=timeout) as response:
        first, total = None, 0
        while True:
            chunk = response.read(65536)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t0
            total += len(chunk)
    return total, time.perf_counter() - t0, (first or 0.0)


def striped(url: str, size: int, workers: int) -> tuple[float, int, list[str]]:
    edge = size // workers
    spans = [(i * edge, size - 1 if i == workers - 1 else (i + 1) * edge - 1) for i in range(workers)]
    got, errors = [], []
    lock = threading.Lock()

    def one(start: int, end: int) -> None:
        try:
            n, dt, _ = fetch(url, {'Range': f'bytes={start}-{end}'})
            if n != end - start + 1:
                raise ValueError(f'short stripe {n} of {end - start + 1}')
            with lock:
                got.append(n)
        except Exception as e:  # noqa: BLE001
            with lock:
                errors.append(f'{type(e).__name__}: {e}')

    threads = [threading.Thread(target=one, args=s) for s in spans]
    t0 = time.perf_counter()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return time.perf_counter() - t0, sum(got), errors


def main() -> int:
    query = urllib.parse.urlencode({'text': TEXT, 'speaker': SPEAKER})
    with urllib.request.urlopen(urllib.request.Request(BASE + '?' + query, headers=UA), timeout=180) as r:
        url = json.loads(r.read().decode())['url']
    print(f'file: {url}')

    size, dt, ttfb = fetch(url, {'Range': 'bytes=0-0'})  # warm the connection pool, then size it
    with urllib.request.urlopen(urllib.request.Request(url, headers={**UA, 'Range': 'bytes=0-0'}), timeout=60) as r:
        total_size = int(dict(r.headers)['Content-Range'].split('/')[-1])
    print(f'size: {total_size:,} bytes   single-request ttfb ~{ttfb:.2f}s')
    print()

    print(f'{"workers":>8} {"median":>9} {"min":>9} {"KB/s":>9}   rounds')
    results = {}
    for workers in WIDTHS:
        times, bad = [], []
        for _ in range(ROUNDS):
            wall, got, errors = striped(url, total_size, workers)
            if errors or got != total_size:
                bad.append(errors[:1])
            times.append(wall)
        med = statistics.median(times)
        results[workers] = med
        print(f'{workers:>8} {med:>8.2f}s {min(times):>8.2f}s {total_size / 1024 / med:>8.1f} '
              f'  {[round(t, 2) for t in times]}{"" if not bad else "  ERRORS " + str(bad[:1])}')

    base = results[1]
    print()
    print('speed-up over a single connection:')
    for workers, med in results.items():
        print(f'  {workers:>3} ->  {base / med:4.2f}x   ({med:.2f}s vs {base:.2f}s)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
