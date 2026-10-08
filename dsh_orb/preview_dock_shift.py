"""
Where does the fish sit inside the ball, and what nudge puts it in the middle?

The thing people call "the ball" is not drawn: `#ball` is `background: transparent` with no border and
no ring, so the round shape is only ever the fish's own alpha. That settles the question this preview
exists to answer — moving the picture left cannot "tear a gap out of the circle", because there is no
circle to tear. A transparent edge is simply invisible.

So the only thing left to decide is *how far*, and that is a measurement rather than a taste: the
fish's bounding box is compared against the ball's own centre, per frame, for each of the two clips the
docked strip plays. Whatever the CSS ends up using is one number, so the sheet shows candidates rather
than one answer.

`html, body { overflow: hidden }` does clip — at the *window* edge, which is how a ball docked past
the display edge loses its outer half. A fish nudged left is nowhere near that, so nothing here can be
cut; the sheet renders past the ball's own box to show there is nothing to cut.

Writes preview_dock_shift.png next to this script.

Usage: preview_dock_shift.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageSequence, ImageStat

HERE = Path(__file__).resolve().parent
PACK = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\大肥鱼表情包整合\大肥鱼表情包整合")

# The two mirrored clips the docked strip plays: the entrance, and the loop it rests on.
CLIPS = ["冒泡 1登场水平翻转.gif", "登场水平翻转.gif"]

BALL = 288          # --ball
SCALE = BALL / 500  # a 500px frame drawn into a 288px ball
CANDIDATES = [(0, 1.0, True), (-44, 1.0, True), (-44, 0.8, True), (-44, 0.8, False)]  # (px left, scale, rounded)


def opaque(image: Image.Image) -> int:
    return int(ImageStat.Stat(image.getchannel("A")).sum[0])


def apply(picture: Image.Image, offset_x: int, scale: float) -> Image.Image:
    """What the browser paints for `transform: translateX(Npx) scale(s)`.

    The order in the CSS is the whole point and is reproduced rather than assumed: a transform list is
    a chain of coordinate systems applied left to right, so the scale happens *inside* the ball's own
    unscaled units and the translate that follows is not scaled by it. Scaling last would shrink the
    shift along with the picture, and every number tuned for the offset would need measuring again.

    `scale` is about the centre, so the picture is resized about (BALL/2, BALL/2) and then translated.
    """
    side = BALL * scale
    smaller = picture.resize((max(1, round(side)), max(1, round(side))), Image.LANCZOS)
    canvas = Image.new("RGBA", (BALL, BALL), (0, 0, 0, 0))
    at = round((BALL - side) / 2 + offset_x)
    canvas.paste(smaller, (at, round((BALL - side) / 2)), smaller)
    return canvas


def pick_frame(clip: str, limit: int = 12) -> Image.Image:
    """The frame with the most subject in it.

    The fish is drawn in near-black on these clips, so a frame chosen by index is a coin toss between
    "a fish" and "an empty frame", and an empty frame would answer the question with a shrug.
    """
    report = Image.open(PACK / clip)
    best: Image.Image | None = None
    count = 0
    for frame in ImageSequence.Iterator(report):
        scaled = frame.convert("RGBA").resize((BALL, BALL), Image.LANCZOS)
        if best is None or opaque(scaled) > opaque(best):
            best = scaled
        count += 1
        if count >= limit:
            break
    assert best is not None
    return best


def cropped_to_circle(image: Image.Image) -> Image.Image:
    """`border-radius: 50%` on the element, in its own untransformed box.

    This is one of the two things being compared, so it is drawn rather than argued about. The other is
    leaving the crop off, and which reads better is not something to settle from the source: the dark
    slab is *in* the file, and what a square slab looks like next to a rounded one — including whether
    the rounded one is cutting into the fish — is worth looking at before installing either.
    """
    mask = Image.new("L", (BALL, BALL), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, BALL - 1, BALL - 1), fill=255)
    out = image.copy()
    out.putalpha(Image.composite(out.getchannel("A"), Image.new("L", (BALL, BALL), 0), mask))
    return out


def offset_of(image: Image.Image) -> float | None:
    """How far the subject's centre sits right of the ball's centre, in screen px."""
    bbox = image.getchannel("A").getbbox()
    if bbox is None:
        return None
    return (bbox[0] + bbox[2]) / 2 - BALL / 2


def contact_sheet(cells: list[tuple[str, Image.Image]], path: Path) -> None:
    """A row of balls on the dark theme's own background, with the number each was nudged."""
    pad = 10
    gap = 18
    width = len(cells) * BALL + (len(cells) - 1) * gap
    sheet = Image.new("RGBA", (width, BALL + 30), (21, 21, 23, 255))
    draw = ImageDraw.Draw(sheet)
    for index, (label, image) in enumerate(cells):
        x = index * (BALL + gap)
        # A faint box at the ball's own bounds, so a shift that leaves them is visible as such. This is
        # a measuring aid drawn only in the preview.
        draw.rectangle((x, 0, x + BALL - 1, BALL - 1), outline=(70, 70, 78, 255))
        sheet.alpha_composite(image, (x, 0))
        draw.text((x + 2, BALL + 8), label, fill=(151, 157, 166, 255))
    sheet.save(path)
    print(f"\nwrote {path.name}  ({len(cells)} variants, left to right)")


def main() -> None:
    print(f"ball {BALL}px, a 500px frame scaled to fit  ({SCALE:.3f})")

    cells: list[tuple[str, Image.Image]] = []
    for clip in CLIPS:
        plain = pick_frame(clip)
        print(f"\n{clip}")
        # The per-clip answer: the nudge that centres this one, at full size.
        raw = offset_of(apply(plain, 0, 1.0))
        print(f"  fish centre sits {raw:+.0f}px right of the ball's centre at full size")
        if clip != CLIPS[0]:
            continue
        for nudge, scale, rounded in CANDIDATES:
            image = apply(plain, nudge, scale)
            shown = cropped_to_circle(image) if rounded else image
            left = offset_of(image)
            box = image.getchannel("A").getbbox()
            shape = "rounded" if rounded else "square"
            print(f"  translateX({nudge:+d}px) scale({scale}) {shape} -> fish {left:+.0f}px from centre, "
                  f"drawn {box[2] - box[0]}px wide inside the {BALL}px ball")
            cells.append((f"{nudge:+d}px {int(scale * 100)}% {shape}", shown))

    contact_sheet(cells, HERE / "preview_dock_shift.png")


if __name__ == "__main__":
    main()