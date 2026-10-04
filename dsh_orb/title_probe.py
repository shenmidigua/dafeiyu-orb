"""Print the title of every top-level window whose title matches a pattern.

Used while the helper's page publishes its own geometry into `document.title` — Electron mirrors
that to the window title, which is readable from Win32 with no DevTools and no cooperation from
the page beyond the title itself.

Usage: `title_probe.py [substring]`
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import sys

user32 = ctypes.WinDLL("user32", use_last_error=True)

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
GetWindowTextW = user32.GetWindowTextW
GetWindowTextLengthW = user32.GetWindowTextLengthW


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


def main() -> int:
    needle = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    rows: list[tuple[str, tuple[int, int, int, int], bool]] = []

    def cb(hwnd, lparam):
        n = GetWindowTextLengthW(hwnd)
        if n == 0:
            return True
        buf = ctypes.create_unicode_buffer(n + 2)
        GetWindowTextW(hwnd, buf, n + 2)
        title = buf.value
        if needle and needle not in title.lower():
            return True
        r = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(r))
        vis = bool(user32.IsWindowVisible(hwnd))
        rows.append((title, (r.left, r.top, r.right - r.left, r.bottom - r.top), vis))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)

    if not rows:
        print(f"(no window title contains {needle!r})")
        return 1
    for title, rect, vis in rows:
        print(f"vis={vis} rect={rect}")
        print(f"  {title}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
