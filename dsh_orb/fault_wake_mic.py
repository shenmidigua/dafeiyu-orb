"""
Put the wake engine's microphone half back into the state it shipped in.

The bug: `openMicrophone` built its status note from a `detail` variable that no longer existed,
so the function threw a `ReferenceError` on its last line — after the graph was live and before
the caller learned anything. `start()` caught it, published `error`, and the ball said the wake
word was unavailable. No configuration change could have fixed it, and no amount of reading the
configuration would have found it.

This script puts that exact line back so the regression tests can be shown to fail on it. The
good version is kept once, and `restore` always reads from that copy — a backup refreshed on every
run would walk the source towards whichever fault was injected last.

The needle is matched by regex rather than by literal: `shell.js` and `wake.js` are CRLF, and a
`\n` in a Python needle silently fails to match them, which looks exactly like "the test has no
teeth". So the pattern tolerates either line ending.

Usage: fault_wake_mic.py [1|restore]
"""
import io
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WAKE = os.path.join(ROOT, "packages", "helper", "assets", "wake.js")
BACKUP = os.path.join(HERE, ".wake.js.good")

FAULTS = {
    # 1 — the shipped bug: a name that is not in scope.
    1: (
        r"return ecNote === .{2} && rateNote === .{2} \? .{2} : `[^`]*`\.trim\(\)",
        "return detail === '' ? '' : `${detail}${ecNote} 采样率 ${rateNote}`.trim()",
    ),
    # 2 — the note silently becomes empty, which is the same class of defect: the status line
    # stops telling the truth, but this time without an exception to give it away.
    2: (
        r"return ecNote === .{2} && rateNote === .{2} \? .{2} : `[^`]*`\.trim\(\)",
        "return ''",
    ),
}


def apply(index: int) -> int:
    if not os.path.exists(BACKUP):
        shutil.copyfile(WAKE, BACKUP)
        print(f"kept a good copy at {BACKUP}")
    with io.open(WAKE, encoding="utf8", newline="") as handle:
        source = handle.read()
    pattern, replacement = FAULTS[index]
    faulted, count = re.subn(pattern, lambda _m: replacement, source, count=1)
    if count != 1:
        print(f"FAULT {index} NOT APPLIED — the needle did not match. "
              f"Read wake.js before trusting this script.")
        return 1
    with io.open(WAKE, "w", encoding="utf8", newline="") as handle:
        handle.write(faulted)
    print(f"fault {index} applied")
    return 0


def restore() -> int:
    if not os.path.exists(BACKUP):
        print("no good copy on disk — nothing to restore from")
        return 1
    shutil.copyfile(BACKUP, WAKE)
    print("restored")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    if sys.argv[1] == "restore":
        return restore()
    try:
        index = int(sys.argv[1])
    except ValueError:
        print(__doc__)
        return 2
    if index not in FAULTS:
        print(__doc__)
        return 2
    return apply(index)


if __name__ == "__main__":
    raise SystemExit(main())
