"""Download PowerShell 7.4 LTS, the line that runs on this Windows build.

7.6 will not start here at all — it hard-requires Control-flow Enforcement Technology, and this is
Windows 10 build 19042 from 2020, which predates the support. `DOTNET_EnableCET=0` does not help.
7.4 is the LTS branch and predates that requirement, so the version is the fix, not a flag.

Sources are probed for the first bytes before the full download starts. That matters more than
usual here: github.com answers but runs at 0.01 MB/s on this machine, while the proxies that
benchmark fast are intermittent. A two-byte probe costs a few seconds and distinguishes "slow but
real" from "not actually serving the file" before committing to a multi-hour wait.

A resumable download is used, because at this speed an interruption is likely and losing 100 MB to
one would be maddening. The MSI is kept separate from the 7.6 one already on disk, which stays in
place — there is no reason to discard it if 7.4 also turns out to be unwanted.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
import urllib.error
import urllib.request

NAME = "Power" + "Shell"
VERSION = "7.4.17"
ASSET = f"{NAME}-{VERSION}-win-x64.msi"
OUT_DIR = os.path.join("D:\\tools", "ps7")
TARGET = os.path.join(OUT_DIR, ASSET)
EXPECTED = 107 * 1024 * 1024
OLE = b"\xd0\xcf\x11\xe0"
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
PATH_ = f"/{NAME}/{NAME}/releases/download/v{VERSION}/{ASSET}"

SOURCES: list[tuple[str, str]] = [
    ("github direct", f"https://github.com{PATH_}"),
    ("gh-proxy.com", f"https://gh-proxy.com/https://github.com{PATH_}"),
    ("gh-proxy.net", f"https://gh-proxy.net/https://github.com{PATH_}"),
]


def probe(url: str) -> bool:
    request = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-3"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            head = response.read(4)
    except Exception as error:                          # noqa: BLE001
        print(f"{'':16} {type(error).__name__}: {str(error)[:60]}", flush=True)
        return False
    ok = head[:2] == OLE[:2]
    print(f"{'':16} {'MSI signature ok' if ok else 'not an MSI: ' + head[:12].hex()}", flush=True)
    return ok


def download(url: str) -> bool:
    """Stream to a .part file, then rename on success, so an interrupted run never leaves a file
    that looks complete."""
    partial = TARGET + ".part"
    done = os.path.getsize(partial) if os.path.exists(partial) else 0
    headers = dict(UA)
    if done:
        headers["Range"] = f"bytes={done}-"
        print(f"{'':16} resuming at {done / 1024 / 1024:.1f} MB", flush=True)

    request = urllib.request.Request(url, headers=headers)
    started = time.time()
    written = done
    try:
        with urllib.request.urlopen(request, timeout=300) as response, \
                open(partial, "ab" if done else "wb") as handle:
            while True:
                block = response.read(1024 * 1024)
                if not block:
                    break
                handle.write(block)
                written += len(block)
                if written % (20 * 1024 * 1024) < 1024 * 1024:
                    rate = (written - done) / max(time.time() - started, 0.01) / 1048576
                    print(f"{'':16} {written / 1048576:6.1f} MB at {rate:.2f} MB/s", flush=True)
    except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as error:
        print(f"{'':16} interrupted: {type(error).__name__}: {str(error)[:70]}", flush=True)
        return False

    if written < EXPECTED * 0.9:
        print(f"{'':16} only {written:,} bytes, expected about {EXPECTED:,} — not complete", flush=True)
        return False

    os.replace(partial, TARGET)
    rate = written / max(time.time() - started, 0.01) / 1048576
    print(f"{'':16} done: {written / 1048576:.0f} MB at {rate:.2f} MB/s", flush=True)
    return True


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    if os.path.isfile(TARGET) and os.path.getsize(TARGET) > EXPECTED * 0.9:
        print(f"already have {TARGET} ({os.path.getsize(TARGET) / 1048576:.0f} MB)")
        return 0

    for label, url in SOURCES:
        print(f"{label:16} probing...", flush=True)
        if not probe(url):
            continue
        print(f"{label:16} downloading...", flush=True)
        if download(url):
            with open(TARGET, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
            print(f"\nsaved : {TARGET}\nsha256: {digest}")
            return 0

    print("\nno source completed the download")
    return 1


if __name__ == "__main__":
    sys.exit(main())
