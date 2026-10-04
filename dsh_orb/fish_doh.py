"""Can a real IP be recovered for api.fish.audio, and would connecting to it work?

Every ordinary resolver returned a different forged address for the fish.audio names, which is the
signature of on-path DNS injection rather than a resolver misconfiguration. Query DNS over HTTPS
instead - that traffic is not readable to the injector - and then try to open a socket to whatever
real address comes back, because a correct address is only useful if the route exists.
"""
from __future__ import annotations

import json
import socket
import ssl
import time
import urllib.request

DOH = {
    'alidns': 'https://dns.alidns.com/resolve?name={name}&type=A',
    'dnspod': 'https://doh.pub/dns-query?name={name}&type=A',
    'cloudflare': 'https://cloudflare-dns.com/dns-query?name={name}&type=A',
}

NAMES = ['api.fish.audio', 'fish.audio']


def doh(url: str) -> list[str]:
    req = urllib.request.Request(url, headers={'accept': 'application/dns-json'})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            data = json.loads(r.read().decode())
        return [a['data'] for a in data.get('Answer', []) if a.get('type') == 1]
    except Exception as e:  # noqa: BLE001
        return [f'FAIL {type(e).__name__}']


def tcp(ip: str, port: int = 443, timeout: float = 6.0) -> str:
    t0 = time.perf_counter()
    try:
        s = socket.create_connection((ip, port), timeout=timeout)
        s.close()
        return f'OK {time.perf_counter() - t0:.2f}s'
    except Exception as e:  # noqa: BLE001
        return f'FAIL({time.perf_counter() - t0:.1f}s) {type(e).__name__}'


def main() -> int:
    found: dict[str, set[str]] = {}
    for name in NAMES:
        print(f'{name}')
        ips: set[str] = set()
        for label, tpl in DOH.items():
            ans = doh(tpl.format(name=name))
            print(f'   {label:11} {ans}')
            ips.update(a for a in ans if a[0].isdigit())
        found[name] = ips
        print()

    print('trying recovered addresses:')
    for name, ips in found.items():
        for ip in sorted(ips):
            print(f'  {name:16} {ip:16} :443  {tcp(ip)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
