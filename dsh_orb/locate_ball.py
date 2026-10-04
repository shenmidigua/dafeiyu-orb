"""Locate the orb ball precisely by finding the animating region on screen."""
import ctypes, time, sys
import numpy as np
from PIL import ImageGrab

u = ctypes.windll.user32
u.SetProcessDPIAware()

def grab():
    return np.asarray(ImageGrab.grab().convert("RGB"), dtype=np.int16)

def moving_box(gap_ms=160, n=8, thresh=40):
    cu = u.GetCursorPos
    frames = []
    for i in range(n):
        frames.append(grab())
        time.sleep(gap_ms / 1000.0)
    acc = np.zeros(frames[0].shape[:2], dtype=bool)
    for i in range(len(frames) - 1):
        d = np.abs(frames[i] - frames[i + 1]).sum(axis=2)
        acc |= d > thresh
    ys, xs = np.nonzero(acc)
    if len(xs) == 0:
        return None
    # focus on the densest blob: use percentiles to reject stray noise
    x0, x1 = int(np.percentile(xs, 1)), int(np.percentile(xs, 99))
    y0, y1 = int(np.percentile(ys, 1)), int(np.percentile(ys, 99))
    return x0, y0, x1, y1, len(xs)

def park():
    u.SetCursorPos(200, 900)
    time.sleep(1.2)

if __name__ == "__main__":
    park()
    r = moving_box()
    if r is None:
        print("NO MOTION DETECTED")
        sys.exit(1)
    x0, y0, x1, y1, cnt = r
    print(f"moving bbox screen=({x0},{y0})-({x1},{y1}) size={x1-x0+1}x{y1-y0+1} pixels={cnt}")
    print(f"center=({(x0+x1)//2},{(y0+y1)//2})")
