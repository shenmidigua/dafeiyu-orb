"""Confirm the panel really opens when the pointer arrives, and closes when it leaves.

The flash measurement can pass for the wrong reason: if the hover stopped opening the panel there
would be no frame in which the ball could be anywhere but its resting square, and the run would
report a clean pass with the feature simply broken. So this checks the assumption the flash test
rests on.

Detection is by *change*, not by colour. A first attempt looked for "an opaque card pixel" and
found the dark DSH window sitting behind the overlay, which is opaque too — the panel is white in
one theme and near-black in the other, and the desktop behind is neither reliably. What is
unambiguous is the difference: opening the panel repaints a large region, and nothing else does.

So the same region is sampled before and after, and a pixel counts as "changed" when it moved by
more than a threshold on any channel. The panel is reported open when a large contiguous share of
the region changed, which also says *where* it opened — the direction the page chose, read off the
screen rather than predicted.

Usage: `hover_works.py`
"""

from __future__ import annotations

import ctypes
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from capture_hover import ball_window, cursor, user32  # noqa: E402
from flash_spot import Screen  # noqa: E402

# A pixel counts as repainted past this. Small enough to catch an antialiased shadow edge, large
# enough that a cursor blink or a clock ticking in the region does not read as the panel.
CHANNEL_DELTA = 40


def snapshot(screen: Screen, step: int = 4) -> dict[tuple[int, int], tuple[int, ...]]:
    """Every `step`-th pixel of the region, as a plain dict of tuples.

    The whole region rather than a few probe points, because the panel's position depends on the
    corner the page picked, and reading that off the screen is the point.
    """
    gdi32 = ctypes.windll.gdi32
    from flash_spot import SRCCOPY

    if not gdi32.BitBlt(screen.memory_dc, 0, 0, screen.width, screen.height,
                        screen.screen_dc, screen.left, screen.top, SRCCOPY):
        raise SystemExit("BitBlt failed")
    stride = screen.width * 4
    base = screen.bits.value
    out: dict[tuple[int, int], tuple[int, ...]] = {}
    for y in range(0, screen.height, step):
        line = ctypes.string_at(base + y * stride, screen.width * 4)
        for x in range(0, screen.width, step):
            at = x * 4
            out[(x, y)] = (line[at], line[at + 1], line[at + 2])
    return out


