"""Add or update the `arrive` slot in the live `memes.json`, keeping the file's own format.

The file is hand-edited and the helper re-reads it on a ten-second cadence, so the edit has to be
a minimal, byte-faithful one: the previous contents are backed up first, and the rewritten file is
proved to be the same document plus (or minus, with `--off`) the one slot. A round-trip that
reformatted the whole file would silently rewrite every other slot's indentation and be blamed on
whichever slot was edited last.

Usage:
    python set_arrive_slot.py                        # 到达.gif then 打招呼 1.gif
    python set_arrive_slot.py "到达.gif"              # any names, in the order they should play
    python set_arrive_slot.py "到达 水平翻转.gif"      # the mirrored copy, on its own
    python set_arrive_slot.py --off                  # write the slot out (`enabled: false`)
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time

CONFIG = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-orb", "memes.json")
PACK = os.path.join(os.path.expanduser("~"), "Desktop", "dsh-orb-cordis", "大肥鱼表情包整合")
# The greeting as it is meant to play: turn up, then wave. Every entry is one pass of its own
# animation, in this order, so a single name here is a one-clip greeting and two are a sequence.
DEFAULT_FILES = ["到达.gif", "打招呼 1.gif"]


def nearest_image(name: str) -> str | None:
    """The first file under the pack whose basename is `name` — the resolver's own rule."""
    for base, directories, files in os.walk(PACK):
        directories[:] = [d for d in directories if not d.startswith(".")]
        if name in files:
            return os.path.join(base, name)
    return None


def main() -> int:
    argv = sys.argv[1:]
    off = "--off" in argv
    names = [a for a in argv if not a.startswith("--")]
    files = names if names else list(DEFAULT_FILES)

    with open(CONFIG, encoding="utf8", newline="") as handle:
        raw = handle.read()
    body = raw[1:] if raw.startswith("\ufeff") else raw
    before = json.loads(body)
    document = dict(before)

    # The live file is CRLF and has no trailing newline, so the comparison is made on the shape
    # rather than the bytes: a formatter that cannot reproduce the document as written would
    # rewrite every other slot's whitespace, and the blame would land on whichever slot was
    # edited last. The line ending and the missing final newline are put back verbatim below.
    ending = "\r\n" if "\r\n" in raw else "\n"
    tail = ending if body.endswith("\n") else ""
    def render(value: dict) -> str:
        text = json.dumps(value, indent=2, ensure_ascii=False)
        return (text + tail).replace("\n", ending)

    if render(document) != body:
        print("REFUSING: this memes.json does not round-trip through json.dumps(indent=2).")
        print("Edit it by hand, or fix the formatter, rather than letting this script rewrite it.")
        return 1

    slot = {"enabled": False, "files": files} if off else {"enabled": True, "files": files}
    if document.get("arrive") == slot:
        print(f"already set: arrive -> {slot}")
        return 0

    previous = document.get("arrive")
    document["arrive"] = slot

    if not off:
        for name in files:
            hit = nearest_image(os.path.basename(name))
            if hit is None:
                print(f"WARNING: {name} is not anywhere under {PACK}")
                print("         that clip is skipped; the rest of the greeting still plays.")
            else:
                print(f"resolves to {os.path.relpath(hit, PACK)} "
                      f"({os.path.getsize(hit):,} bytes)")

    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup = f"{CONFIG}.bak-arrive-{stamp}"
    shutil.copy2(CONFIG, backup)
    with open(CONFIG, "w", encoding="utf8", newline="") as handle:
        handle.write(render(document))
    print(f"backed up to {os.path.basename(backup)}")
    print(f"arrive: {json.dumps(previous, ensure_ascii=False)} -> {json.dumps(slot, ensure_ascii=False)}")

    with open(CONFIG, encoding="utf8") as handle:
        check = json.load(handle)
    assert check["arrive"] == slot and check.keys() == document.keys()
    untouched = [key for key in check if key != "arrive" and check[key] != before.get(key)]
    if untouched:
        print(f"REFUSING: the rewrite changed {untouched}; the backup is at {os.path.basename(backup)}")
        return 1
    print("re-read: the slot is in place and every other key survived byte for byte")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
