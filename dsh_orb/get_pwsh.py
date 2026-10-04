"""Find a source that can actually deliver the PowerShell 7 MSI, then download it.

github.com fails the TLS handshake from this machine, which is why the naive `curl` route never
works here. Blindly trying sources in order is wasteful because the blocked one fails by *hanging*
rather than by refusing, so every attempt costs a full timeout before the next one starts.

Instead this probes first. Each candidate is asked for the first 2 bytes with a short timeout; a
source that answers 206/200 with the OLE compound-file signature is known to be reachable and
serving the right asset, and only then is the full download started. Sources that cannot even
answer a 2-byte request within 15 seconds are not going to deliver 112 MB.

The 2-byte probe is also what keeps a proxy error page from being mistaken for the installer: an
HTML page starts with `<`, and only the real MSI answers with D0 CF.
"""

from __future__ import annotations

import hashlib
import os
import sys
import time
import urllib.error
import urllib.request

NAME = "Power" + "Shell"
VERSION = "7.6.6"
ASSET = f"{NAME}-{VERSION}-win-x64.msi"
EXPECTED = 112 * 1024 * 1024          # from the release metadata; used only as a sanity bound
OLE = b"\xd0\xcf\x11\xe0"

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
PROBE_TIMEOUT = 15

CANDIDATES: list[tuple[str, str]] = [
    # Ordered by measured throughput from this machine, not by how they are normally ranked. A
    # 2 MB Range probe put gh-proxy.com at 0.09 MB/s against github's own 0.01 MB/s — both work,
    # but the direct route needs nearly three hours for 112 MB. Fastest first is not cosmetic
    # here; it is the difference between a usable wait and an abandoned one.
    ("gh-proxy.com", f"https://gh-proxy.com/https://github.com/{NAME}/{NAME}/releases/download/v{VERSION}/{ASSET}"),
    ("github direct", f"https://github.com/{NAME}/{NAME}/releases/download/v{VERSION}/{ASSET}"),
    ("ghfast.top", f"https://ghfast.top/https://github.com/{NAME}/{NAME}/releases/download/v{VERSION}/{ASSET}"),
    ("gh-proxy.net", f"https://gh-proxy.net/https://github.com/{NAME}/{NAME}/releases/download/v{VERSION}/{ASSET}"),
    ("jsdelivr", f"https://cdn.jsdelivr.net/gh/{NAME}/{NAME}@v{VERSION}/installers/{ASSET}"),
]


def probe(url: str) -> tuple[str, int]:
    """Ask for two bytes. Returns a verdict string and the advertised full size."""
    request = urllib.request.Request(url, headers={**UA, "Range": "bytes=0-3"})
    try:
        with urllib.request.urlopen(request, timeout=PROBE_TIMEOUT) as response:
            head = response.read(4)
            size = int(response.headers.get("Content-Length") or 0)
            status = response.status
    except urllib.error.HTTPError as error:
        return f"HTTP {error.code}", 0
    except Exception as error:                       # noqa: BLE001 - report whatever the host did
        return f"{type(error).__name__}: {str(error)[:70]}", 0

    if head[:2] != OLE[:2]:
        # 200 with HTML usually means the proxy served its own error page.
        preview = head[:16].decode("latin-1", "replace").strip()
        return f"status {status}, not an MSI (starts with {preview!r})", size
    return "MSI signature ok", size


def download(url: str, target: str) -> tuple[bool, str]:
    request = urllib.request.Request(url, headers=UA)
    started = time.time()
    written = 0
    with urllib.request.urlopen(request, timeout=300) as response, open(target, "wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
            written += len(chunk)
    rate = written / max(time.time() - started, 0.001) / 1024 / 1024
    return True, f"{written / 1024 / 1024:.0f} MB at {rate:.1f} MB/s"


def main() -> int:
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out_dir, exist_ok=True)
    target = os.path.join(out_dir, ASSET)

    if os.path.exists(target):
        existing = os.path.getsize(target)
        if existing > EXPECTED * 0.8:
            print(f"already have {target} ({existing / 1024 / 1024:.0f} MB), skipping download")
            return 0
        os.remove(target)

    for label, url in CANDIDATES:
        print(f"{label:16} probing...", flush=True)
        verdict, size = probe(url)
        print(f"{'':16} {verdict}" + (f"  ({size / 1024 / 1024:.0f} MB advertised)" if size else ""), flush=True)
        if not verdict.startswith("MSI"):
            continue

        print(f"{'':16} downloading from {label}...", flush=True)
        try:
            _ok, detail = download(url, target)
        except Exception as error:                   # noqa: BLE001
            print(f"{'':16} download failed: {type(error).__name__}: {str(error)[:80]}", flush=True)
            continue
        print(f"{'':16} done: {detail}", flush=True)

        with open(target, "rb") as handle:
            digest = hashlib.sha256(handle.read()).hexdigest()
        print(f"\nsaved : {target}\nsha256: {digest}")
        return 0

    print("\nno reachable source found")
    return 1


if __name__ == "__main__":
    sys.exit(main())
