"""Record what is actually on screen while the mouse moves onto the floating ball.

Why this exists: the ball is drawn by an Electron renderer inside a window the helper owns, and
its screen position is the window's origin plus its offset inside the window — two values set by
two processes, which cannot land in the same frame. Two page-side attempts to stop the ball
appearing in the panel's top-left corner for a frame both looked correct in the source and both
changed nothing on the real machine, so reading the DOM is not enough — the frames themselves have
to be looked at. The arrangement that ended it is that the window is *one rect in both states* and
the ball keeps one offset in it; this watches for a frame that breaks either. With the ball
temporarily painted flat magenta (`ORB-FLASH-DEBUG` in `floating.css`) every frame carries the
ball's exact position, so a wrong one cannot hide between frames.

Usage: `capture_hover.py [--cycles 3] [--out DIR]`
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import re
import statistics
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image, ImageGrab

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

# The page's own sizes, in CSS pixels, mirroring the geometry the helper builds its window from:
# `BALL_SIZE`, `CHROME_INSET`, `PANEL_SIZE` and `PANEL_GAP` in `src/geometry.ts`. The two columns
# below are the very values `floating.css` carries as `--ball-column` / `--ball-row`.
BALL_CSS = 288
CHROME_CSS = 12
PANEL_CSS = (420, 520)
PANEL_GAP_CSS = 10

# Where the ball sits inside the window — the same in every direction, on purpose. The ball's
# screen position is the window's origin plus this offset, and the origin is moved by the main
# process while this is applied by the page, so an offset that varied with the direction was a ball
# drawn a whole panel away from the pointer whenever the page was a frame behind. The direction now
# decides only which side the card opens on.
BALL_COLUMN_CSS = CHROME_CSS + PANEL_CSS[0] + PANEL_GAP_CSS              # 442
BALL_ROW_CSS = CHROME_CSS + (PANEL_CSS[1] - BALL_CSS)                    # 244
PANEL_WINDOW_CSS = (
    BALL_COLUMN_CSS + BALL_CSS + PANEL_GAP_CSS + PANEL_CSS[0] + CHROME_CSS,   # 1172
    BALL_ROW_CSS + PANEL_CSS[1] + CHROME_CSS,                                # 776
)

# The helper window is the overlay rect in both states: `PANEL_WINDOW_SIZE`, 1172x776 DIP, which
# Windows reports in physical pixels. Each axis is checked against its own expectation scaled from
# 100% to 200%, with slack for a fractional scale factor rounding it — a single square range
# cannot work, because the rect is half again as wide as it is tall.
def _axis_range(css: int) -> tuple[int, int]:
    return (round(css * 0.95), round(css * 2.1))


WINDOW_WIDTH = _axis_range(PANEL_WINDOW_CSS[0])
WINDOW_HEIGHT = _axis_range(PANEL_WINDOW_CSS[1])
# How far the region reaches around the ball, in CSS pixels. From the ball's own square the window
# extends `BALL_COLUMN - CHROME` = 430 px to either side and `BALL_ROW - CHROME` = 232 px up and
# down — the ball sits at 442,244 of a 1172x776 rect, so the panel's far edge is 1160 across and
# 764 down. The extra is slack, so the very edge of a stale frame is inside the region rather than
# on its border. **These are CSS values and have to be scaled before use**: they are added to
# physical coordinates, and the display runs at 125%, so the CSS margin is not the physical one —
# typing the physical number here instead is what makes the region quietly miss the panel's far
# edge at any scale but 100%.
ROI_LEFT, ROI_TOP, ROI_RIGHT, ROI_BOTTOM = 450, 250, 450, 250

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


@dataclass
class BallWindow:
    hwnd: int
    pid: int
    process: str
    client: tuple[int, int, int, int]
    horizontal: str = "left"
    vertical: str = "down"

    @property
    def ball(self) -> tuple[int, int, int]:
        """The ball's own physical square, at the one place in the window it ever occupies.

        `horizontal` / `vertical` are no longer read here, and that is the point: the ball's offset
        is `--ball-column` / `--ball-row` in every direction, so neither the page's layout nor this
        probe has any corner to pick. The side length comes from the ball's own size rather than the
        window's, so it stays right at any scale factor — 288 CSS px of a 1172-wide window, not a
        fraction of the window.
        """
        x, y, width, _height = self.client
        scale = width / PANEL_WINDOW_CSS[0]
        side = round(scale * BALL_CSS)
        return (x + round(scale * BALL_COLUMN_CSS), y + round(scale * BALL_ROW_CSS), side)


def process_name(pid: int) -> str:
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1]
        return ""
    finally:
        kernel32.CloseHandle(handle)


def ball_window() -> BallWindow:
    """The one visible helper window, at the overlay size, plus the direction the page reports.

    The direction is read for the report only — it no longer moves the ball, so nothing here
    depends on getting it right. It still cannot be guessed from the rect anyway: the rect is the
    same one in every direction, which is the whole arrangement. The page reports it through
    `document.title`, which is the only channel available while DevTools is not — the helper's
    `DevToolsActivePort` is stale and 9222 refuses connections.
    """
    found: list[BallWindow] = []
    names: dict[int, str] = {}

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
            return True
        width, height = rect.right, rect.bottom
        # Each axis against its own expectation: the overlay is 1172x776, not a square.
        if not (WINDOW_WIDTH[0] <= width <= WINDOW_WIDTH[1]):
            return True
        if not (WINDOW_HEIGHT[0] <= height <= WINDOW_HEIGHT[1]):
            return True
        origin = wintypes.POINT(0, 0)
        if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in names:
            names[pid.value] = process_name(pid.value)
        if names[pid.value] != "electron.exe":
            return True
        horizontal, vertical = page_direction(hwnd)
        found.append(BallWindow(int(hwnd), pid.value, names[pid.value],
                                (origin.x, origin.y, width, height), horizontal, vertical))
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    if not found:
        raise SystemExit("no electron.exe window shaped like the overlay is on screen")
    if len(found) > 1:
        print(f"warning: {len(found)} candidates, taking the largest", file=sys.stderr)
    return max(found, key=lambda w: w.client[2])


def page_direction(hwnd: int) -> tuple[str, str]:
    """Read `ORB-DIR-<horizontal>-<vertical>` out of the page's title.

    Reported, not relied on: since the ball sits at `--ball-column` / `--ball-row` in every
    direction, a wrong answer here cannot move where the probe thinks the ball is. The fallback is
    the corner a default profile rests in, which is what the page wears before its own answer
    arrives.
    """
    length = user32.GetWindowTextLengthW(hwnd)
    if length <= 0:
        return "left", "down"
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    found = re.search(r"ORB-DIR-(left|right)-(up|down)", buf.value)
    if found is None:
        return "left", "down"
    return found.group(1), found.group(2)


def cursor() -> tuple[int, int]:
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return (point.x, point.y)


def virtual_screen() -> tuple[int, int, int, int]:
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


@dataclass
class Frame:
    t: float
    count: int
    box: tuple[int, int, int, int] | None
    centre: tuple[float, float] | None
    image: np.ndarray | None = field(default=None, repr=False)


def magenta_box(frame: np.ndarray) -> tuple[int, int, int, int] | None:
    """Bounding box (x, y, w, h) of the flat magenta disc, in frame coordinates."""
    red, green, blue = frame[:, :, 0], frame[:, :, 1], frame[:, :, 2]
    mask = (red > 200) & (green < 80) & (blue > 200)
    rows = np.flatnonzero(mask.any(axis=1))
    if rows.size == 0:
        return None
    cols = np.flatnonzero(mask.any(axis=0))
    return (int(cols[0]), int(rows[0]), int(cols[-1] - cols[0] + 1), int(rows[-1] - rows[0] + 1))


def centroid(frame: np.ndarray) -> tuple[float, float] | None:
    red, green, blue = frame[:, :, 0], frame[:, :, 1], frame[:, :, 2]
    mask = (red > 200) & (green < 80) & (blue > 200)
    total = int(mask.sum())
    if total == 0:
        return None
    ys, xs = np.nonzero(mask)
    return (float(xs.mean()), float(ys.mean()))


def record(roi: tuple[int, int, int, int], seconds: float, stop: threading.Event, frames: list[Frame]) -> None:
    """Grab the region as fast as the machine will let us until `stop` is set."""
    left, top = roi[0], roi[1]
    start = time.perf_counter()
    while not stop.is_set() and time.perf_counter() - start < seconds:
        t = time.perf_counter() - start
        image = ImageGrab.grab(bbox=roi, all_screens=True).convert("RGB")
        frame = np.asarray(image)
        box = magenta_box(frame)
        centre = centroid(frame) if box else None
        frames.append(Frame(t, int(box[2] * box[3]) if box else 0, box, centre))
    print(f"captured {len(frames)} frames over {time.perf_counter() - start:.2f}s", file=sys.stderr)


def drive(target: tuple[int, int], home: tuple[int, int], frames: list[Frame], stop: threading.Event,
          cycles: int) -> None:
    """Walk the pointer onto the ball and back, one cycle per hover, recording throughout."""
    def glide(to: tuple[int, int], steps: int) -> None:
        from_x, from_y = cursor()
        for step in range(1, steps + 1):
            x = round(from_x + (to[0] - from_x) * step / steps)
            y = round(from_y + (to[1] - from_y) * step / steps)
            user32.SetCursorPos(x, y)
            time.sleep(0.012)

    time.sleep(0.35)
    for cycle in range(cycles):
        glide(target, 10)
        time.sleep(0.9)          # the panel opens, then stays open
        glide(home, 10)
        time.sleep(1.1)          # the panel collapses again
    stop.set()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--seconds", type=float, default=30.0)
    parser.add_argument("--out", type=Path, default=Path(__file__).with_name("capture"))
    args = parser.parse_args()

    window = ball_window()
    ball_x, ball_y, side = window.ball
    # The display's scale, read back off the ball the probe already located: `ball` is in physical
    # pixels and `BALL_CSS` says what it ought to be in CSS ones. Every `ROI_*` below is a CSS
    # margin and is scaled here, because it is added to a physical coordinate.
    scale = side / BALL_CSS
    screen = virtual_screen()
    roi = (
        max(screen[0], ball_x - round(ROI_LEFT * scale)),
        max(screen[1], ball_y - round(ROI_TOP * scale)),
        min(screen[0] + screen[2], ball_x + side + round(ROI_RIGHT * scale)),
        min(screen[1] + screen[3], ball_y + side + round(ROI_BOTTOM * scale)),
    )
    print(f"ball window: client={window.client} (physical px)  direction {window.horizontal}/{window.vertical}")
    print(f"ball: {ball_x},{ball_y} {side}x{side} (scale {scale:.3f})")
    print(f"ball centre: {ball_x + side // 2},{ball_y + side // 2}")
    print(f"region: {roi[0]},{roi[1]} .. {roi[2]},{roi[3]}  ({roi[2] - roi[0]}x{roi[3] - roi[1]})")

    home = cursor()
    print(f"cursor home: {home}")
    frames: list[Frame] = []
    stop = threading.Event()
    reader = threading.Thread(target=record, args=(roi, args.seconds, stop, frames), daemon=True)
    reader.start()
    carer = threading.Thread(target=drive, args=((ball_x + side // 2, ball_y + side // 2), home,
                                                 frames, stop, args.cycles), daemon=True)
    carer.start()
    carer.join()
    stop.set()
    reader.join()
    user32.SetCursorPos(*home)

    if not frames:
        print("nothing captured")
        return 1

    gaps = [b.t - a.t for a, b in zip(frames, frames[1:])]
    period = statistics.median(gaps) if gaps else 0
    print(f"\nframe period: median {period * 1000:.1f} ms  ({1 / period:.0f} fps)"
          f"  max {max(gaps) * 1000:.1f} ms  min {min(gaps) * 1000:.1f} ms")

    # Where the ball sits at rest, and where a stale or half-laid-out frame would put it: the
    # expanded window's own top-left corner, which is one panel width and one panel height away.
    rest = (float(ball_x + side / 2 - roi[0]), float(ball_y + side / 2 - roi[1]))
    print(f"rest centre in frame coordinates: {rest[0]:.0f},{rest[1]:.0f}")

    args.out.mkdir(parents=True, exist_ok=True)
    suspect: list[int] = []
    shown = 0
    print("\n   t(ms)  magenta   box(x,y,w,h)                 centre          note")
    for index, frame in enumerate(frames):
        if frame.centre is None:
            note = "NO BALL AT ALL"
        else:
            distance = ((frame.centre[0] - rest[0]) ** 2 + (frame.centre[1] - rest[1]) ** 2) ** 0.5
            if distance < side * 0.6:
                note = "at rest"
            elif distance < side * 1.6:
                note = "moved (panel opening?)"
            else:
                note = f"ELSEWHERE by {distance:.0f}px"
                suspect.append(index)
        if frame.box is not None and frame.box[2] * frame.box[3] < side * side * 0.25:
            note += "  (small!)"
        if note != "at rest" or shown < 3:
            shown += 1
            print(f"{frame.t * 1000:8.0f}  {frame.count:7d}   {str(frame.box):28s} "
                  f"{('%7.0f,%-7.0f' % frame.centre) if frame.centre else '        --       '}  {note}")

    for index in suspect:
        path = args.out / f"suspect-{frames[index].t * 1000:.0f}ms.png"
        ImageGrab.grab(bbox=roi, all_screens=True).save(path)

    print(f"\nframes: {len(frames)}   suspicious: {len(suspect)}")
    if suspect:
        print("suspicious frames at ms: " + ", ".join(f"{frames[i].t * 1000:.0f}" for i in suspect))
    return 0


if __name__ == "__main__":
    sys.exit(main())
