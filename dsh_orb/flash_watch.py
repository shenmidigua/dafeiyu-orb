"""Drive the pointer onto the floating ball and read back what the page saw, frame by frame.

The page-side probe (`flash_probe.js`, appended to the installed `shell.js`) turns every
displaced frame into a count, and publishes the worst one through `document.title`. That makes
`GetWindowTextW` the read-out: no IPC to add, no build to cut, and it is sampled at whatever rate
the window title actually changes rather than at the 25fps a screen grab can manage.

Usage: `flash_watch.py [--cycles 6] [--seconds 45]`
"""

from __future__ import annotations

import argparse
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import ball_window, cursor, user32  # noqa: E402

TITLE_MAX = 512


def title_of(hwnd: int) -> str:
    buf = __import__("ctypes").create_unicode_buffer(TITLE_MAX)
    user32.GetWindowTextW(hwnd, buf, TITLE_MAX)
    return buf.value


def drive(target: tuple[int, int], home: tuple[int, int], stop: threading.Event, cycles: int) -> None:
    """Arrive on the ball both ways: a single jump (the fastest possible) and a short glide."""
    def glide(to: tuple[int, int], steps: int) -> None:
        from_x, from_y = cursor()
        for step in range(1, steps + 1):
            user32.SetCursorPos(
                round(from_x + (to[0] - from_x) * step / steps),
                round(from_y + (to[1] - from_y) * step / steps),
            )
            time.sleep(0.012)

    def hold(to: tuple[int, int], seconds: float) -> None:
        """Pin the cursor where the cycle wants it.

        The hand that owns this mouse is a person's, and a stray nudge mid-cycle would silently
        turn a hover into a miss and make the whole run say nothing. Re-asserting costs nothing
        and makes the answer independent of whatever else the desk is doing.
        """
        deadline = time.time() + seconds
        while time.time() < deadline:
            user32.SetCursorPos(*to)
            time.sleep(0.05)

    time.sleep(3.0)                      # let the probe collect its resting baseline
    for cycle in range(cycles):
        if cycle % 2 == 0:
            user32.SetCursorPos(*home)
            time.sleep(0.15)
            user32.SetCursorPos(*target)  # one jump: no intermediate pointermove at all
        else:
            glide(target, 8)
        hold(target, 0.85)                # the panel opens and stays open
        if cycle % 2 == 0:
            user32.SetCursorPos(*home)
        else:
            glide(home, 8)
        hold(home, 1.25)                  # the panel collapses again
    time.sleep(0.6)
    stop.set()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cycles", type=int, default=6)
    parser.add_argument("--seconds", type=float, default=45.0)
    args = parser.parse_args()

    window = ball_window()
    ball_x, ball_y, side = window.ball
    target = (ball_x + side // 2, ball_y + side // 2)
    print(f"ball window: hwnd=0x{window.hwnd:x} client={window.client} pid={window.pid}")
    print(f"ball: {ball_x},{ball_y} {side}x{side}   centre={target}")
    print(f"title before: {title_of(window.hwnd)!r}")

    home = cursor()
    print(f"cursor home: {home}")

    stop = threading.Event()
    carer = threading.Thread(target=drive, args=(target, home, stop, args.cycles), daemon=True)
    carer.start()

    seen: dict[str, int] = {}
    order: list[str] = []
    deadline = time.time() + args.seconds
    while not stop.is_set() and time.time() < deadline:
        text = title_of(window.hwnd)
        if text not in seen:
            seen[text] = 0
            order.append(text)
            print(f"  [{time.strftime('%H:%M:%S')}] {text}")
        seen[text] += 1
        time.sleep(0.03)
    carer.join()
    user32.SetCursorPos(*home)

    print("\n--- distinct titles seen ---")
    for text in order:
        print(f"{seen[text]:6d}x  {text}")

    verdict = [t for t in order if t.startswith("ORB-")]
    if not verdict:
        print("\nthe probe never wrote a title: the channel is dead, or shell.js did not reload")
        return 1
    final = verdict[-1]
    print()
    if final.startswith("ORB-OK"):
        print("VDOM CLEAN — the ball never left its resting screen position while the pointer arrived.")
        print("          The flash the eye sees is therefore below the DOM: presentation, not layout.")
    else:
        print("VDOM DISPLACED — the page itself put the ball somewhere else. See the offsets above.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
