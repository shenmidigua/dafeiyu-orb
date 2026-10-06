# -*- coding: utf-8 -*-
"""Is a clip's last frame a settle, or is it mid-motion?

Freezing on a settle looks deliberate; freezing mid-swing looks broken. That is the only
question that decides whether a GIF may have its loop extension stripped (see loop_audit.py
and make_oneshot.py) -- and the answer is not visible in its file size or length, because a
loop that happens to be 480 ms long looks exactly like a cue that happens to be 480 ms long.

    python dsh_orb/loop_tail.py

Repeated between frames is the mean absolute RGB difference over the whole canvas, normalised
by the clip's own average so the number reads as a ratio:

  ratio < ~0.6   the clip is settling -> the last frame is a pose worth holding
  ratio > ~0.9   the clip is still swinging -> it is a loop, and freezing it will look stuck

The 拎起/下落/叹号/打招呼 measurements are 0.56/0.09/0.24/0.45 (settles), while 摸头 2 and
摇铃 come out at 1.58 and 0.93 (loops) -- those two keep their loop extension on purpose.

Also printed is the seam between the first and last frame, which says how visible a restart
would be. A large number is a clip that was never meant to loop continuously.
"""
import os
import sys

from PIL import Image, ImageChops

PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "大肥鱼表情包整合", "大肥鱼表情包整合")

CLIPS = ["拎起.gif", "下落.gif", "悬空.gif", "叹号.gif", "打招呼 1.gif", "摸头 2.gif", "摇铃.gif"]

SETTLE = 0.6
LOOPING = 0.9


def load(path):
    image = Image.open(path)
    frames = []
    for index in range(image.n_frames):
        image.seek(index)
        frames.append(image.convert("RGB"))
    image.close()
    return frames


def motion(a, b):
    """Mean absolute RGB difference between two frames, over the whole canvas."""
    diff = ImageChops.difference(a, b)
    width, height = diff.size
    return sum(sum(pixel) for pixel in diff.getdata()) / (width * height * 3)


def main():
    for name in CLIPS:
        path = os.path.join(PACK, name)
        if not os.path.exists(path):
            print(f"{name}: <missing>")
            continue
        frames = load(path)
        if len(frames) < 2:
            print(f"{name}: single frame, nothing to measure")
            continue
        steps = [motion(frames[i - 1], frames[i]) for i in range(1, len(frames))]
        average = sum(steps) / len(steps)
        ratio = steps[-1] / average if average else 0.0
        if ratio < SETTLE:
            verdict = "settles -- safe to hold on the last frame"
        elif ratio > LOOPING:
            verdict = "still moving -- it is a loop, keep it looping"
        else:
            verdict = "borderline -- watch it before stripping the loop"
        print(f"{name}")
        print(f"    {len(frames)} frames, mean step {average:6.2f}, last step {steps[-1]:6.2f} "
              f"= {ratio:4.2f}x average")
        print(f"    last 4 steps: {[round(s, 1) for s in steps[-4:]]}")
        print(f"    first vs last frame: {motion(frames[0], frames[-1]):6.2f} "
              "(a large number means it was never meant to loop)")
        print(f"    -> {verdict}")
        print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
