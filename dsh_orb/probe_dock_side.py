"""Measure which side of the screen the strip lands on, for each dock side, on a scratch helper.

The bug this exists for is "hide the ball to the left and the strip turns up on the right", which is a
statement about two things at once and therefore cannot be settled by reading either of them:

* **where the window is.** The docked window *is* the strip: `dockedTabBounds(side, y, display)` returns
  34 x `BALL_SIZE`, so its `x` is the whole answer to "which side is the strip on". Read from the
  operating system, by the helper's own process id.
* **where the bar is drawn inside it.** The page positions `#dock-tab` with `body.docked-left { left: 0 }`
  / `body.docked-right { right: 0 }`, which the page applies from the side the *helper* returned. This
  forces each class and reads the element's rect, which is what the two rules actually produce.

The dock is driven through `window.dshOrb.move`/`clamp` — the same calls the drag path makes — so this
needs no pointer and no drag, and it never touches the ball that is running on the desktop: the helper
started here has its own profile and its own window.

Usage: `probe_dock_side.py [--port 9477] [--keep]`
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import shutil
import socket as socket_module
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path
from ctypes import wintypes

HOME = Path.home()
RUNTIME = HOME / ".dsh" / "dsh-orb" / "electron-runtime" / "electron.exe"
INSTALLED = HOME / ".dsh" / "profiles" / "desktop" / "node_modules" / "dsh-orb" / "dist" / "helper"
LIVE_CONFIG = HOME / ".dsh" / "dsh-orb" / "memes.json"

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def windows_of(pid: int) -> list[tuple[int, int, int, int]]:
    """Every visible window this process owns, as (x, y, width, height) in physical pixels."""
    found: list[tuple[int, int, int, int]] = []

    def visit(hwnd, _param):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            found.append((rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top))
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(visit), 0)
    return found


class Cdp:
    def __init__(self, url: str) -> None:
        self.socket = socket_module.create_connection(("127.0.0.1", int(url.split(":")[2].split("/")[0])), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        path = "/" + url.split("/", 3)[3]
        self.socket.sendall((
            f"GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        handshake = b""
        while b"\r\n\r\n" not in handshake:
            handshake += self.socket.recv(4096)
        if b"101" not in handshake.split(b"\r\n")[0]:
            raise RuntimeError(f"websocket handshake failed: {handshake[:120]!r}")
        self.next_id = 1

    def _send(self, payload: bytes) -> None:
        header = bytearray([0x81])
        length = len(payload)
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += struct.pack(">H", length)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", length)
        mask = os.urandom(4)
        header += mask
        self.socket.sendall(bytes(header) + bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload)))

    def _recv(self) -> dict:
        def read(count: int) -> bytes:
            found = b""
            while len(found) < count:
                chunk = self.socket.recv(count - len(found))
                if not chunk:
                    raise EOFError("websocket closed")
                found += chunk
            return found

        header = read(2)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", read(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", read(8))[0]
        return json.loads(read(length).decode("utf8", "replace"))

    def call(self, method: str, params: dict | None = None) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self._send(json.dumps({"id": request_id, "method": method, "params": params or {}}).encode())
        while True:
            message = self._recv()
            if message.get("id") == request_id:
                return message

    def evaluate(self, expression: str):
        result = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True})
        return result.get("result", {}).get("result", {}).get("value")


def main() -> int:
    args = sys.argv[1:]
    port = args[args.index("--port") + 1] if "--port" in args else "9477"

    scratch = Path(tempfile.mkdtemp(prefix="orb-dock-side-"))
    (scratch / "helper-data" / "probe").mkdir(parents=True)
    shutil.copyfile(LIVE_CONFIG, scratch / "memes.json")

    socket_port = 19700 + (os.getpid() % 200)
    server = socket_module.socket()
    server.setsockopt(socket_module.SOL_SOCKET, socket_module.SO_REUSEADDR, 1)
    server.bind(("127.0.0.1", socket_port))
    server.listen(4)
    server.settimeout(1.0)

    env = dict(os.environ, DSH_ORB_SOCKET=f"127.0.0.1:{socket_port}", DSH_ORB_TOKEN=f"probe-{os.getpid()}")
    env.pop("ELECTRON_RUN_AS_NODE", None)
    child = subprocess.Popen(
        [str(RUNTIME), f"--user-data-dir={scratch / 'helper-data' / 'probe'}",
         str(INSTALLED / "lib" / "main.js"), f"--remote-debugging-port={port}", "--no-sandbox"],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    cdp: Cdp | None = None
    problems: list[str] = []
    try:
        page = None
        for _ in range(60):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=1) as response:
                    targets = json.load(response)
                page = next((item for item in targets if item.get("type") == "page"
                             and "floating.html" in item.get("url", "")), None)
                if page is not None:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        if page is None:
            print("FAIL: the helper never opened its page")
            return 1
        cdp = Cdp(page["webSocketDebuggerUrl"])
        cdp.call("Runtime.enable")
        for _ in range(40):
            if cdp.evaluate("!!document.querySelector('#ball')"):
                break
            time.sleep(0.25)
        time.sleep(1.0)

        screen = json.loads(cdp.evaluate(
            "JSON.stringify({sw: screen.width, sh: screen.height, dpr: devicePixelRatio,"
            " w: innerWidth, h: innerHeight})") or "{}")
        print(f"display: {screen['sw']}x{screen['sh']} DIP (x{screen['dpr']:g}),"
              f" overlay viewport {screen['w']}x{screen['h']}")

        def window_rect() -> tuple[int, int, int, int]:
            """The helper's own window, in physical pixels, scaled back to DIP for comparison."""
            found = sorted(windows_of(child.pid), key=lambda rect: rect[2] * rect[3], reverse=True)
            if not found:
                return (-1, -1, -1, -1)
            x, y, width, height = found[0]
            scale = float(screen.get("dpr") or 1)
            return (round(x / scale), round(y / scale), round(width / scale), round(height / scale))

        for side, aim in (("left", -300), ("right", screen["sw"] + 300)):
            print(f"\n--- asking the helper to dock {side} (ball origin x = {aim}) ---")
            print("    before:", window_rect())
            cdp.evaluate(f"window.dshOrb.move({aim}, 480, true)")
            time.sleep(0.2)
            result = cdp.evaluate("window.dshOrb.clamp(true).then((r) => JSON.stringify(r))")
            time.sleep(0.5)
            rect = window_rect()
            print(f"    helper says docked={result} | window now {rect} (DIP)")

            # The window is the strip: 34 DIP wide, flush with the edge it is docked to.
            edge = "left" if side == "left" else "right"
            landed = rect[0] if edge == "left" else round(screen["sw"] - (rect[0] + rect[2]))
            print(f"    its {edge} edge is {landed}px from the display's {edge} edge"
                  f" (window {rect[2]}x{rect[3]} DIP)")
            if not (0 <= landed <= 4 and 30 <= rect[2] <= 60):
                problems.append(f"a {side} dock put the strip {landed}px from the {edge} edge,"
                                f" window {rect[2]}x{rect[3]}")
                print("    FAIL: that is not a strip on the side it was docked to")

            # And the bar inside it, with the class the page applies for that side.
            for klass in ("docked-left", "docked-right"):
                bar = json.loads(cdp.evaluate(f"""(() => {{
                    document.body.classList.remove('docked-left', 'docked-right');
                    document.body.classList.add('docked', '{klass}');
                    const tab = document.querySelector('#dock-tab');
                    const rect = tab.getBoundingClientRect();
                    const after = getComputedStyle(tab, '::after');
                    // What the docked-strip arrival clip is actually painted into, and whether that is
                    // on screen at all: `syncGif` writes the clip to `#ball-gif`, which lives inside
                    // `#ball`, which the docked stylesheet hides.
                    const ball = document.querySelector('#ball');
                    const gif = document.querySelector('#ball-gif');
                    const gifRect = gif.getBoundingClientRect();
                    return JSON.stringify({{klass: '{klass}', x: rect.x, width: rect.width,
                      barLeft: after.left, barRight: after.right, body: innerWidth,
                      ballVisibility: getComputedStyle(ball).visibility,
                      gifX: gifRect.x, gifWidth: gifRect.width, gifHeight: gifRect.height}});
                }})()""") or "{}")
                print(f"    {klass}: box x={bar.get('x'):.0f} w={bar.get('width'):.0f} of {bar.get('body')}"
                      f" | bar left={bar.get('barLeft')} right={bar.get('barRight')}"
                      f" | ball visibility={bar.get('ballVisibility')}"
                      f" | ball-gif {bar.get('gifWidth')}x{bar.get('gifHeight')} at x={bar.get('gifX'):.0f}")
            cdp.evaluate("window.dshOrb.unsnap()")
            time.sleep(0.4)
    finally:
        if cdp is not None:
            try:
                cdp.socket.close()
            except Exception:
                pass
        child.terminate()
        try:
            child.wait(timeout=10)
        except Exception:
            child.kill()
        server.close()
        if "--keep" not in args:
            shutil.rmtree(scratch, ignore_errors=True)

    print("\nOK: each side lands on its own edge" if not problems else f"\n{len(problems)} PROBLEM(S)")
    for problem in problems:
        print(f"  {problem}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