def repainted_area(before: dict, after: dict, cell: int = 32,
                   dense: float = 0.7) -> tuple[int, int, int, int] | None:
    """The bounding box of the region that was *solidly* repainted, in region coordinates.

    Counting every changed pixel over the whole window does not work, and the reason is worth
    writing down because it looks like a passing test and is not. The window is the overlay rect in
    both states, so most of it is empty and transparent — the DSH conversation shows through it,
    and a conversation is streaming text. Those glyphs change constantly, which put a permanent
    floor of ~10% under "how much of the region differs", enough to swamp the 30% threshold and to
    read as a pass in the other direction too. A first run reported exactly this: 9.7% changed, all
    of it in a band where the reply was being written, none of it a panel.

    What separates the panel is not *that* pixels changed but *how densely*. Opening it repaints a
    420x520 card in one go, so a 32px cell inside the card is almost entirely new; text never fills
    a cell, only strokes across it. So the test is per-cell density, and the answer is the box of
    the dense cells — which also says where the panel opened, read off the screen rather than
    predicted from the direction the page chose.
    """
    tallies: dict[tuple[int, int], list[int]] = {}
    for (x, y), old in before.items():
        new = after.get((x, y))
        if new is None:
            continue
        moved = any(abs(a - b) > CHANNEL_DELTA for a, b in zip(old, new))
        entry = tallies.setdefault((x // cell, y // cell), [0, 0])
        entry[0] += 1
        entry[1] += 1 if moved else 0
    solid = [(cx, cy) for (cx, cy), (total, moved) in tallies.items() if moved >= total * dense]
    if not solid:
        return None
    xs = [c[0] for c in solid]
    ys = [c[1] for c in solid]
    return (min(xs) * cell, min(ys) * cell, (max(xs) + 1) * cell, (max(ys) + 1) * cell)


def main() -> int:
    window = ball_window()
    x, y, width, height = window.client
    print(f"window: {x},{y} {width}x{height}")

    # The window can hang past the screen's edge — the resting rect is deliberately not clamped
    # into the work area — so the sampled region is clamped to the screen. A DIB blit from beyond
    # it reads whatever is in the framebuffer there, which is not the window and not the desktop.
    margin = 20
    left = max(0, x - margin)
    top = max(0, y - margin)
    right = min(user32.GetSystemMetrics(0), x + width + margin)
    bottom = min(user32.GetSystemMetrics(1), y + height + margin)
    screen = Screen((left, top, right, bottom))
    print(f"sampling {left},{top} .. {right},{bottom}"
          + ("" if (x - margin, y - margin) == (left, top) else "  (clamped to the screen)"))
    # The ball is located by watching it move, not by being told where it is. Two earlier attempts
    # were worse: scanning for the flat magenta tied this to the flash run's debug paint, which is
    # only on the installed package during a measurement, and deriving the offset from the window
    # rect used to need the direction class — which the page no longer publishes, so it silently
    # fell back to a default and pointed at empty window. That offset is fixed now, so deriving it
    # would work again; measuring still beats deriving, because a point computed from the layout is
    # where the ball *should* be, and a page a frame behind is exactly the failure being hunted.
    # The GIF changes every frame in every state, so differencing two grabs finds it with nothing
    # assumed at all.
    ball = screen.find_moving_box()
    if ball is None:
        print("nothing in the region is animating: is the helper window showing the ball?")
        return 1
    bx0, by0, bx1, by1 = ball
    centre = ((bx0 + bx1) // 2, (by0 + by1) // 2)
    ball_right = centre[0] > x + width // 2
    print(f"ball at {bx0},{by0} .. {bx1},{by1} (about {bx1 - bx0}x{by1 - by0}), "
          f"centre {centre}, {'right' if ball_right else 'left'} half of the window")

    away = (max(0, x - 500), max(0, y - 350))

    def walk_to(target: tuple[int, int], steps: int = 6) -> None:
        """Move the pointer the way a hand does, in steps.

        `SetCursorPos` in one jump is not a weaker version of a real hover, it is a different
        event: the window is click-through until the poll notices the pointer is over the ball, and
        a jump produces no `mousemove` on the way, so the renderer can miss the crossing entirely.
        That was a real gap and the helper now announces the crossing itself — see `sendPointer` —
        so the jump is tested too, below, as its own case. The walk is still the honest first test,
        since it is what a mouse actually does.
        """
        start = cursor()
        for i in range(1, steps + 1):
            user32.SetCursorPos(round(start[0] + (target[0] - start[0]) * i / steps),
                                round(start[1] + (target[1] - start[1]) * i / steps))
            time.sleep(0.08)

    def resting_frame() -> dict:
        user32.SetCursorPos(*away)
        time.sleep(2.0)
        return snapshot(screen)

    def opened_since(rest: dict) -> tuple[int, int, int, int] | None:
        # Long enough for the panel's own open transition to finish. The card fades and scales over
        # `ANIMATION_MS` = 300ms, and a snapshot taken mid-fade catches a partly transparent card.
        time.sleep(2.0)
        return repainted_area(rest, snapshot(screen))

    for label, approach in (("walking onto it", walk_to), ("teleporting onto it", lambda t: user32.SetCursorPos(*t))):
        rest = resting_frame()
        approach(centre)
        box = opened_since(rest)
        print(f"\n{label}: ", end="")
        if box is None:
            print("FAIL: nothing opened on hover")
            user32.SetCursorPos(*away)
            return 1
        # Which side the panel went to is read off the window, not off the box's midpoint relative to
        # the ball: the box is quantised to 32px cells, so its middle is only good to that much, and
        # the panel sits against the far edge of the window it opens into. The window's own midline
        # is exact, and the panel never crosses it.
        # The panel opens *away* from the ball: ball in the right half means panel in the left half.
        # Both flags name the same fact from opposite ends — `ball_right` is "the ball is on the
        # right", `opened_left` is "the panel is on the left" — so a correct layout has them BOTH
        # true, and they are both false when the ball is on the left. They must agree, not differ.
        opened_left = (box[0] + box[2]) / 2 - left < width / 2
        print(f"the panel opened in the {opened_left and 'left' or 'right'} half of the window, "
              f"{box[2] - box[0]}x{box[3] - box[1]} of solid repaint")
        if opened_left != ball_right:
            print(f"FAIL: the ball is in the {ball_right and 'right' or 'left'} half but the panel "
                  f"opened in the {opened_left and 'left' or 'right'}, so it covers the ball")
            user32.SetCursorPos(*away)
            return 1

    user32.SetCursorPos(*away)
    time.sleep(2.5)
    still_open = repainted_area(resting_frame(), snapshot(screen))
    print(f"\nafter the pointer leaves: ", end="")
    if still_open is not None:
        print(f"FAIL: the panel is still open ({still_open[2] - still_open[0]}x"
              f"{still_open[3] - still_open[1]} of it)")
        return 1
    print("and closed again, back to the resting frame")
    return 0


if __name__ == "__main__":
    sys.exit(main())
