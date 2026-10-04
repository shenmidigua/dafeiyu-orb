"""List every top-level window with its owner, size and title.

Written because the measurement kept finding a window that was not the ball's: a 932x684
`electron.exe` window titled with the host's own title, whose title never changed when the ball
page was told to write to it. A measurement aimed at the wrong window reports confident nonsense,
so the windows are listed before anything is concluded from one of them.

Usage: `list_windows.py`
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import process_name  # noqa: E402

user32 = ctypes.windll.user32
PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def main() -> int:
    rows: list[tuple] = []

    def visit(hwnd, _lparam):
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        owner = process_name(pid.value)
        if not owner:
            return True
        rect = wintypes.RECT()
        user32.GetClientRect(hwnd, ctypes.byref(rect))
        origin = wintypes.POINT(0, 0)
        user32.ClientToScreen(hwnd, ctypes.byref(origin))
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        rows.append((
            int(hwnd), pid.value, owner,
            rect.right, rect.bottom, origin.x, origin.y,
            bool(user32.IsWindowVisible(hwnd)),
            buf.value,
        ))
        return True

    user32.EnumWindows(PROC(visit), 0)
    # Biggest first: the interesting windows are the large visible ones, and a helper that is
    # looking for one specific window is better served by seeing all of them.
    for hwnd, pid, owner, w, h, x, y, visible, title in sorted(rows, key=lambda r: -r[3] * r[4]):
        if w == 0 and h == 0:
            continue
        print(f"hwnd={hwnd:<10} pid={pid:<7} {owner:<16} {w:>5}x{h:<5} at {x:>5},{y:<5} "
              f"visible={str(visible):<5} title={title!r}")
    print(f"\n{len(rows)} windows with an owner, "
          f"{sum(1 for r in rows if r[7])} visible")
    return 0


if __name__ == "__main__":
    sys.exit(main())
