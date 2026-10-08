"""Screenshot one window by process id, for looking at rather than measuring.

`shot.py` finds the ball by its *expected size*, which stops working the moment another window on the
desktop happens to be that size — it picked a browser window instead of the ball, and the picture came
back framed around somebody else's tab. This asks the operating system which windows the helper process
owns, which is the question `shot.py` was approximating.

Usage: `shot_pid.py <process-id> [out.png]`
"""

from __future__ import annotations

import ctypes
import sys
from ctypes import wintypes
from pathlib import Path

from PIL import ImageGrab

user32 = ctypes.windll.user32
user32.SetProcessDPIAware()


def windows_of(pid: int) -> list[tuple[int, tuple[int, int, int, int]]]:
    """Every visible top-level window this process owns, as (handle, (x, y, w, h)) in screen pixels."""
    found: list[tuple[int, tuple[int, int, int, int]]] = []

    def visit(hwnd, _lparam):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid or not user32.IsWindowVisible(hwnd):
            return True
        rect = wintypes.RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
            return True
        width, height = rect.right - rect.left, rect.bottom - rect.top
        if width < 80 or height < 80:
            return True
        found.append((hwnd, (rect.left, rect.top, width, height)))
        return True

    user32.EnumWindows(ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)(visit), 0)
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pid = int(sys.argv[1])
    out = Path(sys.argv[2] if len(sys.argv) > 2 else r"C:\Users\digua\AppData\Local\Temp\orb-pid-shot.png")
    windows = windows_of(pid)
    for hwnd, rect in windows:
        print(f"  hwnd {hwnd} rect {rect}")
    if not windows:
        print(f"process {pid} owns no visible window of a usable size")
        return 1
    # The ball is the biggest window this process owns; the others are chrome-less helper surfaces.
    hwnd, (x, y, width, height) = max(windows, key=lambda item: item[1][2] * item[1][3])
    margin = 30
    image = ImageGrab.grab(bbox=(x - margin, y - margin, x + width + margin, y + height + margin))
    image.save(out)
    print(f"hwnd {hwnd} ({x}, {y}, {width}, {height}) -> {out} ({image.size[0]}x{image.size[1]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
