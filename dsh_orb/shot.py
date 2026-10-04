"""Save a screenshot of the ball's window, for looking at rather than measuring.

Every numeric probe in this directory failed to tell a working build from a broken one at some
point — a dark theme read as "no panel", a pinned panel read as "hover does nothing", a stale
window handle read as "no window at all". A picture settles all of them at once, which is why this
exists rather than another threshold.

Usage: `shot.py [out.png]`
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from PIL import ImageGrab  # noqa: E402

from capture_hover import ball_window  # noqa: E402


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\digua\AppData\Local\Temp\orb-shot.png")
    window = ball_window()
    x, y, width, height = window.client
    margin = 40
    image = ImageGrab.grab(bbox=(x - margin, y - margin, x + width + margin, y + height + margin))
    image.save(out)
    print(f"window {window.client} -> {out} ({image.size[0]}x{image.size[1]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
