"""Can this machine reach api.fish.audio, and through what?

The sandbox injects http(s)_proxy=127.0.0.1:62009 for the agent's own traffic. That says nothing
about whether the *user's* machine can reach the host, and the answer decides whether a local
proxy is even viable. So probe both paths and report them separately.
"""
from __future__ import annotations

import json
import os
import socket
import ssl
import time


def tcp(host: str, port: int = 443, timeout: float = 8.0, resolve: bool = True) -> str:
    t0 = time.perf_counter()
    try:
        addr = socket.gethostbyname(host) if resolve else host
        s = socket.create_connection((addr, port), timeout=timeout)
        dt = time.perf_counter() - t0
        s.close()
        return f"OK    connect={dt:.3f}s  {addr}"
    except Exception as e:  # noqa: BLE001 - a probe reports, it does not raise
        dt = time.perf_counter() - t0
        return f"FAIL  after {dt:.1f}s  {type(e).__name__}: {e}"


def via_proxy(host: str, proxy_env: str) -> str:
    """A CONNECT tunnel through the agent proxy - the closest thing to a real request."""
    import urllib.request

    proxy = os.environ.get(proxy_env, '')
    if not proxy:
        return 'no proxy configured'
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({'https': proxy, 'http': proxy})
    )
    t0 = time.perf_counter()
    try:
        with opener.open(f'https://{host}/', timeout=12) as r:
            dt = time.perf_counter() - t0
            return f'OK    HTTP {r.status} in {dt:.2f}s'
    except urllib.error.HTTPError as e:
        dt = time.perf_counter() - t0
        return f'REACHED  HTTP {e.code} in {dt:.2f}s (host answered)'
    except Exception as e:  # noqa: BLE001
        dt = time.perf_counter() - t0
        return f'FAIL  after {dt:.1f}s  {type(e).__name__}: {e}'


def main() -> int:
    print('--- direct TCP 443 (what a local proxy on this machine would get) ---')
    for host in ('api.fish.audio', 'api.milorapart.top'):
        print(f'  {host:22} {tcp(host)}')
    print()
    print('--- through the agent proxy ---')
    print(f'  api.fish.audio         {via_proxy("api.fish.audio", "https_proxy")}')
    print()
    print('--- what the helper/host processes would see ---')
    print('  http_proxy  =', os.environ.get('http_proxy'))
    print('  https_proxy =', os.environ.get('https_proxy'))
    print('  no_proxy    =', os.environ.get('no_proxy'))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
