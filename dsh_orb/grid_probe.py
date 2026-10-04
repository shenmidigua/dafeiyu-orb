"""Grid-probe the orb window to find where hovering opens the panel.

Definitive interactivity test: if shell.js is dead, no hover point opens the panel.
"""
import ctypes, time
import numpy as np
from PIL import ImageGrab

u = ctypes.windll.user32
u.SetProcessDPIAware()

# orb window, DPI-aware / physical coords
WX, WY, WW, WH = 1540, 64, 928, 680
PAD = 40
BOX = (WX - PAD, WY - PAD, WX + WW + PAD, WY + WH + PAD)


def grab():
    return np.asarray(ImageGrab.grab(bbox=BOX).convert("RGB"), dtype=np.int16)


def park():
    u.SetCursorPos(80, 1000)
    time.sleep(1.0)


if __name__ == "__main__":
    park()
    base = grab()

    xs = [WX + int(WW * f) for f in (0.10, 0.30, 0.50, 0.70, 0.88)]
    ys = [WY + int(WH * f) for f in (0.10, 0.30, 0.50, 0.70, 0.88)]

    hits = []
    for y in ys:
        row = []
        for x in xs:
            u.SetCursorPos(x, y)
            time.sleep(0.85)
            cur = grab()
            d = np.abs(cur - base).sum(axis=2)
            changed = int((d > 45).sum())
            row.append(changed)
            if changed > 6000:
                hits.append((x, y, changed))
        print("y=%4d  " % y + "  ".join("%7d" % v for v in row))

    park()
    print()
    print("panel-opening points:", hits)
    print("xs =", xs)
    print("ys =", ys)
