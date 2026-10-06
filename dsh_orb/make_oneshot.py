# -*- coding: utf-8 -*-
"""Strip the loop extension from the one-shot clips, so they stop on their last frame.

    python dsh_orb/make_oneshot.py            # report only
    python dsh_orb/make_oneshot.py --apply    # write, backing up first

Why this and not a re-encode: a frame in this pack is a palette image, and writing it back
out through Pillow re-quantises the palette and re-dithers the pixels. Deleting the extension
block instead leaves every other byte of the file where it was, so the frames come out
bit-identical -- which the script checks before it writes anything.

Why it fixes the flash: a decoder restarts a looping GIF the instant it reaches the last
frame, so a hand-off timer set to one pass is racing it. With no loop block the clip plays
once and holds, and the timer's landing spot stops mattering. It is the material half of the
fix; the code half is `loopsForever`/`oneShotHoldMs` in `packages/helper/assets/shell.js`.

**Not every one-shot clip belongs in this list.** A clip whose last frame is mid-swing (摸头 2,
摇铃) is a loop that should stay a loop -- freezing it looks stuck. Run `loop_tail.py` on a
candidate first; only clips that settle are safe.
"""
import os
import shutil
import sys
import time

from PIL import Image

PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "大肥鱼表情包整合", "大肥鱼表情包整合")

# Clips whose last frame is a settled pose, confirmed with loop_tail.py. 摸头 2 and 摇铃 are
# deliberately absent: they are still moving when they end, so they keep looping.
TARGETS = ["拎起.gif", "下落.gif", "叹号.gif", "打招呼 1.gif"]

# The extension introducer is 0x21 0xFF, then an 11-byte identifier.
SIGNATURES = [b"NETSCAPE2.0", b"ANIMEXTS1.0"]


def block_span(body, at):
    """`(start, end)` of the application-extension block whose identifier begins at `at`."""
    start = at - 3
    if body[start:at] != b"\x21\xff\x0b":
        return None
    at += 11                      # past the 11-byte identifier
    while at < len(body):         # walk the sub-block chain
        size = body[at]
        at += 1 + size
        if size == 0:
            return start, at
    return None


def spans(body):
    """Every loop-extension block in the file, with the counter it carries."""
    found = []
    for signature in SIGNATURES:
        at = body.find(signature)
        while at >= 0:
            span = block_span(body, at)
            if span is not None:
                found.append((span, body[span[0] + 13:span[0] + 15].hex()))
            at = body.find(signature, at + 1)
    return sorted(set(found))


def snapshot(path):
    """What a rewrite must not change: geometry, timing, and every frame's pixels."""
    image = Image.open(path)
    delays = []
    frames = []
    for index in range(image.n_frames):
        image.seek(index)
        delays.append(image.info.get("duration", 0))
        frames.append(image.convert("RGBA").tobytes())
    shape = (image.size, image.n_frames, tuple(delays), "loop" in image.info)
    image.close()
    return shape, frames


def main():
    apply = "--apply" in sys.argv
    stamp = time.strftime("%Y%m%d_%H%M%S")
    failures = 0

    for name in TARGETS:
        path = os.path.join(PACK, name)
        if not os.path.exists(path):
            print(f"{name}: <missing>")
            continue

        body = open(path, "rb").read()
        found = spans(body)
        if not found:
            print(f"{name}: no loop extension, nothing to do")
            continue

        before, before_frames = snapshot(path)
        trimmed = bytearray(body)
        for (start, end), _ in reversed(found):
            del trimmed[start:end]
        patched = bytes(trimmed)

        # Read the patched bytes back before trusting them: a block cut at the wrong offset
        # still looks like a valid GIF to a byte-level check and fails to decode.
        scratch = path + ".tmp-oneshot"
        open(scratch, "wb").write(patched)
        try:
            after, after_frames = snapshot(scratch)
        except Exception as exc:                      # noqa: BLE001 - any decode failure fails the file
            os.remove(scratch)
            print(f"{name}: patched file will not decode ({exc}) -- skipped")
            failures += 1
            continue
        os.remove(scratch)

        same_shape = before[:3] == after[:3]
        same_pixels = before_frames == after_frames
        loop_gone = before[3] is True and after[3] is False

        print(f"{name}")
        print(f"    loop blocks: {len(found)} ({[raw for _, raw in found]}), "
              f"removed {len(body) - len(patched)} bytes")
        print(f"    size/frames/delays unchanged: {same_shape}  ({before[0]} {before[1]}f)")
        print(f"    every frame pixel-identical:  {same_pixels}")
        print(f"    loop flag gone:               {loop_gone}")

        if not (same_shape and same_pixels and loop_gone):
            print("    -> a check failed, not writing")
            failures += 1
            continue
        if not apply:
            print("    -> dry run, not writing")
            continue

        backup = f"{path}.bak-loop-{stamp}"
        shutil.copy2(path, backup)
        open(path, "wb").write(patched)
        print(f"    written; backup {os.path.basename(backup)}")

    if not apply:
        print("\nreport only -- pass --apply to write (backs up first)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
