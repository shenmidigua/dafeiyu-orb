"""Does the window keep one rect across both states?

The invariant being checked: the overlay window is the *same rectangle* whether the ball is
resting or the panel is open. If it is not, the canvas that holds the old state gets presented at
a new origin for one frame, and the ball appears to jump (and, in the collapsed direction, to be
clipped away) — the bug that `flash_spot.py` was built to catch.

This measures the window rect directly from Win32 at both states instead of watching frames: park
the pointer far away, sample, then move onto the ball, sample again. A difference is the whole
answer.

Usage: `two_state_rect.py`
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import (  # noqa: E402
    BALL_COLUMN_CSS,
    BALL_CSS,
    BALL_ROW_CSS,
    CHROME_CSS,
    PANEL_CSS,
    PANEL_GAP_CSS,
    PANEL_WINDOW_CSS,
    ball_window,
    cursor,
    user32,
)

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_ABSOLUTE = 0x8000


class RECT(ctypes.Structure):
    _fields_ = [("left", wintypes.LONG), ("top", wintypes.LONG),
                ("right", wintypes.LONG), ("bottom", wintypes.LONG)]


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    r = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(r))
    return (r.left, r.top, r.right - r.left, r.bottom - r.top)


def move_to(x: int, y: int) -> None:
    user32.SetCursorPos(int(x), int(y))


def main() -> int:
    window = ball_window()
    hwnd = window.hwnd

    sx, sy = user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    bx, by, bw, bh = window.client
    # The ball's own square, from where the layout puts it inside the window — not a fraction of
    # the window, which was a guess that only worked while the ball sat in a corner.
    ball_x, ball_y, side = window.ball
    ball_cx = ball_x + side / 2
    ball_cy = ball_y + side / 2
    print(f"window hwnd={hwnd}  screen {sx}x{sy}  direction {window.horizontal}/{window.vertical}")
    print(f"client {bx},{by} {bw}x{bh}")
    print(f"ball target ({ball_cx:.0f},{ball_cy:.0f})")

    # 1) park the pointer well away from the window, on the far left of the screen
    away = (30, sy - 60)
    move_to(*away)
    time.sleep(1.2)
    resting = window_rect(hwnd)
    print(f"\npointer parked at {away}")
    print(f"RESTING  rect x={resting[0]} y={resting[1]} w={resting[2]} h={resting[3]}")

    # 2) move onto the ball and let the panel open
    move_to(ball_cx, ball_cy)
    time.sleep(1.5)
    expanded = window_rect(hwnd)
    print(f"pointer on ball at ({ball_cx:.0f},{ball_cy:.0f})")
    print(f"EXPANDED rect x={expanded[0]} y={expanded[1]} w={expanded[2]} h={expanded[3]}")

    # 3) back away again, to confirm it returns
    move_to(*away)
    time.sleep(1.2)
    back = window_rect(hwnd)
    print(f"pointer parked again")
    print(f"RESTING2 rect x={back[0]} y={back[1]} w={back[2]} h={back[3]}")

    print()
    same_resting = resting == back
    same_states = resting == expanded
    print(f"resting == resting2 : {same_resting}")
    print(f"resting == expanded : {same_states}   <- the invariant")
    if not same_states:
        print("VIOLATED: the window changes rect between states.")
        print(f"  dx={expanded[0]-resting[0]} dy={expanded[1]-resting[1]} "
              f"dw={expanded[2]-resting[2]} dh={expanded[3]-resting[3]}")
    print(f"\nexpected design size {PANEL_WINDOW_CSS[0]}x{PANEL_WINDOW_CSS[1]}"
          f" (BALL {BALL_CSS} at {BALL_COLUMN_CSS},{BALL_ROW_CSS}; PANEL {PANEL_CSS[0]}x{PANEL_CSS[1]},"
          f" inset {CHROME_CSS}, gap {PANEL_GAP_CSS})")
    return 0 if same_states else 1


if __name__ == "__main__":
    sys.exit(main())
