"""Break one thing in the greeting, rebuild, run the checkers, put it back.

The point is the second half. A check that passes on correct code proves nothing unless it has been
seen to fail on broken code, and these are the three ways this feature can be subtly wrong while
still looking right in a screenshot.

Usage:  python fault_arrive.py <1|2|3|4|5|restore>

    1  the branch is gone, so the ball opens on its resting loop and nothing else complains
    2  the greeting is read by the frame sweep instead of at boot. It still plays — the once-per-page
       guard holds — but it lands behind the dozen files that sweep reads first, which is the one
       thing this slot exists to avoid. It is a placement fault, so only the static check can see it
    3  the greeting is never released, so the ball wears the last clip for ever and no later face is
       ever seen
    4  the greeting is started at page load instead of when the window is shown, so the helper's
       hidden startup spends it: the window comes up a second later and the user sees the tail of an
       animation whose beginning was the whole point. This one is not theoretical — it is what the
       first live run of `watch_arrival.py` measured, and it is why `whenVisible()` exists
    5  only the first clip is played, so the ball arrives and never waves. The sequence, the timing
       and the release are all still there, which is what makes this the quiet one

Both checkers are run for every fault and their verdicts printed: `walk_arrive_sequence.mjs`
catches 1, `verify_arrive_slot.mjs` catches 2 and 3. A fault neither catches is a hole in the
checks rather than a fault that does not matter, and this script says so out loud.

The fault goes into the *source*, then the package is rebuilt and installed, because both checkers
read the installed copy — a fault left in the source tree and never built is invisible to them and
would look like an uncovered fault.

Line endings are read as bytes and matched on a normalised copy, because this file is CRLF and a
plain `str.replace` on a `\\n` needle silently finds nothing — which looks exactly like "the fault
was never applied" and quietly invalidates the whole check.
"""

import os
import shutil
import subprocess
import sys

ROOT = r"C:\Users\digua\Desktop\dsh-orb-cordis"
SHELL = os.path.join(ROOT, "packages", "helper", "assets", "shell.js")
HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.join(os.path.expanduser("~"), ".dsh", "dsh_orb", "buildstage", "package")
BACKUP = os.path.join(os.environ.get("TEMP", r"C:\Users\digua\AppData\Local\Temp"),
                      "shell.arrive.good.js")

CHECKERS = [
    ("walk_arrive_sequence.mjs", os.path.join(HERE, "walk_arrive_sequence.mjs")),
    ("verify_arrive_slot.mjs", os.path.join(HERE, "verify_arrive_slot.mjs")),
]

BLOCK = """    if (arriveShown !== undefined) {
      const mode = `arrive-${arriveShown.step}`
      if (gif.dataset.mode !== mode) {
        gif.dataset.mode = mode
        gif.src = arriveShown.src
      }
      return
    }
"""

FAULTS = {
    # 1: the whole branch, comment and all, taken out of `syncGif`. The greeting is still fetched,
    #    still timed, still in the config — and never worn.
    1: (BLOCK, ""),
    # 2: the greeting pulled into the sweep that reads a dozen frames one after another.
    2: ("  async function refreshFrames() {\n",
        "  async function refreshFrames() {\n    void wearArriveFrame()\n"),
    # 3: the release dropped, so the last clip's hold never ends.
    3: ("    arriveShown = undefined\n    syncGif()\n  }\n",
        "    syncGif()\n  }\n"),
    # 4: the greeting started at page load, which is the helper's hidden startup rather than the
    #    moment anybody can see the ball.
    4: ("const [frames] = await Promise.all([fetchArrive(), whenVisible()])",
        "const [frames] = await Promise.all([fetchArrive()])"),
    # 5: only the first clip is ever played, so the ball arrives and never waves. Every other check
    #    passes — the sequence, the timing and the release are all still in place.
    5: ("    for (const frame of frames) {\n",
        "    for (const frame of frames.slice(0, 1)) {\n"),
}


def read() -> str:
    with open(SHELL, "rb") as handle:
        return handle.read().decode("utf8")


def write(text: str) -> None:
    with open(SHELL, "wb") as handle:
        handle.write(text.encode("utf8"))


def faulted(text: str, number: int) -> str:
    """`text` with one fault applied, or `text` unchanged when the needle is not in it."""
    needle, replacement = FAULTS[number]
    swapped = text.replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    return text if swapped == text else swapped


def apply_fault(number: int) -> bool:
    original = read()
    text = faulted(original, number)
    if text == original:
        print(f"FAULT {number} NOT APPLIED — the needle is not in the file")
        return False
    write(text)
    crlf = "\r\n" in original
    print(f"fault {number} applied (crlf={crlf})")
    return True


