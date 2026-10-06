"""Break one thing in the fetch face, run the tests, put it back.

The point is the second half. A test that passes on correct code proves nothing unless it has been
seen to fail on broken code, and these are exactly the three ways this feature can be subtly wrong
while still looking right in a screenshot.

Usage:  python fault_webfetch.py <1|2|3|restore>

    1  the two tool faces share one `dataset.mode`, so a fetch → bash swap repaints nothing
    2  `syncAgent`'s early return ignores the running tool, so the face works once per turn
    3  the frame is never released, so an edited `memes.json` never applies again

Line endings are read as bytes and matched on a normalised copy, because this file is CRLF and a
plain `str.replace` on a `\\n` needle silently finds nothing — which looks exactly like "the fault
was never applied" and quietly invalidates the whole check.
"""

import os
import shutil
import sys

SHELL = r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\shell.js"
BACKUP = r"C:\Users\digua\AppData\Local\Temp\shell.webfetch.good.js"

FAULTS = {
    1: ("      const mode = web ? 'webfetch' : 'tool'\n", "      const mode = 'tool'\n"),
    2: ("if (next.state === agentState && next.tool === agentTool) return",
        "if (next.state === agentState) return"),
    3: ("      webfetchSrc = undefined\n", ""),
}


def read() -> str:
    with open(SHELL, "rb") as handle:
        return handle.read().decode("utf8")


def write(text: str) -> None:
    with open(SHELL, "wb") as handle:
        handle.write(text.encode("utf8"))


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "restore"}:
        print(__doc__)
        return 2

    # The good copy is taken once, and only if it is not already there. Re-copying it on every call
    # is the bug this script was written after doing once already: a `restore` that snapshots
    # first saves whatever fault is currently in the file, so a loop of inject/restore walks the
    # source steadily towards the last fault injected and the final "restore" restores that.
    if not os.path.exists(BACKUP):
        shutil.copyfile(SHELL, BACKUP)
        print(f"backed up the good copy to {BACKUP}")
    else:
        print(f"using the existing good copy at {BACKUP}")

    if sys.argv[1] == "restore":
        shutil.copyfile(BACKUP, SHELL)
        print("restored")
        return 0

    # The keys are written as bare numbers above because that is how they read in the table, so
    # they are ints here and the argument arrives as a string.
    needle, replacement = FAULTS[int(sys.argv[1])]
    # Match on either line ending, then write back with whichever the file already used.
    crlf = "\r\n" in read()
    text = read().replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    if text == read():
        text = read().replace(needle, replacement)
    if needle.replace("\n", "\r\n") not in read() and needle not in read():
        print(f"FAULT {sys.argv[1]} NOT APPLIED — the needle is not in the file")
        return 1
    write(text)
    print(f"fault {sys.argv[1]} applied (crlf={crlf})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
