"""api.fish.audio sits behind Cloudflare, and its usual edge address is unreachable.

Cloudflare is anycast: the same certificate and the same origin are served from a large pool of
addresses, and only some of them are unreachable from here. If a different edge completes the
handshake under the same SNI, the API is reachable without touching DNS at all.
"""
from __future__ import annotations

import socket
import ssl
import time

HOST = 'api.fish.audio'

CANDIDATES = [
    '104.18.0.100', '104.18.1.100', '104.16.0.1', '104.17.0.1', '104.19.0.1',
    '104.20.0.1', '104.21.0.1', '104.22.0.1', '104.23.0.1', '104.24.0.1',
    '104.25.0.1', '104.26.0.1', '104.27.0.1', '104.28.0.1', '172.64.0.1',
    '172.66.0.1', '172.67.0.1', '173.245.48.1', '103.21.244.1', '103.22.200.1',
    '103.31.4.1', '141.101.64.1', '108.162.192.1', '190.93.240.1', '188.114.96.1',
    '197.234.240.1', '198.41.128.1', '162.158.0.1', '188.114.97.1', '162.159.0.1',
]


def handshake(ip: str, timeout: float = 6.0) -> tuple[bool, str]:
    try:
        raw = socket.create_connection((ip, 443), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return False, f'tcp {type(e).__name__}'
    ctx = ssl.create_default_context()
    try:
        t = time.perf_counter()
        tls = ctx.wrap_socket(raw, server_hostname=HOST)
        dt = time.perf_counter() - t
        try:
            cert = tls.getpeercert()
            cn = dict(x[0] for x in cert.get('subject', ())).get('commonName', '?')
            sans = [v for k, v in cert.get('subjectAltName', ()) if k == 'DNS'][:3]
        finally:
            tls.close()
        return True, f'TLS OK {dt:.2f}s  cn={cn}  san={sans}'
    except Exception as e:  # noqa: BLE001
        try:
            raw.close()
        except Exception:  # noqa: BLE001
            pass
        return False, f'TLS {type(e).__name__}'


def main() -> int:
    good = []
    for ip in CANDIDATES:
        ok, detail = handshake(ip)
        mark = 'REACHABLE' if ok else '        '
        print(f'  {mark}  {ip:16} {detail}')
        if ok:
            good.append(ip)
    print()
    print('reachable edges carrying this SNI:', good or 'NONE')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
