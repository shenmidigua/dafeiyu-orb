"""
What is the square, then? Is the fish on transparency, or on a background of its own?

`#ball-gif` has `border-radius: 50%`, which crops the picture to a circle — so anything the picture
carries outside that circle is *cut*, and a reported "ring cutting into the fish" is that crop showing
itself. Whether the fix is to drop the crop or to fix the pixels depends on an earlier question: is the
area beside the fish transparent, or is it a colour?

That is what decides it. If it is transparent, the circle is eating the fish's own corners and dropping
the crop is the whole fix. If it is an opaque background, dropping the crop would just trade a
cropped square for a full one, and the pixels have to change instead.

So: the alpha channel and the corners of a few frames, per clip.

Usage: probe_dock_gif_alpha.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageSequence

PACK = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\大肥鱼表情包整合\大肥鱼表情包整合")
CLIPS = ["冒泡 1登场水平翻转.gif", "登场水平翻转.gif"]

# The four corners and the middle of the ball, in ball-relative terms. The corners are what a circle
# cuts, and the middle is what a fish should always cover.
SPOTS = {"top-left": (0.02, 0.02), "top-right": (0.98, 0.02),
         "bottom-left": (0.02, 0.98), "bottom-right": (0.98, 0.98),
         "middle": (0.5, 0.5)}


def main() -> None:
    print(f"pack: {PACK}\n")
    for clip in CLIPS:
        report = Image.open(PACK / clip)
        print(f"{clip}")
        print(f"  mode={report.mode}, transparency={'yes' if 'transparency' in report.info else 'no'},"
              f" {report.size}, {report.n_frames} frames")

        # The palette's transparent index, if there is one. This is the number that says whether the
        # corners are meant to be invisible or merely happen to be dark.
        if report.mode == "P":
            palette = report.getpalette() or []
            index = report.info.get("transparency")
            if index is not None and index * 3 + 2 < len(palette):
                rgb = tuple(palette[index * 3:index * 3 + 3])
                print(f"  transparent palette index {index} = rgb{rgb}")

        frame_count = 0
        for frame in ImageSequence.Iterator(report):
            rgba = frame.convert("RGBA")
            row = []
            for name, (fx, fy) in SPOTS.items():
                x = min(rgba.width - 1, int(fx * rgba.width))
                y = min(rgba.height - 1, int(fy * rgba.height))
                r, g, b, a = rgba.getpixel((x, y))
                row.append(f"{name} rgba({r},{g},{b},{a})")
            if frame_count < 2:
                print("   " + "\n   ".join(row))
            frame_count += 1
            if frame_count >= 2:
                break

        # How much of the frame is invisible at all. Zero means an opaque picture and no crop is right.
        first = Image.open(PACK / clip).convert("RGBA")
        alpha = first.getchannel("A")
        extremes = alpha.getextrema()
        total = alpha.size[0] * alpha.size[1]
        clear = sum(1 for value in alpha.getdata() if value == 0)
        print(f"  alpha range {extremes}, fully transparent pixels: {clear}/{total} ({clear / total:.0%})")
        print()


if __name__ == "__main__":
    main()