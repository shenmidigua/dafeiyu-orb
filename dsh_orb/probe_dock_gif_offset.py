"""
Where does the fish actually sit inside the dock-strip clips?
 *
 * The ball is a circle and `#ball-gif` fills it edge to edge (width/height 100%, object-fit cover,
 * border-radius 50%), so a mirrored clip whose subject is off-centre in its 500x500 frame reads as
 * "the fish is too far right" — nothing to do with where the ball is on screen. That is a fact about
 * the pixels, and it decides the fix: shifting the *element* would open a gap at the right edge of the
 * circle (the image has no background of its own), whereas shifting the *frames* fixes it at the source
 * with no gap and no rebuild.
 *
 * So this measures it: the bounding box of the non-transparent pixels, frame by frame, and where that
 * box sits against the frame's own centre. A subject that is already centred reports ~0 and needs no
 * work at all — which is worth knowing before touching anything.
 *
 * Usage: probe_dock_gif_offset.py
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageSequence

PACK = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\大肥鱼表情包整合\大肥鱼表情包整合")

# The two mirrored clips the docked strip actually plays: the entrance and the loop it rests on.
CLIPS = ["冒泡 1登场水平翻转.gif", "登场水平翻转.gif"]


def content_box(frame: Image.Image) -> tuple[int, int, int, int] | None:
    """The bounding box of the pixels that are not see-through, or None for an empty frame."""
    rgba = frame.convert("RGBA")
    alpha = rgba.getchannel("A")
    box = alpha.getbbox()
    if box is not None and box != (0, 0, rgba.width, rgba.height):
        return box
    # No transparency at all: fall back to "differs from the top-left pixel", which is the background
    # for a flattened GIF.
    flat = rgba.convert("RGB")
    bg = flat.getpixel((0, 0))
    diff = Image.new("1", flat.size)
    diff.putdata([1 if px != bg else 0 for px in flat.getdata()])
    return diff.getbbox()


def describe(name: str) -> int:
    path = PACK / name
    if not path.exists():
        print(f"FAIL  {name} is not in the pack")
        return 1

    report = Image.open(path)
    width, height = report.size
    frames = []
    for frame in ImageSequence.Iterator(report):
        frames.append(content_box(frame.convert("RGBA")))

    usable = [(i, b) for i, b in enumerate(frames) if b is not None]
    if not usable:
        print(f"FAIL  {name}: every frame is empty")
        return 1

    print(f"\n{name}")
    print(f"  {width}x{height}, {len(frames)} frames, {report.info.get('duration')}ms")

    # How far the subject's box sits from dead centre, as a signed number on each axis. Positive on x
    # means the content's centre is to the right of the frame's centre.
    offsets_x, offsets_y = [], []
    rights, lefts, centres = [], [], []
    for _, (left, top, right, bottom) in usable:
        offsets_x.append((left + right) / 2 - width / 2)
        offsets_y.append((top + bottom) / 2 - height / 2)
        lefts.append(left)
        rights.append(right)
        centres.append((left + right) / 2)

    def span(values: list[float]) -> tuple[float, float]:
        return min(values), max(values)

    x0, x1 = span(offsets_x)
    y0, y1 = span(offsets_y)
    print(f"  subject centre vs frame centre:  x {x0:+.1f} .. {x1:+.1f}px"
          f"   y {y0:+.1f} .. {y1:+.1f}px")
    print(f"  widest box: x {min(lefts)} .. {max(rights)}  (frame is 0 .. {width})")
    print(f"  mean x offset: {sum(offsets_x) / len(offsets_x):+.1f}px")

    # The number that decides it: to centre the subject, the frame has to be shifted by exactly this.
    # Anything under a couple of pixels is not what anyone is looking at.
    mean_x = sum(offsets_x) / len(offsets_x)
    verdict = "already centred" if abs(mean_x) < 2 else f"shift the frames {-mean_x:+.1f}px"
    print(f"  -> {verdict}")

    # A shifted frame needs somewhere to come from, so report the slack at each edge: a frame whose
    # subject already touches an edge cannot slide that way without padding.
    slack_left = min(lefts)
    slack_right = width - max(rights)
    print(f"  slack: {slack_left}px at the left, {slack_right}px at the right")
    return 0


def main() -> int:
    print(f"pack: {PACK}")
    bad = sum(describe(name) for name in CLIPS)
    print("\nOK" if bad == 0 else f"\n{bad} PROBLEM(S)")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())