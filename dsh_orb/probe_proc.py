"""Identify a process by its executable path, and check the read-aloud service the hard way.

Reading the command line of another process needs the target's PEB, which is not worth the
machinery here. The image path is enough to answer the only question that matters: is this the
interpreted service at D:\\tools\\indextts, or something else entirely?

The health probe deliberately bypasses the proxy environment the sandbox exports, because that
proxy answers for loopback and turns a healthy service into an HTTP 502.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import json
import socket
import sys
import urllib.error
import urllib.request

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.QueryFullProcessImageNameW.argtypes = [
    wintypes.HANDLE,
    wintypes.DWORD,
    wintypes.LPWSTR,
    ctypes.POINTER(wintypes.DWORD),
]

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
ENDPOINT = "http://127.0.0.1:8765"


def image_path(pid: int) -> str:
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return "(cannot open)"
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(size.value)
        ok = k32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size))
        return buffer.value if ok else "(query failed)"
    finally:
        k32.CloseHandle(handle)


def probe() -> None:
    for label, url in (("health", f"{ENDPOINT}/health"),):
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(url, timeout=6) as response:
                print(f"  {label}: HTTP {response.status} {response.read().decode('utf8', 'replace')[:200]}")
        except urllib.error.HTTPError as error:
            print(f"  {label}: HTTP {error.code} {error.read().decode('utf8', 'replace')[:200]}")
        except Exception as error:
            print(f"  {label}: {type(error).__name__}: {error}")


def main(argv: list[str]) -> int:
    for pid in (arg for arg in argv[1:] if arg.isdigit()):
        print(f"pid {pid}: {image_path(int(pid))}")

    print(f"\nconnecting to {ENDPOINT}:")
    sock = socket.socket()
    sock.settimeout(4.0)
    try:
        sock.connect(("127.0.0.1", 8765))
        print("  tcp: connected")
    except Exception as error:
        print(f"  tcp: {type(error).__name__}: {error}")
    finally:
        sock.close()

    probe()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
