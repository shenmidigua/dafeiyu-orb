"""Break one thing about the prefix negatives, so that `wake_prefix_check.py` can be seen to fail.

The check passes on correct code, and a check that has never failed is a comment. Four faults, one per
property the set has to have:

    1  the offset is zeroed, so the "prefix" window is the clip's first positive window again — the
       same audio labelled yes and no, which is the mislabelling that would look like a fix
    2  only the first warm-up variant contributes, so the band is a third of its size and each offset
       is seen behind one preceding conversation instead of two
    3  every window before the phrase end is taken, which is the mass change that took the false
       alarms from 0.0 to 34.8 per hour the last time this defect was attacked
    4  the prefix names file is written one clip short, so the two files stop being parallel arrays
       and the fold table can no longer be copied across them

Usage:  python fault_prefix.py <1|2|3|4|restore>

Line endings are matched on a normalised copy as well as literally, because a plain `str.replace` on a
`\\n` needle silently finds nothing in a CRLF file — which looks exactly like "the fault was never
applied" and quietly invalidates the whole check.
"""

import os
import pathlib
import shutil
import sys

DATASET = pathlib.Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\dsh_orb\wake_dataset.py")
BACKUP = pathlib.Path(os.environ.get("TEMP", r"C:\Windows\Temp")) / "wake_dataset.good.py"

TAIL = """        out_path.with_name("prefix-names.json").write_text(
            json.dumps(names, ensure_ascii=False), encoding="utf-8")"""

PICK = "                    pick = before - offset"
APPEND = "                    prefixes.append(every[pick:pick + 1])"
VARIANT_LOOP = "                for step in range(PREFIX_WINDOWS_PER_VARIANT):"

FAULTS = {
    1: (PICK, "                    pick = before - offset * 0"),
    2: (VARIANT_LOOP,
        "                for step in range(PREFIX_WINDOWS_PER_VARIANT if variant == 0 else 0):"),
    3: (APPEND, "                    prefixes.append(every[:pick + 1])"),
    4: (TAIL, TAIL.replace("json.dumps(names,", "json.dumps(names[1:],")),
}


def read() -> str:
    return DATASET.read_bytes().decode("utf8")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "restore"}:
        print(__doc__)
        return 2

    # The good copy is taken once, and only if it is not already there. Re-copying it on every call
    # makes a loop of inject/restore walk the source towards the last fault injected, and the final
    # "restore" restores that instead of the good version. The driver deletes this file before it
    # starts, because a backup that outlives an edit to the source silently reverts the edit.
    if not BACKUP.exists():
        shutil.copyfile(DATASET, BACKUP)
        print(f"backed up the good copy to {BACKUP}")
    else:
        print(f"using the existing good copy at {BACKUP}")

    if sys.argv[1] == "restore":
        shutil.copyfile(BACKUP, DATASET)
        print("restored")
        return 0

    needle, replacement = FAULTS[int(sys.argv[1])]
    source = read()
    crlf = "\r\n" in source
    text = source.replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    if text == source:
        text = source.replace(needle, replacement)
    if text == source:
        print(f"FAULT {sys.argv[1]} NOT APPLIED - the needle is not in the file")
        return 1
    DATASET.write_bytes(text.encode("utf8"))
    print(f"fault {sys.argv[1]} applied (crlf={crlf})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
