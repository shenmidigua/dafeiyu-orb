"""Is the api.fish.audio trouble at the DNS layer or the routing layer?

Poisoned answers and a sandbox that fakes DNS look the same from one probe. Compare the system
resolver against public resolvers over plain UDP, and use a domain that must resolve correctly as
a control, so a wrong answer can be attributed.
"""
from __future__ import annotations

import socket
import struct
import random


def build_query(name: str) -> bytes:
    header = struct.pack('>HHHHHH', random.randrange(0, 65536), 0x0100, 1, 0, 0, 0)
    qname = b''.join(bytes([len(p)]) + p.encode() for p in name.split('.')) + b'\x00'
    return header + qname + struct.pack('>HH', 1, 1)


def parse_answers(data: bytes) -> list[str]:
    try:
        _, flags, qd, an, _, _ = struct.unpack('>HHHHHH', data[:12])
        if an == 0:
            return ['(no answer)']
        off = 12
        for _ in range(qd):
            while data[off] != 0:
                off += data[off] + 1
            off += 5
        out = []
        for _ in range(an):
            if data[off] & 0xC0 == 0xC0:
                off += 2
            else:
                while data[off] != 0:
                    off += data[off] + 1
                off += 1
            rtype, _, _, rdlen = struct.unpack('>HHIH', data[off:off + 10])
            off += 10
            if rtype == 1 and rdlen == 4:
                out.append('.'.join(str(b) for b in data[off:off + 4]))
            off += rdlen
        return out or ['(no A record)']
    except Exception as e:  # noqa: BLE001
        return [f'parse-fail {type(e).__name__}']


def ask(resolver: str, name: str) -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(4)
    try:
        s.sendto(build_query(name), (resolver, 53))
        data, _ = s.recvfrom(2048)
        return ', '.join(parse_answers(data))
    except Exception as e:  # noqa: BLE001
        return f'FAIL {type(e).__name__}'
    finally:
        s.close()


def main() -> int:
    names = ['api.fish.audio', 'fish.audio', 'example.com']
    resolvers = [('system', None), ('8.8.8.8', '8.8.8.8'), ('1.1.1.1', '1.1.1.1'), ('223.5.5.5', '223.5.5.5')]
    for name in names:
        print(f'{name}')
        for label, r in resolvers:
            if r is None:
                try:
                    print(f'   {label:10} {sorted({i[4][0] for i in socket.getaddrinfo(name, None, proto=socket.IPPROTO_TCP)})}')
                except Exception as e:  # noqa: BLE001
                    print(f'   {label:10} FAIL {type(e).__name__}')
            else:
                print(f'   {label:10} {ask(r, name)}')
        print()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
