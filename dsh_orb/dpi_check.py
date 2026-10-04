import ctypes, ctypes.wintypes as wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
try:
    ctypes.WinDLL("shcore")
except OSError:
    pass

# Per-monitor DPI awareness of our own process
PROCESS_PER_MONITOR_DPI_AWARE = 2
user32.SetProcessDpiAwarenessContext.restype = wintypes.BOOL
user32.SetProcessDpiAwarenessContext.argtypes = [wintypes.HANDLE]
user32.SetProcessDpiAwarenessContext(-4)  # PER_MONITOR_V2

def dpi_for(flags):
    # GetDpiForSystem / GetDpiForWindow
    return None

user32.GetDpiForSystem.restype = wintypes.UINT
print("GetDpiForSystem (after PMv2):", user32.GetDpiForSystem())

# Find the dsh-orb window and query its DPI / window rect vs client rect
EnumWindowsProc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
found = {}

class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]

def cb(hwnd, lparam):
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    nbuf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, nbuf, 256)
    if nbuf.value == "dsh-orb":
        found["hwnd"] = hwnd
        return False
    return True

user32.EnumWindows(EnumWindowsProc(cb), 0)

if "hwnd" not in found:
    print("dsh-orb window not found")
    raise SystemExit(1)

hwnd = found["hwnd"]
user32.GetDpiForWindow.restype = wintypes.UINT
dpi = user32.GetDpiForWindow(hwnd)
scale = dpi / 96.0

wr = RECT(); user32.GetWindowRect(hwnd, ctypes.byref(wr))
cr = RECT(); user32.GetClientRect(hwnd, ctypes.byref(cr))

win_w = wr.right - wr.left
win_h = wr.bottom - wr.top
cli_w = cr.right - cr.left
cli_h = cr.bottom - cr.top

print(f"hwnd           {hwnd}")
print(f"window dpi     {dpi}   scale {scale:.4f}")
print(f"window rect    {win_w} x {win_h}")
print(f"client rect    {cli_w} x {cli_h}")
print()
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

# Taken from the shared constants rather than typed out, so this cannot go on quoting a window size
# the layout stopped using — which is exactly what the last one did, through two layout changes.
from capture_hover import PANEL_CSS, PANEL_WINDOW_CSS  # noqa: E402

print(f"expected CSS   {PANEL_WINDOW_CSS[0]} x {PANEL_WINDOW_CSS[1]}"
      f"   (panel {PANEL_CSS[0]}x{PANEL_CSS[1]})")
print(f"client / scale {cli_w/scale:.1f} x {cli_h/scale:.1f}"
      f"   <- should be ~{PANEL_WINDOW_CSS[0]}x{PANEL_WINDOW_CSS[1]}")
print(f"window / scale {win_w/scale:.1f} x {win_h/scale:.1f}")
