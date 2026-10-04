"""Is api.fish.audio genuinely unreachable from here, or did one IP happen to be dead?

Round-robin DNS can hand out a bad address, so resolve repeatedly and try every address on both
80 and 443 before drawing a conclusion. Also walk the hostname up to shorter suffixes to see
whether the block is the host or the network path.
"""
from __future__ import annotations

import socket
import time

HOSTS = [
    'api.fish.audio',
    'fish.audio',
    'www.fish.audio',
    'api.milorapart.top',
]

PORTS = (443, 80)


def resolve_all(host: str) -> list[str]:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        return sorted({i[4][0] for i in infos})
    except Exception as e:  # noqa: BLE001
        return [f'DNS-FAIL:{type(e).__name__}']


def try_addr(ip: str, host: str, port: int, timeout: float = 5.0) -> str:
    t0 = time.perf_counter()
    try:
        s = socket.create_connection((ip, port), timeout=timeout)
        s.close()
        return f'OK {time.perf_counter() - t0:.2f}s'
    except Exception as e:  # noqa: BLE001
        return f'FAIL({time.perf_counter() - t0:.1f}s) {type(e).__name__}'


def main() -> int:
    print('resolving each host three times (round-robin check):')
    seen: dict[str, set[str]] = {}
    for host in HOSTS:
        ips = set()
        for _ in range(3):
            ips.update(resolve_all(host))
        seen[host] = ips
        print(f'  {host:22} {sorted(ips)}')
    print()

    print('trying every address on every port:')
    for host, ips in seen.items():
        for ip in sorted(ips):
            for port in PORTS:
                if ip.startswith('DNS-FAIL'):
                    print(f'  {host:22} {ip}')
                    break
                print(f'  {host:22} {ip:16} :{port}  {try_addr(ip, host, port)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
