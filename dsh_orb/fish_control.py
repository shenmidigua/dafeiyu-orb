"""Control: does raw TLS egress work from this sandbox at all?

If a handshake to a destination that certainly works fails the same way, then everything measured
above says something about the sandbox and nothing about fish.audio. Establish that first, on the
same code path, before trusting any conclusion about the blocked name.
"""
from __future__ import annotations

import socket
import ssl
import time

TARGETS = [
    ('172.66.147.243', 'example.com', 'control - a plain site that resolves normally'),
    ('104.18.0.100', 'api.fish.audio', 'the blocked name, via its real Cloudflare address'),
    ('104.18.0.100', 'cloudflare.com', 'same address, unrelated SNI'),
    ('38.76.197.6', 'api.milorapart.top', 'the service that demonstrably works today'),
]


def handshake(ip: str, sni: str, timeout: float = 10.0) -> str:
    t0 = time.perf_counter()
    try:
        raw = socket.create_connection((ip, 443), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return f'tcp FAIL {type(e).__name__}'
    tcp = time.perf_counter() - t0
    ctx = ssl.create_default_context()
    try:
        t = time.perf_counter()
        tls = ctx.wrap_socket(raw, server_hostname=sni)
        dt = time.perf_counter() - t
        try:
            got = f'{tls.version()}  cert={tls.getpeercert().get("subject", [])}'
        finally:
            tls.close()
        return f'tcp {tcp:.2f}s  TLS OK {dt:.2f}s  {got}'
    except Exception as e:  # noqa: BLE001
        try:
            raw.close()
        except Exception:  # noqa: BLE001
            pass
        return f'tcp {tcp:.2f}s  TLS FAIL {type(e).__name__}: {e}'


def plain_http(ip: str, host: str, timeout: float = 8.0) -> str:
    """No TLS at all - isolates the ip from the name entirely."""
    try:
        s = socket.create_connection((ip, 80), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return f'tcp FAIL {type(e).__name__}'
    s.settimeout(timeout)
    try:
        s.sendall(f'GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n'.encode())
        data = s.recv(200)
        return f'got {len(data)} bytes: {data.split(b"\\r\\n")[0].decode("latin1")}'
    except Exception as e:  # noqa: BLE001
        return f'send/recv FAIL {type(e).__name__}: {e}'
    finally:
        s.close()


def main() -> int:
    for ip, sni, why in TARGETS:
        print(f'  {ip:16} SNI={sni:20} ({why})')
        print(f'      {handshake(ip, sni)}')
    print()
    print('plain HTTP on :80, no TLS, name only in the Host header')
    print(f'  104.18.0.100   Host: api.fish.audio   {plain_http("104.18.0.100", "api.fish.audio")}')
    print(f'  172.66.147.243 Host: example.com      {plain_http("172.66.147.243", "example.com")}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