def backup_knows(source: str) -> bool:
    """Whether the good copy accounts for the source: it is either the good copy or one known fault."""
    if not os.path.exists(BACKUP):
        return False
    with open(BACKUP, "rb") as handle:
        good = handle.read().decode("utf8")
    return source == good or any(faulted(good, number) == source for number in FAULTS)


def restore_is_safe() -> bool:
    """Whether the good copy may be copied over the source at all.

    A `restore` is only meaningful when the source is the good copy with one known fault in it. The
    backup is taken once and reused, so it goes stale the moment the feature is edited — and then
    `restore` quietly reverts that edit, which is the worst possible outcome: the source loses work,
    the build matches it, and every checker reports success because they agree with each other. That
    happened to this very script on the day the greeting grew a second clip. So the source is checked
    against the backup and against each faulted backup, and anything else is refused.
    """
    if not os.path.exists(BACKUP):
        print("no good copy to restore from")
        return False
    if backup_knows(read()):
        return True
    print("REFUSING to restore: the source has edits the good copy does not know about.")
    print(f"  good copy: {BACKUP}")
    print("  Take a fresh good copy (`del` it and re-run any fault), or restore by hand — copying")
    print("  this one over the source would throw that work away and leave every checker happy.")
    return False


def build_and_install() -> bool:
    """Rebuild from the (possibly faulted) source and put it where the checkers read it."""
    steps = [
        ["node", os.path.join(ROOT, "packages", "bundle", "scripts", "assemble.mjs"), "--out", STAGE],
        [sys.executable, os.path.join(HERE, "pack_and_install.py")],
    ]
    for step in steps:
        result = subprocess.run(step, cwd=ROOT, capture_output=True, text=True,
                                encoding="utf8", errors="replace")
        label = os.path.basename(step[1] if len(step) > 1 else step[0])
        print(f"  {label}: exit {result.returncode}")
        if result.returncode != 0:
            print((result.stdout or "")[-2000:])
            print((result.stderr or "")[-2000:])
            return False
    return True


def run_checkers() -> list[tuple[str, int]]:
    """Run both checkers against whatever is installed, and return their exit codes."""
    results: list[tuple[str, int]] = []
    for name, path in CHECKERS:
        result = subprocess.run(["node", path], cwd=ROOT, capture_output=True, text=True,
                                encoding="utf8", errors="replace")
        print(f"  {name}: exit {result.returncode}")
        for line in [l for l in (result.stdout or "").splitlines() if l.strip()][-8:]:
            print(f"      {line}")
        results.append((name, result.returncode))
    return results


def report_fault(results: list[tuple[str, int]]) -> list[str]:
    """The checkers that failed on the fault. A fault is covered when at least one of them does.

    Which one caught it is worth printing but is not a verdict: these two answer different questions
    — the walker asks what the ball wears for a given state, the verifier asks whether the state is
    ever reached and released — and a fault that only one of them can see is normal rather than a
    hole. What would be a hole is a fault that neither fails on.
    """
    caught: list[str] = []
    for name, code in results:
        if code == 0:
            print(f"      note: {name} does not catch this one")
        else:
            caught.append(name)
    return caught


def report_restored(results: list[tuple[str, int]]) -> int:
    """How many checkers failed on the restored build, which is the mirror-image question."""
    failed = 0
    for name, code in results:
        if code != 0:
            print(f"      *** {name} FAILED on the restored build")
            failed += 1
    return failed


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "5", "restore"}:
        print(__doc__)
        return 2

    # The good copy is taken once, and only if it is not already there. Re-copying it on every call
    # is the bug `fault_webfetch.py` was written after doing once already: a `restore` that
    # snapshots first saves whatever fault is currently in the file.
    if not os.path.exists(BACKUP):
        shutil.copyfile(SHELL, BACKUP)
        print(f"backed up the good copy to {BACKUP}")
    else:
        print(f"using the existing good copy at {BACKUP}")
        if not backup_knows(read()):
            print("note: the source has edits this good copy does not know about, so a `restore`")
            print("      would refuse rather than revert them. Delete the copy to re-take it.")

    if sys.argv[1] == "restore":
        if not restore_is_safe():
            return 1
        shutil.copyfile(BACKUP, SHELL)
        print("restored")
        if not build_and_install():
            return 1
        print("checking the restored build (both checkers have to pass):")
        failed = report_restored(run_checkers())
        print("\nRESTORED BUILD VERIFIED" if failed == 0
              else f"\n{failed} CHECKER(S) FAIL ON THE RESTORED BUILD")
        return 1 if failed else 0

    number = int(sys.argv[1])
    if not apply_fault(number):
        return 1
    if not build_and_install():
        return 1
    print(f"checking fault {number} (at least one checker has to fail):")
    caught = report_fault(run_checkers())
    if caught:
        print(f"\nFAULT IS COVERED by {', '.join(caught)}")
        return 0
    print("\nNO CHECKER FAILED ON THIS FAULT")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
