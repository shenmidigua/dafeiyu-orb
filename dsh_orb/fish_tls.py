"""With the poisoned name bypassed, does the request actually complete?

A successful TCP connect to a Cloudflare anycast address proves nothing on its own - the edge
answers for every tenant. What matters is whether a TLS handshake carrying SNI `api.fish.audio`
survives, and whether the API then answers. Send SNI explicitly, to the recovered address, and
read the response.
"""
from __future__ import annotations

import json
import socket
import ssl
import time

HOST = 'api.fish.audio'
ADDRS = ['104.18.0.100', '104.18.1.100']


def https(ip: str, path: str, method: str = 'GET', body: bytes | None = None,
          headers: dict | None = None, timeout: float = 15.0) -> dict:
    out: dict = {'ip': ip, 'path': path}
    t0 = time.perf_counter()
    try:
        raw = socket.create_connection((ip, 443), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        out['tcp'] = f'FAIL {type(e).__name__}'
        return out
    out['tcp'] = f'{time.perf_counter() - t0:.3f}s'

    ctx = ssl.create_default_context()
    t1 = time.perf_counter()
    try:
        # server_hostname is the whole point: it is what the injector would look for.
        tls = ctx.wrap_socket(raw, server_hostname=HOST)
    except Exception as e:  # noqa: BLE001
        out['tls'] = f'FAIL {type(e).__name__}: {e}'
        raw.close()
        return out
    out['tls'] = f'{time.perf_counter() - t1:.3f}s'
    out['peer_cert'] = tls.getpeercert().get('subject', [])
    out['alpn'] = tls.selected_alpn_protocol()

    head = f'{method} {path} HTTP/1.1\r\nHost: {HOST}\r\nConnection: close\r\n'
    for k, v in (headers or {}).items():
        head += f'{k}: {v}\r\n'
    if body is not None:
        head += f'Content-Length: {len(body)}\r\n\r\n'
        payload = head.encode() + body
    else:
        head += '\r\n'
        payload = head.encode()

    t2 = time.perf_counter()
    try:
        tls.sendall(payload)
        buf = b''
        first = None
        while True:
            chunk = tls.recv(65536)
            if not chunk:
                break
            if first is None:
                first = time.perf_counter() - t2
            buf += chunk
    except Exception as e:  # noqa: BLE001
        out['read'] = f'FAIL {type(e).__name__}: {e}'
        tls.close()
        return out
    finally:
        try:
            tls.close()
        except Exception:  # noqa: BLE001
            pass

    out['ttfb'] = f'{first:.3f}s' if first else None
    out['total'] = f'{time.perf_counter() - t2:.3f}s'
    out['bytes'] = len(buf)
    head_bytes, _, rest = buf.partition(b'\r\n\r\n')
    out['status'] = head_bytes.split(b'\r\n', 1)[0].decode('latin1')
    out['preview'] = rest[:220].decode('utf8', 'replace')
    return out


def main() -> int:
    for ip in ADDRS:
        print(json.dumps(https(ip, '/'), ensure_ascii=False, indent=2))
        print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
