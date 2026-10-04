"""Is the reset caused by the destination address, or by the name in the handshake?

If the same address completes a handshake under a different SNI, the socket is fine and something
is resetting on the name specifically. That distinction decides whether any local workaround could
ever help, so measure it rather than assume.
"""
from __future__ import annotations

import socket
import ssl

IP = '104.18.0.100'
TRIALS = [
    ('api.fish.audio', 'the blocked name'),
    ('cloudflare.com', 'a name that must work through the same edge'),
    ('example.com', 'a second control'),
]


def handshake(ip: str, sni: str, timeout: float = 10.0) -> str:
    try:
        raw = socket.create_connection((ip, 443), timeout=timeout)
    except Exception as e:  # noqa: BLE001
        return f'tcp FAIL {type(e).__name__}'
    ctx = ssl.create_default_context()
    try:
        tls = ctx.wrap_socket(raw, server_hostname=sni)
        try:
            cert = tls.getpeercert().get('subject', [])
            ver = tls.version()
        finally:
            tls.close()
        return f'TLS OK  {ver}  cert={cert}'
    except Exception as e:  # noqa: BLE001
        try:
            raw.close()
        except Exception:  # noqa: BLE001
            pass
        return f'TLS FAIL  {type(e).__name__}: {e}'


def main() -> int:
    for sni, why in TRIALS:
        print(f'  SNI={sni:20} ({why})')
        print(f'      {handshake(IP, sni)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
