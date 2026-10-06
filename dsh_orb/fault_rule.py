"""Break one thing about the consecutive-window rule, run the tests, put it back.

`wake-rule.test.ts` passes on correct code, which proves nothing until it has been seen to fail on
each way the rule can silently go back to the old behaviour. Four faults, one per way:

    1  the run threshold drops to one window (the shipped-for-a-day rule: any spike wakes the ball)
    2  the streak is not cleared by a window below the threshold (a gap stops meaning anything)
    3  `reset()` leaves the streak alone (two windows either side of a mute add up to a wake)
    4  the cooldown stops gating the streak (windows during the alarm bank towards the next one)

Usage:  python fault_rule.py <1|2|3|4|restore>

Line endings are read as bytes and matched on a normalised copy, because a plain `str.replace` on a
`\\n` needle silently finds nothing in a CRLF file - which looks exactly like "the fault was never
applied" and quietly invalidates the whole check.
"""

import os
import shutil
import sys

WAKE = r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\wake.js"
BACKUP = r"C:\Users\digua\AppData\Local\Temp\wake.rule.good.js"

STREAK = """      const hot = score > this.config.threshold && speechActive && !this.coolingDown && this.running
      this.hotStreak = hot ? this.hotStreak + 1 : 0
      if (this.hotStreak >= CONSECUTIVE_WINDOWS) {
"""

FAULTS = {
    1: (STREAK, """      const hot = score > this.config.threshold && speechActive && !this.coolingDown && this.running
      this.hotStreak = hot ? this.hotStreak + 1 : 0
      if (this.hotStreak >= 1) {
"""),
    2: (STREAK, """      const hot = score > this.config.threshold && speechActive && !this.coolingDown && this.running
      this.hotStreak = hot ? this.hotStreak + 1 : this.hotStreak
      if (this.hotStreak >= CONSECUTIVE_WINDOWS) {
"""),
    3: ("""    // A new stream has no history to be part-way through: two hot windows from before a mute must not
    // count towards three after it.
    this.hotStreak = 0
""", ""),
    4: (STREAK, """      const hot = score > this.config.threshold && speechActive
      this.hotStreak = hot ? this.hotStreak + 1 : 0
      if (this.hotStreak >= CONSECUTIVE_WINDOWS) {
"""),
}


def read() -> str:
    with open(WAKE, "rb") as handle:
        return handle.read().decode("utf8")


def write(text: str) -> None:
    with open(WAKE, "wb") as handle:
        handle.write(text.encode("utf8"))


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "restore"}:
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
