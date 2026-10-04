"""Find the floating ball's window on screen.

The ball is a frameless, transparent, always-on-top Electron window. There is no exported handle
for it, so it is found the only way a stranger can: by walking every top-level window and looking
for one that is square and ball-sized.

Two things about the real machine this used to get wrong, both measured rather than assumed:

* the window belongs to `electron.exe`, not to `DeepSeek Harness.exe` — the helper is its own
  Electron app, and the harness only spawns it;
* the client rect comes back in *physical* pixels, so on the 125% display this machine has, the
  312 DIP ball window is 390 px across. Matching `312` therefore matched nothing.

Everything here is read-only.
"""

import ctypes
import ctypes.wintypes as wintypes
import sys

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

# The ball window is `BALL_SIZE + 2 * CHROME_INSET` = 312 DIP, and the client rect is physical, so
# the accepted range spans every scale factor from 100% to 200%.
BALL_WINDOW_MIN, BALL_WINDOW_MAX = 300, 640
# The helper is its own Electron app; the harness only spawns it.
HELPER_PROCESS = "electron.exe"

EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def process_name(pid: int) -> str:
    """The executable name behind a pid, or an empty string when it cannot be read."""
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


def client_rect_on_screen(hwnd: int) -> tuple[int, int, int, int] | None:
    """The window's client area in screen coordinates, or None when it has no size."""
    rect = wintypes.RECT()
    if not user32.GetClientRect(hwnd, ctypes.byref(rect)):
        return None
    if rect.right <= 0 or rect.bottom <= 0:
        return None
    origin = wintypes.POINT(0, 0)
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        return None
    return (origin.x, origin.y, rect.right, rect.bottom)


def enumerate_windows() -> list[dict]:
    """Every visible top-level window that belongs to the ball's own helper process."""
    windows: list[dict] = []
    names: dict[int, str] = {}

    def visit(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in names:
            names[pid.value] = process_name(pid.value)
        if names[pid.value] != HELPER_PROCESS:
            return True
        rect = client_rect_on_screen(hwnd)
        if rect is None:
            return True
        klass = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, klass, 256)
        title = ctypes.create_unicode_buffer(256)
        user32.GetWindowTextW(hwnd, title, 256)
        windows.append({
            "hwnd": int(hwnd),
            "pid": pid.value,
            "color": "dwm",
            "class": klass.value,
            "title": title.value,
            "rect": rect,
        })
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    return windows


def find_ball() -> dict | None:
    """The smallest visible square window in the ball's own size range."""
    squares = [
        win for win in enumerate_windows()
        if abs(win["rect"][2] - win["rect"][3]) <= 8 and BALL_WINDOW_MIN <= win["rect"][2] <= BALL_WINDOW_MAX
    ]
    return min(squares, key=lambda win: win["rect"][2]) if squares else None


def cursor() -> tuple[int, int]:
    point = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(point))
    return (point.x, point.y)


def main() -> int:
    ball = find_ball()
    print(f"cursor: {cursor()}")
    if ball is None:
        print("ball window: NOT FOUND")
        print("candidates:")
        for win in enumerate_windows():
            print(f"  pid={win['pid']} rect={win['rect']} class={win['class']!r} title={win['title']!r}")
        return 1
    x, y, width, height = ball["rect"]
    inset = round(width * 12 / 312)
    side = width - 2 * inset
    print(f"ball window: hwnd={ball['hwnd']} pid={ball['pid']} client=({x},{y}) {width}x{height}")
    print(f"ball itself: ({x + inset},{y + inset}) {side}x{side}  centre=({x + inset + side // 2},{y + inset + side // 2})")
    print(f"class={ball['class']!r} title={ball['title']!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
