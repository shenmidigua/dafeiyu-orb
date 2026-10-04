"""Drag the ball with the real mouse and check, from the page's own numbers, that it came along.

This is the acceptance test for the reported bug — "the GIF's position wanders while I drag the
ball". It exists because the two halves of that bug are each invisible from one side:

*   The ball's screen position is `window origin + its offset inside the window`. The origin is set
    by the main process, the offset by the page, in two frames that cannot be committed together.
    `rects.mjs` checks the page half by wearing each direction in turn; this checks the pair, during
    the one gesture where they can disagree.
*   The main process re-decides the direction on **every** move, while the page never re-applies it
    during a drag (`moveBall` only applies `docked`). So a drag that crosses the middle of the work
    area has the two sides disagreeing about which corner the ball lives in — which is what the
    `body.expand-* #ball` rules used to make visible, by moving the ball between corners. They are
    gone now, and `packages/helper/tests/geometry.test.ts` fails if one comes back.

Why the real mouse and not injected events: the input domain takes window-relative coordinates, so
injecting means turning a screen target into `target - window.screenX` — computing it from the very
value that is in motion during a drag. Driving that way produced a 627px jump out of a 64px request
and then a window that stopped moving entirely; both were the harness, not the helper. A real cursor
is where it is, and the page reads `event.screenX` off it directly. The pointer is left where it was
found.

Where the ball is gets read two ways, so that a disagreement between them is itself a finding:

*   `drag_watch.mjs` reports the page's own `window.screenX + #ball rect` — the composition above,
    measured inside the page.
*   Win32 reports the window's client origin, sampled while the pointer is settled, and the ball's
    place inside the window is added from the layout (`BALL_COLUMN`, `BALL_ROW`).

Usage: `drag_probe.py [--expect fixed|broken] [--step 64] [--settle 0.25]`
Needs a helper running on `--remote-debugging-port=9222` (fake-host.mjs does that), and one that was
NOT launched by DSH — the parking spot is found by parent process, because both are electron.exe from
the same runtime and the window rects are now identical too.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import BALL_COLUMN_CSS, BALL_ROW_CSS, PANEL_WINDOW_CSS  # noqa: E402
from stop_fake_host import snapshot  # noqa: E402

HERE = Path(__file__).parent
WATCHER = HERE / "drag_watch.mjs"
NODE = r"C:\Users\digua\.workbuddy\binaries\node\versions\22.22.2-5\node.exe"

user32 = ctypes.WinDLL("user32", use_last_error=True)
user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
user32.GetDpiForWindow.restype = wintypes.UINT
user32.SetCursorPos.argtypes = [ctypes.c_int, ctypes.c_int]
user32.mouse_event.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
                               ctypes.c_void_p]
user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
user32.SetProcessDpiAwarenessContext(-4)      # PER_MONITOR_AWARE_V2, so a pixel is a pixel

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def fake_host_pids() -> set[int]:
    """The electron.exe processes `fake-host.mjs` started: node's descendants, and only those.

    The live ball DSH is running is the same binary from the same runtime directory, and since the
    never-resize change its window is 1172x776 as well — so neither the process name nor the window
    rect tells them apart any more. The parent does.
    """
    procs = snapshot()
    node_pids = {pid for pid, _, name in procs if name.lower() == "node.exe"}
    targets: set[int] = set()
    changed = True
    while changed:
        changed = False
        for pid, ppid, name in procs:
            if name.lower() != "electron.exe" or pid in targets:
                continue
            if ppid in node_pids or ppid in targets:
                targets.add(pid)
                changed = True
    return targets


def client_origin(hwnd: int) -> tuple[int, int, int, int]:
    origin = wintypes.POINT(0, 0)
    user32.ClientToScreen(hwnd, ctypes.byref(origin))
    rect = wintypes.RECT()
    user32.GetClientRect(hwnd, ctypes.byref(rect))
    return origin.x, origin.y, rect.right, rect.bottom


def parked_window() -> tuple[int, int, int, int, int, int]:
    """The fake host's helper window: `hwnd`, client origin and size in physical px, and its dpi."""
    wanted = fake_host_pids()
    if not wanted:
        raise SystemExit("no fake-host electron is running: start fake-host.mjs first")
    found: list[tuple[int, int, int, int, int]] = []

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in wanted:
            return True
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        if rect.right <= 0 or rect.bottom <= 0:
            return True
        origin = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(origin))
        found.append((int(hwnd), origin.x, origin.y, rect.right, rect.bottom))
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    if not found:
        raise SystemExit(f"the fake host (pids {sorted(wanted)}) has no visible window")
    hwnd, x, y, width, height = max(found, key=lambda w: w[3] * w[4])
    return hwnd, x, y, width, height, int(user32.GetDpiForWindow(hwnd))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", choices=("fixed", "broken"), default="fixed")
    parser.add_argument("--step", type=float, default=64.0, help="CSS px per move")
    parser.add_argument("--settle", type=float, default=0.25, help="seconds held still before each sample")
    parser.add_argument("--tolerance", type=float, default=6.0, help="CSS px")
    parser.add_argument("--out", type=Path, default=HERE / "drag-samples.jsonl")
    args = parser.parse_args()

    hwnd, wx, wy, ww, wh, dpi = parked_window()
    print(f"fake-host window hwnd=0x{hwnd:x} client {wx},{wy} {ww}x{wh} physical  dpi {dpi}")

    home = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(home))
    home_pos = (home.x, home.y)

    watcher = subprocess.Popen(
        [NODE, str(WATCHER), str(args.out), "600"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    time.sleep(3.0)          # let it attach, turn transitions off, and report where the ball is
    if watcher.poll() is not None:
        _out, err = watcher.communicate()
        print("the watcher exited early:", err.decode("utf8", "replace")[:600])
        return 1

    # Everything the drag is built from is read off the page, not assumed from the layout: the
    # display's scale is `devicePixelRatio`, and the ball's square is the page's own rect. That keeps
    # the same probe honest against a build with a different layout — the pre-fix package puts the
    # ball at (446, 248) in a 746x548 window, and deriving anything from the fixed build's constants
    # would have measured the harness instead of the helper.
    first = None
    for _ in range(60):
        with open(args.out, encoding="utf8") as handle:
            for line in handle:
                if line.strip():
                    first = json.loads(line)
                    break
        if first is not None:
            break
        time.sleep(0.25)
    if first is None:
        print("the page reported nothing: is the watcher attached to the fake host's page?")
        watcher.kill()
        return 1

    scale = float(first["dpr"])
    ball_css_x, ball_css_y = float(first["bx"]), float(first["by"])
    side_css = float(first["bw"])
    viewport = f"{first['iw']}x{first['ih']}"
    print(f"from the page: viewport {viewport}, devicePixelRatio {scale}"
          f" (the layout would suggest {ww / PANEL_WINDOW_CSS[0]:.4f})")
    print(f"from the page: the ball sits at {ball_css_x:.1f},{ball_css_y:.1f}"
          f" {side_css:.0f}x{side_css:.0f} CSS"
          + (f"   (the layout's fixed offset is {BALL_COLUMN_CSS},{BALL_ROW_CSS})"
             if abs(ball_css_x - BALL_COLUMN_CSS) > 0.6 or abs(ball_css_y - BALL_ROW_CSS) > 0.6
             else "   (as the layout has it)"))

    anchor_x = wx + round((ball_css_x + side_css / 2) * scale)
    anchor_y = wy + round((ball_css_y + side_css / 2) * scale)
    print(f"ball on screen: {wx + round(ball_css_x * scale)},{wy + round(ball_css_y * scale)}"
          f" {round(side_css * scale)}x{round(side_css * scale)} physical, centre {anchor_x},{anchor_y}")

    left = user32.GetSystemMetrics(SM_XVIRTUALSCREEN)
    top = user32.GetSystemMetrics(SM_YVIRTUALSCREEN)
    avail_w = user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)
    avail_h = user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)
    print(f"virtual screen {left},{top} {avail_w}x{avail_h} physical"
          f"  ({avail_w / scale:.0f}x{avail_h / scale:.0f} CSS)")

    # Pressing on the ball's centre makes `ballGrabOffset` half the ball, in CSS px, so the ball's
    # left has to end up that far left of the cursor for the drag to be following the pointer.
    grab_css = side_css / 2
    # The cursor range that keeps the ball's whole square inside the work area.
    low_x = round(grab_css * scale)
    high_x = round((avail_w / scale - side_css + grab_css) * scale)
    low_y = round(grab_css * scale)
    high_y = round((avail_h / scale - side_css + grab_css) * scale)

    # Each step records the window during which its cursor position was settled, along with where the
    # window was at that moment. A sample is judged only inside such a window, so the pointer's own
    # one-frame lag cannot be mistaken for the defect and no sample is paired with a cursor position
    # or a window rect it was not taken under.
    settled: list[dict] = []

    def move_to(x: float, y: float, phase: str) -> None:
        target = (max(left, min(left + avail_w - 1, int(x))),
                  max(top, min(top + avail_h - 1, int(y))))
        user32.SetCursorPos(*target)
        time.sleep(args.settle)
        cx, cy, cw, ch = client_origin(hwnd)
        settled.append({"from": time.time(), "to": time.time() + 30.0,
                        "cursor": target, "client": (cx, cy, cw, ch), "phase": phase})

    def walk(axis: str, hold: float, start_at: float, low: float, high: float, phase: str) -> None:
        """From `start_at` down to `low`, then all the way to `high`, a step at a time."""
        step = args.step * scale
        targets = []
        value = start_at
        while value > low:
            value = max(low, value - step)
            targets.append(value)
        value = targets[-1] if targets else start_at
        while value < high:
            value = min(high, value + step)
            targets.append(value)
        for value in targets:
            move_to(value if axis == "x" else hold, value if axis == "y" else hold, phase)

    print(f"\ndragging with the real mouse, {args.step:g} CSS px ({args.step * scale:.0f} physical)"
          f" per move, held still {args.settle * 1000:.0f} ms before each sample")

    user32.SetCursorPos(anchor_x, anchor_y)
    time.sleep(0.3)
    print(f"pressing at {anchor_x},{anchor_y} (the ball's centre)")
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, None)
    time.sleep(args.settle)

    print("--- across, from the ball's own column to the left edge and then to the right ---")
    walk("x", anchor_y, anchor_x, low_x, high_x, "across")
    print("--- down and up, holding the ball's own row's column ---")
    walk("y", anchor_x, anchor_y, low_y, high_y, "down/up")

    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, None)
    time.sleep(0.8)
    user32.SetCursorPos(*home_pos)
    print(f"released, cursor restored to {home_pos}")
    watcher.terminate()
    try:
        watcher.wait(timeout=15)
    except subprocess.TimeoutExpired:
        watcher.kill()

    samples = []
    with open(args.out, encoding="utf8") as handle:
        for line in handle:
            line = line.strip()
            if line:
                samples.append(json.loads(line))
    print(f"\nthe page reported {len(samples)} samples over {len(settled)} settled cursor positions")
    if not samples:
        print("no samples: is the watcher attached to the fake host's page?")
        return 1

    rows = []
    for s in samples:
        t = s["t"] / 1000.0
        matching = [w for w in settled if w["from"] <= t <= w["to"]]
        if not matching:
            continue
        w = matching[-1]
        cursor_x, cursor_y = w["cursor"]
        client_x, client_y, _cw, _ch = w["client"]
        # What is actually on screen. The ball is drawn inside the window's surface, and the surface
        # is placed by the OS at the window's real origin — which is what Win32 reports. The page's
        # `#ball` rect is the offset it chose inside that surface. So the visible position is the two
        # together, and `window.screenX` does not enter into it: that value is the page's own view of
        # the window origin and it trails the real one by up to a step (measured below), which would
        # show up as a phantom defect if it were used here.
        page_left = s["sx"] + s["bx"]
        page_top = s["sy"] + s["by"]
        visible_left = client_x / scale + s["bx"]
        visible_top = client_y / scale + s["by"]
        # What the main process alone decided, with the offset taken from the layout instead of from
        # the page — the same thing as `visible` unless the page's offset disagrees with the layout.
        layout_left = client_x / scale + BALL_COLUMN_CSS
        layout_top = client_y / scale + BALL_ROW_CSS
        expected_left = cursor_x / scale - grab_css
        expected_top = cursor_y / scale - grab_css
        rows.append({
            "phase": w["phase"], "cursor": (cursor_x, cursor_y),
            "visible": (visible_left, visible_top), "page": (page_left, page_top),
            "layout": (layout_left, layout_top), "offset": (s["bx"], s["by"]),
            "err_visible_x": visible_left - expected_left,
            "err_visible_y": visible_top - expected_top,
            "err_layout_x": layout_left - expected_left, "err_layout_y": layout_top - expected_top,
            "window": (s["sx"], s["sy"]), "client": (client_x, client_y),
            "viewport": f"{s['iw']}x{s['ih']}",
            "cls": s["cls"], "tab": s["tab"],
        })

    if not rows:
        print("no sample fell inside a settled window")
        return 1

    for r in rows:
        r["drift_visible_x"] = ((r["visible"][0] - rows[0]["visible"][0])
                                - (r["cursor"][0] - rows[0]["cursor"][0]) / scale)
        r["drift_visible_y"] = ((r["visible"][1] - rows[0]["visible"][1])
                                - (r["cursor"][1] - rows[0]["cursor"][1]) / scale)
        r["drift_page_x"] = ((r["page"][0] - rows[0]["page"][0])
                             - (r["cursor"][0] - rows[0]["cursor"][0]) / scale)
        r["drift_page_y"] = ((r["page"][1] - rows[0]["page"][1])
                             - (r["cursor"][1] - rows[0]["cursor"][1]) / scale)

    viewports = sorted({r["viewport"] for r in rows})
    classes = sorted({r["cls"] for r in rows})
    offsets = sorted({(round(r["offset"][0]), round(r["offset"][1])) for r in rows})
    worst = lambda key: max(rows, key=lambda r: abs(r[key]))  # noqa: E731

    print(f"\nbody class during the drag: {' | '.join(classes) if classes else '(none)'}")
    print(f"viewport sizes seen: {', '.join(viewports)}"
          f"   <- one value means nothing resized mid-drag")
    print(f"the ball's offset inside the window: "
          + (f"frozen at {offsets[0]} throughout" if len(offsets) == 1
             else f"{len(offsets)} different values: {offsets}")
          + f"   <- the layout says ({BALL_COLUMN_CSS}, {BALL_ROW_CSS})")

    print(f"\nwhere the ball is, against where the drag says it should be, in CSS px:")
    print(f"  visible (window origin + the page's own offset)"
          f": worst {worst('err_visible_x')['err_visible_x']:+8.1f} across,"
          f" {worst('err_visible_y')['err_visible_y']:+8.1f} down")
    print(f"  layout only (window origin + the layout's offset)"
          f": worst {worst('err_layout_x')['err_layout_x']:+8.1f} across,"
          f" {worst('err_layout_y')['err_layout_y']:+8.1f} down")
    print(f"  the page's own composition, as a drift"
          f":     worst {worst('drift_page_x')['drift_page_x']:+8.1f} across,"
          f" {worst('drift_page_y')['drift_page_y']:+8.1f} down"
          f"   (it uses `window.screenX`, which trails the real origin)")

    # One row per settled cursor position: the page reports ~20 samples a second and they repeat.
    seen: dict[tuple[int, int], dict] = {}
    for r in rows:
        seen[r["cursor"]] = r
    ordered = [seen[c] for c in sorted(seen, key=lambda c: (c[1], c[0]))]
    print(f"\n{'phase':9s} {'cursor':>13s} {'visible':>13s} {'layout':>13s} {'offset':>11s}"
          f" {'err visible':>17s} {'drift page':>17s}")
    for r in ordered:
        print(f"{r['phase']:9s} {r['cursor'][0]:6d},{r['cursor'][1]:<6d}"
              f" {r['visible'][0]:6.0f},{r['visible'][1]:<6.0f}"
              f" {r['layout'][0]:6.0f},{r['layout'][1]:<7.0f}"
              f" {r['offset'][0]:5.0f},{r['offset'][1]:<5.0f}"
              f" {r['err_visible_x']:+8.1f},{r['err_visible_y']:+8.1f}"
              f" {r['drift_page_x']:+8.1f},{r['drift_page_y']:+8.1f}")

    bad = [r for r in rows
           if abs(r["err_visible_x"]) > args.tolerance or abs(r["err_visible_y"]) > args.tolerance]
    print(f"\nsamples putting the ball more than {args.tolerance:g}px from the pointer:"
          f" {len(bad)} of {len(rows)}")
    for r in bad[:12]:
        print(f"    {r['phase']:9s} cursor {r['cursor'][0]},{r['cursor'][1]}"
              f"  ball {r['visible'][0]:.0f},{r['visible'][1]:.0f}"
              f"  offset {r['offset'][0]:.0f},{r['offset'][1]:.0f}"
              f"  err {r['err_visible_x']:+.1f},{r['err_visible_y']:+.1f}  {r['cls']}")
    if len(bad) > 12:
        print(f"    ... {len(bad) - 12} more")

    fixed = len(bad) == 0 and len(viewports) == 1 and len(offsets) == 1
    print(f"\nthe ball stayed under the pointer: {'YES' if fixed else 'NO'}"
          + ("" if len(viewports) == 1 else "   (and the window resized mid-drag)")
          + ("" if len(offsets) == 1 else "   (and the page's own offset moved mid-drag)"))
    print(f"expected for {args.expect}: {'YES' if args.expect == 'fixed' else 'NO'}"
          f"   -> {'AS EXPECTED' if fixed == (args.expect == 'fixed') else 'UNEXPECTED'}")
    return 0 if fixed == (args.expect == "fixed") else 2


if __name__ == "__main__":
    sys.exit(main())
