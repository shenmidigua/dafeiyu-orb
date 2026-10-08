"""Prove the docked-strip hover end to end: dock the ball, rest the pointer on the strip, watch the clip.

What this is for: "when the ball hides to a line at the screen edge, put the mouse on it and it plays
`登场水平翻转.gif`" is one behaviour spread over four layers — the helper's placement decides the ball is
docked, the page's `enterUi` arms a 120 ms dwell on the strip, `playDockArrive` puts the frame up, and
`syncGif` draws it. Reading any one of those files proves nothing about the four together, and the only
place they are all visible at once is the `<img>` the ball is actually wearing.

Two different input paths are used, each for the reason it is the only one that works:

* **the dock** is a synthetic drag through CDP's input domain. It goes straight to the renderer, so the
  helper's placement sees the same `move`/`clamp` requests a human drag produces — and, unlike real
  input, it cannot be stolen by another helper's window sitting on top of this one. Chrome reports
  `screenX` for a synthetic move relative to something that is not the screen, and the ball's drag is
  `screenX - grabOffset`, so the relationship is measured first and the drag is aimed with it.
* **the hover** is the real cursor (`SetCursorPos`), because the helper polls the operating system's
  pointer and pushes that to the page: a synthetic move would be contradicted by the next poll and the
  clip would be cleared the frame after it started. No button is ever pressed while the cursor is there.
  Coordinates are converted with `devicePixelRatio` — the page and the helper's geometry are in DIP
  pixels, the cursor is in the display's physical ones, and on this machine that is a factor of 1.25.

The cursor is put back where it was found, whatever happens.

**It cannot finish on this desktop, and the reason is worth knowing before debugging it.** The dock step
needs a drag, and a synthetic release through the DevTools protocol is not delivered to the element that
took pointer capture: the page stays in its dragging state (`gif.dataset.mode` stays `drag`), the clamp
that commits the dock never runs, and the hover below is never reached. Real input would work, but two
helper instances sit at the same default position and the live one owns the pixels, so a real drag here
moves the wrong ball. The behaviour is covered instead by `walk_dock_arrive.mjs`, which compiles the same
functions out of the installed bundle; this file is kept for the machine where it can run.

Usage: `probe_dock_arrive.py [--port 9466] [--keep]`
"""

from __future__ import annotations

import base64
import ctypes
import hashlib
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

HOME = Path.home()
RUNTIME = HOME / ".dsh" / "dsh-orb" / "electron-runtime" / "electron.exe"
INSTALLED = HOME / ".dsh" / "profiles" / "desktop" / "node_modules" / "dsh-orb" / "dist" / "helper"
LIVE_CONFIG = HOME / ".dsh" / "dsh-orb" / "memes.json"

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


class POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


def cursor() -> tuple[int, int]:
    point = POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def move_cursor(x: float, y: float) -> None:
    user32.SetCursorPos(int(round(x)), int(round(y)))


class Cdp:
    """A minimal DevTools client: one websocket, request/response by id."""

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


def images_under(root: Path, depth: int = 0) -> list[Path]:
    if depth > 4:
        return []
    found: list[Path] = []
    for entry in sorted(os.scandir(root), key=lambda item: item.name):
        path = Path(entry.path)
        if entry.is_dir():
            found += images_under(path, depth + 1)
        elif path.suffix.lower() in {".gif", ".png", ".jpg", ".jpeg", ".webp"}:
            found.append(path)
    return found


