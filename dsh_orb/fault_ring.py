"""Break one thing about the ring's starting state, run the tests, put it back.

The point is the second half. `wake-ring.test.ts` passes on correct code, which proves nothing until
it has been seen to fail on the three ways this can silently go back to the old behaviour.

Usage:  python fault_ring.py <1|2|3|restore>

    1  the ring goes back to zeros on reset, and is still called ready to score
    2  `load()` resets before computing the quiet room, so the ring is zeroed after every load
    3  `runModels` scores a ring that is still filling, so the guard is gone

Line endings are read as bytes and matched on a normalised copy, because a plain `str.replace` on a
`\\n` needle silently finds nothing in a CRLF file - which looks exactly like "the fault was never
applied" and quietly invalidates the whole check.
"""

import os
import shutil
import sys

WAKE = r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\wake.js"
BACKUP = r"C:\Users\digua\AppData\Local\Temp\wake.ring.good.js"

FAULTS = {
    1: ("""    const quiet = this.quietEmbedding
    for (let i = 0; i < slots; i += 1) {
      this.embeddingHistory.push(quiet === undefined ? new Float32Array(96).fill(0) : quiet.slice())
    }
    this.ringFill = quiet === undefined ? 0 : slots
""",
        """    for (let i = 0; i < slots; i += 1) this.embeddingHistory.push(new Float32Array(96).fill(0))
    this.ringFill = slots
"""),
    2: ("""    this.quietEmbedding = await this.silenceEmbedding()
    this.reset()
""",
        """    this.reset()
    this.quietEmbedding = await this.silenceEmbedding()
"""),
    3: ("""      this.ringFill += 1
      if (this.ringFill < this.embeddingHistory.length) {
        this.melBuffer.splice(0, 8)
        continue
      }
""",
        """      this.ringFill += 1
"""),
}


def read() -> str:
    with open(WAKE, "rb") as handle:
        return handle.read().decode("utf8")


def write(text: str) -> None:
    with open(WAKE, "wb") as handle:
        handle.write(text.encode("utf8"))


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "restore"}:
        print(__doc__)
        return 2

    # The good copy is taken once, and only if it is not already there. Re-copying it on every call
    # makes a loop of inject/restore walk the source towards the last fault injected, and the final
    # "restore" restores that instead of the good version.
    if not os.path.exists(BACKUP):
        shutil.copyfile(WAKE, BACKUP)
        print(f"backed up the good copy to {BACKUP}")
    else:
        print(f"using the existing good copy at {BACKUP}")

    if sys.argv[1] == "restore":
        shutil.copyfile(BACKUP, WAKE)
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
    write(text)
    print(f"fault {sys.argv[1]} applied (crlf={crlf})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
