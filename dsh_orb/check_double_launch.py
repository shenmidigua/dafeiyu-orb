"""Start a second copy of the proxy while the first is running, and check that it refuses to bind.

Before `Server.allow_reuse_address` was cleared, this machine happily ran two services on 8765: the
kernel gave each new connection to whichever had bound most recently, so a reply's two sentence
requests could be answered by two different processes — and one of them had stopped writing logs.

Expected now: the second copy exits within a second or two with status 1 and a line naming the
port, while the first keeps answering.

Usage: check_double_launch.py
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
import time

CREATE_NO_WINDOW = 0x08000000
PYTHON = r"D:\tools\indextts\py311\python.exe"
SCRIPT = pathlib.Path(r"D:\tools\milora\milora_server.py")


def main() -> int:
    second = subprocess.Popen(
        [PYTHON, str(SCRIPT)],
        cwd=str(SCRIPT.parent),
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"second launcher pid {second.pid}")
    try:
        code = second.wait(timeout=8)
        print(f"second launcher exited with {code}")
        ok = code != 0
    except subprocess.TimeoutExpired:
        print("second launcher is STILL RUNNING — the port was taken over")
        second.kill()
        second.wait(timeout=5)
        ok = False

    time.sleep(0.5)
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:8765/health", timeout=3) as response:
            print(f"first service still answers: HTTP {response.status}")
    except Exception as error:                      # noqa: BLE001 - the point is to report anything
        print(f"first service is NOT answering: {error}")
        ok = False
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
