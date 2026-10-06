# -*- coding: utf-8 -*-
"""Audit the loop flag of every GIF the named meme slots use.

`memes.json` names one file per slot, and whether that file restarts on its own decides how
the page has to schedule the hand-off. This prints both, side by side, for the slots whose
loop flag actually matters -- the one-shot reactions and transitions, plus the resident loops
as controls.

    python dsh_orb/loop_audit.py

The GIF spec leaves the ambiguity that cost three rounds of this: the counters in the
NETSCAPE2.0 application extension are (0 = loop forever, n = n more passes), and a file with
no extension at all plays once and stops. Pillow reports that raw number as `info["loop"]`,
so `loop == 0` does NOT mean "plays once".

Notes on the two things this reads:
  - the loop block is parsed from the bytes, not from Pillow, because the block can be absent
    and absence is a distinct answer from zero;
  - the duration is the sum of the frame delays, i.e. one pass, in the same 10 ms units
    `gifDurationMs` in `packages/helper/src/memes.ts` uses.
"""
import os
import struct
import sys

from PIL import Image

# Kept in step with the `dir` in ~/.dsh/dsh-orb/memes.json by hand: this is a diagnostic for
# one machine, not something the build runs.
PACK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "..", "大肥鱼表情包整合", "大肥鱼表情包整合")

# slot -> file, and whether the clip is meant to end by handing over (ONESHOT) or to keep
# going on its own (LOOP). A slot on the wrong side of this is the bug this script finds.
SLOTS = [
    ("drag.intro", "拎起.gif", "ONESHOT"),
    ("drop", "下落.gif", "ONESHOT"),
    ("click", "摸头 2.gif", "ONESHOT"),
    ("done", "摇铃.gif", "ONESHOT"),
    ("hover.intro", "打招呼 1.gif", "ONESHOT"),
    ("drag", "悬空.gif", "LOOP"),
    ("hover", "期待 2.gif", "LOOP"),
    ("idle", "PNGTuber 闲置.gif", "LOOP"),
    ("sleep.yawn", "打哈欠表情包2_透明.gif", "LOOP"),
]


def loop_count(body):
    """The 16-bit loop counter, or None when the file carries no loop extension at all."""
    for signature in (b"NETSCAPE2.0", b"ANIMEXTS1.0"):
        at = body.find(signature)
        # extension introducer(2) + name(11), then sub-block size(1) + id(1) + count(2)
        if at >= 3 and body[at - 3:at] == b"\x21\xff\x0b" and len(body) >= at + 15:
            return struct.unpack("<H", body[at + 13:at + 15])[0]
    return None


def describe(count):
    if count is None:
        return "no extension -> plays once and stops"
    if count == 0:
        return "count=0 -> loops forever"
    return f"count={count} -> plays {count + 1} passes"


def one_pass_ms(path):
    image = Image.open(path)
    total = 0
    for index in range(image.n_frames):
        image.seek(index)
        total += image.info.get("duration", 0)
    image.close()
    return total


def main():
    header = f"{'slot':<14}{'file':<28}{'wants':<10}{'found':<34}{'pass':>8}  verdict"
    print(header)
    print("-" * len(header))
    wrong = []
    for slot, name, wants in SLOTS:
        path = os.path.join(PACK, name)
        if not os.path.exists(path):
            print(f"{slot:<14}{name:<28}{wants:<10}{'<missing>':<34}")
            continue
        count = loop_count(open(path, "rb").read())
        plays_once = count is None
        ok = plays_once == (wants == "ONESHOT")
        if not ok:
            wrong.append((slot, name, wants, count))
        print(f"{slot:<14}{name:<28}{wants:<10}{describe(count):<34}"
              f"{one_pass_ms(path):>6}ms  {'ok' if ok else 'MISMATCH'}")

    print()
    if not wrong:
        print("every slot's loop flag matches what its hand-off assumes")
        return 0
    print("fix these:")
    for slot, name, wants, count in wrong:
        fix = "strip the loop extension (make_oneshot.py)" if wants == "ONESHOT" \
            else "add a forevers loop (not implemented -- hand-edit)"
        print(f"  - {name:<28} ({slot})  {describe(count)}  -> {fix}")
    print()
    print("before stripping one, check its last frame is a settle: python dsh_orb/loop_tail.py")
    return 1


if __name__ == "__main__":
    sys.exit(main())
