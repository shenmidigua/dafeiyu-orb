"""Catch the frame the ball spends somewhere else, without predicting where it goes.

`capture_hover.py` grabs a region the size of the expanded window through `ImageGrab`, which
costs ~30ms a call no matter how small the rectangle is — far slower than the single frame this
is about. So this does the blit itself, into a DIB section that is blitted once per frame and
read zero-copy, which is fast enough to see every presented frame.

It also does not guess. Rather than betting on one theory of where the ball wrongly appears, it
covers the whole area the ball could be in with a grid, and reports the magenta pixels' centroid
every frame. If the sheet of frames says the centroid ever leaves the ball's own square, the
artifact is real and its landing place is a measurement rather than a hypothesis; if it never
does, then the ball is not what the eye is seeing move.

The ball is flat magenta for the duration (`ORB-FLASH-DEBUG` in `floating.css`), which is what
makes the centroid meaningful. The mouse is driven for the run, so a hover is guaranteed whether
or not anyone is at the desk.

Usage: `flash_spot.py [--cycles 10]`
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import statistics
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import PANEL_WINDOW_CSS, ball_window, cursor, user32  # noqa: E402

gdi32 = ctypes.windll.gdi32

SRCCOPY = 0x00CC0020
DIB_RGB_COLORS = 0
SPACING = 100        # grid pitch, physical pixels; the ball is 360 across, so it is always hit
PATCH = 4            # pixels sampled at each grid point
BALL_CSS = 288
MAGENTA_MIN = 2      # of PATCH * PATCH, enough to tell the disc from an antialiased stray


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD), ("biWidth", ctypes.c_long), ("biHeight", ctypes.c_long),
        ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", ctypes.c_long),
        ("biYPelsPerMeter", ctypes.c_long), ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]


class Screen:
    """One reusable DIB, blitted from the screen and read without copying out of it."""

    def __init__(self, box: tuple[int, int, int, int]) -> None:
        self.left, self.top, self.right, self.bottom = box
        self.width = self.right - self.left
        self.height = self.bottom - self.top
        self.screen_dc = user32.GetDC(None)
        self.memory_dc = gdi32.CreateCompatibleDC(self.screen_dc)
        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = self.width
        info.bmiHeader.biHeight = -self.height      # top-down: row 0 is the top of the screen
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0            # BI_RGB
        self.bits = ctypes.c_void_p()
        self.bitmap = gdi32.CreateDIBSection(
            self.screen_dc, ctypes.byref(info), DIB_RGB_COLORS, ctypes.byref(self.bits), None, 0
        )
        if not self.bitmap:
            raise SystemExit("could not make a DIB section to blit into")
        gdi32.SelectObject(self.memory_dc, self.bitmap)

    def grab_rows(self) -> list[bytes]:
        """Blit the region once and hand back its rows, top-down, as raw BGRX."""
        if not gdi32.BitBlt(self.memory_dc, 0, 0, self.width, self.height,
                            self.screen_dc, self.left, self.top, SRCCOPY):
            raise SystemExit("BitBlt failed")
        stride = self.width * 4
        base = self.bits.value
        return [ctypes.string_at(base + y * stride, self.width * 4)
                for y in range(0, self.height)]

    def find_moving_box(self, gap: float = 0.12, step: int = 4,
                        delta: int = 18) -> tuple[int, int, int, int] | None:
        """The bounding box of whatever is animating in this region.

        The ball is a GIF, so it changes every frame whatever state the page is in; the desktop
        behind the window and the panel's own chrome do not. Differencing two grabs a moment apart
        therefore finds the ball without being told where it is, and — unlike looking for the
        magenta paint — it works on the shipped build, so a check that depends on it does not have
        to run against an instrumented package.

        The box is the union of the changed pixels, so a stray change elsewhere in the region (a
        blinking caret in a window behind, a clock) would widen it. Nothing else in the region is
        expected to be live during a measurement, and the caller checks the size anyway.
        """
        first = self.grab_rows()
        time.sleep(gap)
        second = self.grab_rows()
        min_x, min_y = self.width, self.height
        max_x = max_y = -1
        for y in range(0, self.height, step):
            a, b = first[y], second[y]
            for x in range(0, self.width, step):
                at = x * 4
                if (abs(a[at] - b[at]) > delta or abs(a[at + 1] - b[at + 1]) > delta
                        or abs(a[at + 2] - b[at + 2]) > delta):
                    if x < min_x:
                        min_x = x
                    if x > max_x:
                        max_x = x
                    if y < min_y:
                        min_y = y
                    max_y = y
        if max_x < 0:
            return None
        return (self.left + min_x, self.top + min_y, self.left + max_x, self.top + max_y)

    def find_magenta_box(self, step: int = 8) -> tuple[int, int, int, int] | None:
        """The bounding box of the magenta paint, found by scanning the region coarsely.

        Used once, to learn where the ball is, rather than being told. The window is the overlay
        rect in both states now, so the ball's offset inside it depends on which column the page
        wears, and reading that out of the page needs either DevTools (whose port is stale here) or
        instrumentation of the installed file. The paint is already there for the measurement, so
        looking at it is both simpler and more direct: this reports what is on screen, not what
        the layout ought to be.
        """
        if not gdi32.BitBlt(self.memory_dc, 0, 0, self.width, self.height,
                            self.screen_dc, self.left, self.top, SRCCOPY):
            raise SystemExit("BitBlt failed")
        stride = self.width * 4
        base = self.bits.value
        min_x, min_y = self.width, self.height
        max_x = max_y = -1
        for y in range(0, self.height, step):
            line = ctypes.string_at(base + y * stride, self.width * 4)
            row_hit = False
            for x in range(0, self.width, step):
                at = x * 4
                if line[at + 2] > 200 and line[at + 1] < 80 and line[at] > 200:
                    row_hit = True
                    if x < min_x:
                        min_x = x
                    if x > max_x:
                        max_x = x
            if row_hit:
                if y < min_y:
                    min_y = y
                max_y = y
        if max_x < 0:
            return None
        return (self.left + min_x, self.top + min_y, self.left + max_x, self.top + max_y)

    def sample(self, grid_x: list[int], grid_y: list[int]) -> tuple[int, tuple[float, float] | None]:
        """Blit once, then read only the bytes the grid actually asks for.

        Copying the whole buffer out costs 3.6MB a frame and dominated the loop; the grid needs
        `PATCH` bytes of a few rows per point, so that is all it takes. The colour test is done on
        the bytes directly for the same reason: at this size the per-point cost of reaching for
        numpy is larger than the work.
        """
        if not gdi32.BitBlt(self.memory_dc, 0, 0, self.width, self.height,
                            self.screen_dc, self.left, self.top, SRCCOPY):
            raise SystemExit("BitBlt failed")
        stride = self.width * 4
        base = self.bits.value
        total = 0
        weighted_x = 0.0
        weighted_y = 0.0
        for y in grid_y:
            for x in grid_x:
                found = 0
                for row in range(PATCH):
                    line = ctypes.string_at(base + (y + row) * stride + x * 4, PATCH * 4)
                    for column in range(PATCH):
                        at = column * 4
                        if line[at + 2] > 200 and line[at + 1] < 80 and line[at] > 200:
                            found += 1
                if found >= MAGENTA_MIN:
                    total += found
                    weighted_x += x * found
                    weighted_y += y * found
        if total == 0:
            return 0, None
        return total, (weighted_x / total, weighted_y / total)


@dataclass
class Row:
    t: float
    total: int
    centre: tuple[float, float] | None


def helper_client() -> tuple[int, int, int, int]:
    """The helper window's client area, at whatever size it currently is.

    `capture_hover.ball_window` only accepts ball-sized squares, so it cannot see the window while
    the panel is open — which is the one moment this script needs a second look at it. The helper is
    the only Electron process with a visible window here, so any such window is it.
    """
    from capture_hover import process_name

    found: list[tuple[int, int, int, int]] = []

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if process_name(pid.value) != "electron.exe":
            return True
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        if rect.right <= 0 or rect.bottom <= 0:
            return True
        origin = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(origin))
        found.append((origin.x, origin.y, rect.right, rect.bottom))
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(visit), 0)
    if not found:
        raise SystemExit("the helper's window is not on screen")
    return max(found, key=lambda r: r[2] * r[3])


def hover_start(ball_x: int, ball_y: int, side: int, stop: threading.Event, cycles: int) -> None:
    """Walk the pointer onto the ball and away, one hover per cycle, recording throughout."""
    target = (ball_x + side // 2, ball_y + side // 2)
    home = cursor()
    time.sleep(0.8)

    def hold(to: tuple[int, int], seconds: float) -> None:
        deadline = time.time() + seconds
        while time.time() < deadline:
            user32.SetCursorPos(*to)
            time.sleep(0.05)

    for _ in range(cycles):
        user32.SetCursorPos(*home)
        time.sleep(0.12)
        user32.SetCursorPos(*target)
        hold(target, 0.9)
        user32.SetCursorPos(*home)
        hold(home, 1.2)
    user32.SetCursorPos(*home)
    stop.set()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=10)
    parser.add_argument("--seconds", type=float, default=90.0)
    args = parser.parse_args()

    window = ball_window()
    collapsed = window.client
    print(f"helper window: client={collapsed} (physical)")

    # The whole window, which is also the whole area the ball could be drawn in: a stale sheet
    # would be laid out across all of it, and the ball's own square is inside. Plus a margin, so a
    # ball drawn *outside* the window is caught too — which is what the collapse used to do, putting
    # the ball past the window's own edge for a frame.
    left = collapsed[0] - SPACING
    top = collapsed[1] - SPACING
    right = collapsed[0] + collapsed[2] + SPACING
    bottom = collapsed[1] + collapsed[3] + SPACING
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    box = (max(0, left), max(0, top), min(width, right), min(height, bottom))
    print(f"watched region: {box[0]},{box[1]} .. {box[2]},{box[3]}"
          f"  ({box[2] - box[0]}x{box[3] - box[1]}, pitch {SPACING}px)")

    screen = Screen(box)

    # Where the ball actually is, read off the screen rather than computed from the layout. The
    # window is the overlay rect in both states, so the ball's offset inside it is the page's
    # decision, and looking is both simpler and more direct than asking.
    found = screen.find_magenta_box()
    if found is None:
        print("no magenta ball on screen: is the ORB-FLASH-DEBUG paint in the installed CSS?")
        return 1
    ball_x, ball_y, ball_right, ball_bottom = found
    side = max(ball_right - ball_x, ball_bottom - ball_y)
    print(f"ball found by paint: {ball_x},{ball_y} .. {ball_right},{ball_bottom}"
          f"  (about {side}x{side}, expect {round(BALL_CSS * collapsed[2] / PANEL_WINDOW_CSS[0])})")
    if abs(side - round(BALL_CSS * collapsed[2] / PANEL_WINDOW_CSS[0])) > 40:
        print("that is not the ball's size; something else on screen is magenta")
        return 1

    target = ((ball_x + ball_right) // 2, (ball_y + ball_bottom) // 2)
    home = cursor()
    user32.SetCursorPos(*target)
    time.sleep(1.2)
    expanded = helper_client()
    user32.SetCursorPos(*home)
    time.sleep(1.5)
    print(f"collapsed window: {collapsed[0]},{collapsed[1]} {collapsed[2]}x{collapsed[3]}")
    print(f"expanded window : {expanded[0]},{expanded[1]} {expanded[2]}x{expanded[3]}")
    if (collapsed[2], collapsed[3]) != (expanded[2], expanded[3]) or (collapsed[0], collapsed[1]) != (expanded[0], expanded[1]):
        # The whole arrangement is that the window is one rect in both states. If it moved or
        # resized, this is not the build under test and the frame data below would be measuring
        # something else.
        print("the window changed shape or position; this is not the build under test")
        return 1
    print("the window is one rect in both states, as intended")

    grid_x = list(range(0, box[2] - box[0] - PATCH, SPACING))
    grid_y = list(range(0, box[3] - box[1] - PATCH, SPACING))
    print(f"grid: {len(grid_x)} x {len(grid_y)} = {len(grid_x) * len(grid_y)} points")

    rest = (ball_x - box[0], ball_y - box[1], side)

    stop = threading.Event()
    rows: list[Row] = []

    def record() -> None:
        start = time.perf_counter()
        while not stop.is_set() and time.perf_counter() - start < args.seconds:
            total, centre = screen.sample(grid_x, grid_y)
            rows.append(Row(time.perf_counter() - start, total, centre))

    reader = threading.Thread(target=record, daemon=True)
    carer = threading.Thread(target=hover_start, args=(ball_x, ball_y, side, stop, args.cycles),
                             daemon=True)
    reader.start()
    carer.start()
    carer.join()
    stop.set()
    reader.join()
    user32.SetCursorPos(*home)

    if len(rows) < 10:
        print("next to nothing captured")
        return 1

    gaps = [b.t - a.t for a, b in zip(rows, rows[1:])]
    period = statistics.median(gaps)
    print(f"\nframes: {len(rows)}  median {period * 1000:.2f} ms ({1 / period:.0f} fps)"
          f"  slowest {max(gaps) * 1000:.1f} ms")

    seen = [row for row in rows if row.centre is not None]
    if not seen:
        print("the ball was never seen: the magenta paint is not in effect")
        return 1
    cx = statistics.median(row.centre[0] for row in seen)
    cy = statistics.median(row.centre[1] for row in seen)
    print(f"resting centroid in frame coordinates: {cx:.0f},{cy:.0f}"
          f"  (the ball's own square is {rest[0]}..{rest[0] + rest[2]}"
          f" x {rest[1]}..{rest[1] + rest[2]})")

    away, missing = [], []
    for row in rows:
        if row.centre is None:
            missing.append(row)
            continue
        distance = ((row.centre[0] - cx) ** 2 + (row.centre[1] - cy) ** 2) ** 0.5
        if distance > SPACING:
            away.append((row, distance))

    print(f"\nframes with no ball at all : {len(missing)} of {len(rows)}")
    for row in missing[:15]:
        print(f"    t={row.t * 1000:9.1f} ms")
    print(f"frames with the ball moved : {len(away)} of {len(rows)}")
    for row, distance in away[:25]:
        print(f"    t={row.t * 1000:9.1f} ms  centroid={row.centre[0]:.0f},{row.centre[1]:.0f}"
              f"  {distance:.0f}px from rest  magenta samples={row.total}"
              f"  (screen {box[0] + row.centre[0]:.0f},{box[1] + row.centre[1]:.0f})")

    if not away and not missing:
        print("\nevery presented frame had the ball on its resting square, to within the grid pitch.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
