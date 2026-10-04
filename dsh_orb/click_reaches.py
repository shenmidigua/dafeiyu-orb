"""Does a click on the ball reach the page?

The hover check answers whether the panel opens. This answers the question underneath it: whether
the renderer is receiving mouse input at all while the window is click-through away from the ball.
That distinction matters because the two have different fixes — a panel that will not open is a
hover problem, but a page that receives no events even when the window is capturing is a
click-through problem, and the second makes the first impossible to diagnose from the outside.

The test is the page's own reaction to a click: `ball.addEventListener('pointerup')` plays a
one-shot click frame and pins the panel open, so a click that lands pins the panel. Pinning is
visible as the panel staying open after the pointer has left, which is unambiguous in a screenshot
and needs no cooperation from the page.

So: move onto the ball, wait for the window to capture, click, move away, and see whether the panel
is still there. If the click never arrived, the panel will not be there either — and the click
frame will not have played.

Usage: `click_reaches.py`
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import ball_window  # noqa: E402
from flash_spot import SRCCOPY, Screen  # noqa: E402

gdi32 = ctypes.windll.gdi32
user32 = ctypes.windll.user32

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004


def card_pixels(window) -> int:
    """How much of the window is the panel's opaque card.

    Counted, not located: the card is a large flat region and the ball is a circle, so a count
    separates "the panel is open" from "the ball is there" without needing to know which side the
    panel opened on.
    """
    x, y, width, height = window.client
    screen = Screen((x, y, x + width, y + height))
    gdi32.BitBlt(screen.memory_dc, 0, 0, screen.width, screen.height,
                 screen.screen_dc, screen.left, screen.top, SRCCOPY)
    stride = screen.width * 4
    count = 0
    for y2 in range(0, screen.height, 12):
        line = ctypes.string_at(screen.bits.value + y2 * stride, stride)
        for x2 in range(0, screen.width, 12):
            at = x2 * 4
            if line[at] > 200 and line[at + 1] > 200 and line[at + 2] > 200:
                count += 1
    return count


def main() -> int:
    window = ball_window()
    x, y, width, height = window.client
    ball = screen_ball(window)
    print(f"window: {window.client}")
    if ball is None:
        print("no magenta ball found: is the ORB-FLASH-DEBUG paint in the installed CSS?")
        return 1
    centre = ((ball[0] + ball[2]) // 2, (ball[1] + ball[3]) // 2)
    print(f"ball: {ball}  centre {centre}")

    away = (max(0, x - 500), max(0, y - 350))
    user32.SetCursorPos(*away)
    time.sleep(1.5)
    print(f"pointer away: card pixels {card_pixels(window)}")

    user32.SetCursorPos(*centre)
    time.sleep(1.5)
    print(f"pointer on ball: card pixels {card_pixels(window)}")

    # A real click: down, a beat, up. Sent through the input queue rather than SetCursorPos so it
    # is the same thing a hand produces.
    user32.mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0)
    time.sleep(0.08)
    user32.mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0)
    time.sleep(1.5)
    after_click = card_pixels(window)
    print(f"after a click on the ball: card pixels {after_click}")

    user32.SetCursorPos(*away)
    time.sleep(2.5)
    after_leave = card_pixels(window)
    print(f"pointer away again: card pixels {after_leave}")

    if after_leave > 200:
        print("\nRESULT: the click reached the page and pinned the panel open")
        print("        (so the renderer does get mouse input while the window is capturing)")
        return 0
    if after_click > 200:
        print("\nRESULT: the panel opened on the click but not on the hover")
        print("        the click landed, so events do arrive — the hover edge is what is wrong")
        return 1
    print("\nRESULT: nothing responded to the click")
    print("        the renderer is not receiving mouse input even while the window captures")
    return 1


def screen_ball(window) -> tuple[int, int, int, int] | None:
    x, y, width, height = window.client
    screen = Screen((x, y, x + width, y + height))
    return screen.find_magenta_box()


if __name__ == "__main__":
    sys.exit(main())