def main() -> int:
    args = sys.argv[1:]
    port = args[args.index("--port") + 1] if "--port" in args else "9466"

    config = json.loads(LIVE_CONFIG.read_text(encoding="utf8"))
    slot = config.get("dockArrive", {})
    clip = slot.get("file")
    if slot.get("enabled") is not True or not isinstance(clip, str):
        print("FAIL: memes.json names no enabled dockArrive clip, so there is nothing to watch for")
        return 1
    hit = next((path for path in images_under(Path(config["dir"])) if path.name == clip), None)
    if hit is None:
        print(f"FAIL: {clip} is not under {config['dir']}")
        return 1
    clip_url = "data:image/gif;base64," + base64.b64encode(hit.read_bytes()).decode()
    print(f"probe: dockArrive = {clip} ({hit.stat().st_size:,} bytes)")

    scratch = Path(tempfile.mkdtemp(prefix="orb-dock-probe-"))
    (scratch / "helper-data" / "probe").mkdir(parents=True)
    shutil.copyfile(LIVE_CONFIG, scratch / "memes.json")
    print(f"probe: {scratch}")

    socket_port = 19900 + (os.getpid() % 200)
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

    where = cursor()
    problems: list[str] = []
    cdp: Cdp | None = None
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

        def state() -> dict:
            return json.loads(cdp.evaluate(
                "JSON.stringify({mode: document.querySelector('#ball-gif').dataset.mode,"
                " src: document.querySelector('#ball-gif').src,"
                " docked: document.body.classList.contains('docked'),"
                " left: document.body.classList.contains('docked-left'),"
                " right: document.body.classList.contains('docked-right')})") or "{}")

        def rect(selector: str) -> dict:
            return json.loads(cdp.evaluate(f"JSON.stringify(document.querySelector('{selector}').getBoundingClientRect())") or "{}")

        def window_at() -> dict:
            return json.loads(cdp.evaluate(
                "JSON.stringify({x: window.screenX, y: window.screenY, w: window.innerWidth,"
                " h: window.innerHeight, dpr: window.devicePixelRatio,"
                # The display, in the same DIP units the helper's geometry works in: `innerWidth` is
                # the window's width, and aiming at that docks nothing.
                " sw: screen.width, sh: screen.height})") or "{}")

        def mouse(kind: str, x: float, y: float, buttons: int = 0) -> None:
            cdp.call("Input.dispatchMouseEvent", {
                "type": kind, "x": x, "y": y, "button": "left" if buttons else "none",
                "buttons": buttons, "clickCount": 1 if kind in ("mousePressed", "mouseReleased") else 0})

        for _ in range(40):
            if rect("#ball").get("width"):
                break
            time.sleep(0.25)
        time.sleep(1.5)

        # What a synthetic move reports as `screenX` is not the screen, and the ball's drag is
        # `screenX - grabOffset`, so the relationship is measured rather than assumed.
        cdp.evaluate("window.__probe = [];"
                     " document.addEventListener('pointermove', (e) => window.__probe.push("
                     "{sx: e.screenX, cx: e.clientX, sy: e.screenY, cy: e.clientY}), true)")
        mouse("mouseMoved", 400, 300, 0)
        time.sleep(0.3)
        sample = json.loads(cdp.evaluate("JSON.stringify(window.__probe.slice(-1)[0] ?? null)") or "null")
        if not sample:
            print("FAIL: the page never saw a synthetic pointer move, so the drag cannot be aimed")
            return 1
        offset_x, offset_y = sample["sx"] - sample["cx"], sample["sy"] - sample["cy"]
        print(f"      synthetic pointer: client {sample['cx']},{sample['cy']}"
              f" reported as screen {sample['sx']},{sample['sy']} (offset {offset_x},{offset_y})")

        print("\ndocking the ball with a drag past the right edge (synthetic: it reaches the renderer")
        print("directly, so another helper's window cannot steal it):")
        ball = rect("#ball")
        start_x, start_y = ball["x"] + ball["width"] / 2, ball["y"] + ball["height"] / 2
        under = cdp.evaluate(f"(() => {{ const node = document.elementFromPoint({start_x}, {start_y});"
                            " return node ? (node.id || node.className || node.tagName) : 'none' })()")
        window = window_at()
        display_right = window["sw"]
        grab_dx = start_x - ball["left"]
        # The ball's right edge has to hang past the display by `DOCK_OVERLAP` — a third of its width —
        # and the release has to stay inside the viewport, or Chrome delivers no release at all and the
        # drag never commits: the ball is left hanging mid-carry, which reads as "docking is broken".
        wanted_origin = min(display_right + 40, window["x"] + window["w"] - 8 - grab_dx)
        land_x = wanted_origin + grab_dx - offset_x
        land_y = start_y
        print(f"      ball centre {start_x:.0f},{start_y:.0f} (grab {grab_dx:.0f}px, element {under})"
              f" | display 0..{display_right:.0f} DIP, aiming for origin {wanted_origin:.0f}"
              f" -> dispatch x {land_x:.0f}")
        if under != "ball":
            problems.append(f"the ball is not under its own centre ({under})")
        else:
            mouse("mousePressed", start_x, start_y, 1)
            for step in range(1, 13):
                mouse("mouseMoved", start_x + (land_x - start_x) * step / 12, start_y, 1)
                time.sleep(0.03)
            # The window follows the ball through IPC, so for a moment after the last move the ball is
            # still painted where it was and a release at the pointer's new position lands on nothing at
            # all — which leaves the drag hanging, the ball mid-carry, and every later step wondering why
            # nothing docked. Wait for the window, then release on the ball where it actually is.
            time.sleep(0.45)
            landed = rect("#ball")
            release_x, release_y = landed["x"] + landed["width"] / 2, landed["y"] + landed["height"] / 2
            print(f"      the ball followed to {release_x:.0f},{release_y:.0f}; releasing there")
            mouse("mouseReleased", release_x, release_y, 0)

        settled = {}
        for _ in range(30):
            time.sleep(0.2)
            settled = state()
            if settled.get("docked"):
                break
        docked_side = "left" if settled.get("left") else "right" if settled.get("right") else None
        if docked_side is None:
            problems.append("the drag did not dock the ball, so the hover could not be tested")
            print(f"FAIL  the ball did not dock (docked={settled.get('docked')}, mode {settled.get('mode')})")
        else:
            print(f"ok    the ball docked to the {docked_side} and the strip is what is left")

        if docked_side is not None:
            scale = float(window_at().get("dpr") or 1.0)
            strip = rect("#dock-tab")
            window = window_at()
            target = ((window["x"] + strip["x"] + strip["width"] / 2) * scale,
                      (window["y"] + strip["y"] + strip["height"] / 2) * scale)
            print(f"      strip {strip['width']:.0f}x{strip['height']:.0f} in the page"
                  f" -> cursor {target[0]:.0f},{target[1]:.0f} (x{scale:g})")

            print("\nresting the real pointer on the strip (the helper polls the operating system's")
            print("cursor, so a synthetic move would be contradicted by the next poll — no clicks here):")
            move_cursor(*target)
            seen = None
            for _ in range(40):
                time.sleep(0.08)
                now = state()
                if now.get("src") == clip_url:
                    seen = now
                    break
            if seen is None:
                problems.append("the clip never played while the pointer rested on the strip")
                print(f"FAIL  the clip did not play (mode {state().get('mode')})")
            else:
                print(f"ok    the clip played (mode {seen.get('mode')})")
                cleared = False
                for _ in range(60):
                    time.sleep(0.08)
                    if state().get("src") != clip_url:
                        cleared = True
                        break
                print(f"{'ok  ' if cleared else 'FAIL'}  it went away again by itself")
                if not cleared:
                    problems.append("the clip stayed up instead of finishing")

            print("\na pointer crossing the strip instead of resting on it:")
            away = ((window["x"] + strip["x"] - 140) * scale, (window["y"] + strip["y"] + strip["height"] / 2) * scale)
            move_cursor(*away)
            time.sleep(0.8)
            entered = time.monotonic()
            move_cursor(*target)
            time.sleep(0.05)
            move_cursor(*away)
            dwell_ms = (time.monotonic() - entered) * 1000
            time.sleep(1.0)
            played = state().get("src") == clip_url
            if dwell_ms > 120:
                print(f"      (skipped: the crossing took {dwell_ms:.0f} ms, past the 120 ms dwell)")
            else:
                print(f"{'ok  ' if not played else 'FAIL'}  a {dwell_ms:.0f} ms crossing played nothing")
                if played:
                    problems.append("a crossing played the clip")
    finally:
        move_cursor(*where)
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

    print("\nOK: the docked strip plays the clip when the pointer rests on it, and not when it crosses"
          if not problems else f"\n{len(problems)} PROBLEM(S)")
    for problem in problems:
        print(f"  {problem}")
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
