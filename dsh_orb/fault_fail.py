"""Break one thing in the failure face, rebuild, run the checkers, put it back.

The point is the second half. A check that passes on correct code proves nothing unless it has been seen
to fail on broken code, and these are the five ways this feature can be subtly wrong while still looking
right in a screenshot:

    1  the host counts every ending that is not `completed` as a failure, so the ball cries every time
       the user stops a run themselves — 26 of the 166 turn ends in this machine's own logs
    2  the page rings the finished-task bell *as well*, so a failed run is celebrated and then mourned
    3  the page drops the flag on the way in, so the host's verdict never reaches the face
    4  a cancellation that arrives with a failure still cries: the one moment the two verdicts collide
    5  the failure face never clears, so one broken run leaves the ball crying for the rest of the
       session — the failure mode with no upper bound on how wrong it looks

Four checkers are run for every fault and their verdicts printed. They answer different questions, and a
fault only one of them can see is normal rather than a hole:

    packages/host/tests/failure.test.ts     the host's reading of a turn end, and what it tells the ball
    walk_fail_sequence.mjs                  what the ball wears, from the page's own predicate
    verify_fail_slot.mjs                    that every hop is wired and the page still parses
    probe_fail_face.mjs                     the whole chain on a live helper and a stub host

The last one takes a minute, because it starts an Electron helper and reads the `<img>` the ball is
actually wearing; it is also the only one that can see fault 5. A fault none of them catches is a hole in
the checks rather than a fault that does not matter, and this script says so.

The fault goes into the *source* tree, then the package is rebuilt and installed, because three of the
four checkers read the installed copy — a fault left in the sources and never built is invisible to them
and would look like an uncovered fault. `restore` refuses to run unless each file is the good copy or the
good copy with one known fault in it, because a stale good copy silently reverts real edits (that is not
hypothetical: it happened to `fault_arrive.py`, and the guard is what caught it).

Usage:  python fault_fail.py <1|2|3|4|5|restore>

Running several faults in a row is safe: `restore` recognises its own faults in any combination, so it
will not refuse because two of them are in the tree at once.
"""

import itertools
import os
import shutil
import subprocess
import sys

ROOT = r"C:\Users\digua\Desktop\dsh-orb-cordis"
HERE = os.path.dirname(os.path.abspath(__file__))
STAGE = os.path.join(os.path.expanduser("~"), ".dsh", "dsh_orb", "buildstage", "package")
SCRATCH = os.environ.get("TEMP", r"C:\Users\digua\AppData\Local\Temp")

FILES = {
    "shell": os.path.join(ROOT, "packages", "helper", "assets", "shell.js"),
    "failure": os.path.join(ROOT, "packages", "host", "src", "failure.ts"),
}
BACKUPS = {key: os.path.join(SCRATCH, f"{key}.fail.good") for key in FILES}

CHECKERS = [
    ("failure.test.ts", None),
    ("walk_fail_sequence.mjs", os.path.join(HERE, "walk_fail_sequence.mjs")),
    ("verify_fail_slot.mjs", os.path.join(HERE, "verify_fail_slot.mjs")),
    ("probe_fail_face.mjs", os.path.join(HERE, "probe_fail_face.mjs")),
]

# (file, needle, replacement)
FAULTS = {
    1: ("failure",
        "  if (kind === 'error') {\n",
        "  if (kind !== 'completed') {\n"),
    2: ("shell",
        "    if (failed && !interrupted) playFailFrame()\n"
        "    else if (wasRunning && !interrupted) playDoneFrame()\n",
        "    if (failed && !interrupted) playFailFrame()\n"
        "    if (wasRunning && !interrupted) playDoneFrame()\n"),
    3: ("shell",
        "        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true, item.failed === true)\n",
        "        else if (item.type === 'turn') setRunning(item.running === true, item.interrupted === true, false)\n"),
    4: ("failure",
        "      ...(end.failure === null || interrupted ? {} : { failed: true as const }),\n",
        "      ...(end.failure === null ? {} : { failed: true as const }),\n"),
    5: ("shell",
        "    failTimer = setTimeout(() => {\n"
        "      failShown = undefined\n"
        "      syncGif()\n"
        "    }, oneShotHoldMs(failFrame.ms, failFrame.loops))\n",
        "    failTimer = setTimeout(() => {\n"
        "      syncGif()\n"
        "    }, oneShotHoldMs(failFrame.ms, failFrame.loops))\n"),
}


def read(key: str) -> str:
    with open(FILES[key], "rb") as handle:
        return handle.read().decode("utf8")


def write(key: str, text: str) -> None:
    with open(FILES[key], "wb") as handle:
        handle.write(text.encode("utf8"))


def faulted(text: str, number: int) -> str:
    """`text` with one fault applied, or `text` unchanged when the needle is not in it."""
    _key, needle, replacement = FAULTS[number]
    if needle.replace("\n", "\r\n") in text:
        return text.replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    return text.replace(needle, replacement)


def good_copy(key: str) -> str | None:
    path = BACKUPS[key]
    if not os.path.exists(path):
        return None
    with open(path, "rb") as handle:
        return handle.read().decode("utf8")


def backup_knows(key: str) -> bool:
    """Whether the current file is the good copy, or the good copy plus any set of known faults.

    Subsets rather than a single fault: running two faults back to back without restoring in between is
    an ordinary thing to do — it is how the faults were first checked — and a guard that then refuses to
    restore is a footgun, not a protection. A file that is the good copy plus known faults is still safe
    to restore; anything else, an edit this script never made, is still refused.
    """
    good = good_copy(key)
    if good is None:
        return False
    current = read(key)
    if current == good:
        return True
    numbers = [number for number in sorted(FAULTS) if FAULTS[number][0] == key]
    for size in range(1, len(numbers) + 1):
        for combo in itertools.combinations(numbers, size):
            text = good
            for number in combo:
                text = faulted(text, number)
            if text == current:
                return True
    return False


def apply_fault(number: int) -> bool:
    key = FAULTS[number][0]
    original = read(key)
    text = faulted(original, number)
    if text == original:
        print(f"FAULT {number} NOT APPLIED — the needle is not in {os.path.basename(FILES[key])}")
        return False
    write(key, text)
    crlf = "\r\n" in original
    print(f"fault {number} applied to {os.path.basename(FILES[key])} (crlf={crlf})")
    return True


def build_and_install() -> bool:
    """Rebuild from the (possibly faulted) sources and put them where the checkers read them.

    The whole workspace is built rather than only the package a fault touched: `pack_and_install.py`
    audits the staged bundle against the *sources*, so a stage that is even one package stale is refused
    — correctly, since that check exists to stop a stale package being installed silently.
    """
    pnpm = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-runtimes", "dsh-primary-runtime",
                        "dependencies", "pnpm", "bin", "pnpm.mjs")
    steps = [
        ["node", pnpm, "build"],
        ["node", os.path.join(ROOT, "packages", "bundle", "scripts", "assemble.mjs"), "--out", STAGE],
        [sys.executable, os.path.join(HERE, "pack_and_install.py")],
    ]
    for step in steps:
        path = step[1] if len(step) > 1 else step[0]
        result = subprocess.run(step, cwd=ROOT, capture_output=True, text=True,
                                encoding="utf8", errors="replace")
        print(f"  {os.path.basename(path)}: exit {result.returncode}")
        if result.returncode != 0:
            print((result.stdout or "")[-1500:])
            print((result.stderr or "")[-1500:])
            return False
    return True


def run_checkers() -> list[tuple[str, int, str]]:
    results: list[tuple[str, int, str]] = []
    for name, path in CHECKERS:
        if path is None:
            step = ["node", "--experimental-transform-types", "--disable-warning=ExperimentalWarning",
                    "--test", "--test-isolation=process",
                    os.path.join(ROOT, "packages", "host", "tests", "failure.test.ts")]
        else:
            step = ["node", path]
        result = subprocess.run(step, cwd=ROOT, capture_output=True, text=True,
                                encoding="utf8", errors="replace")
        print(f"  {name}: exit {result.returncode}")
        results.append((name, result.returncode, result.stdout or ""))
    return results


def report_fault(results: list[tuple[str, int, str]]) -> list[str]:
    caught = []
    for name, code, _out in results:
        if code == 0:
            print(f"      note: {name} does not catch this one")
        else:
            caught.append(name)
    return caught


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "5", "restore"}:
        print(__doc__)
        return 2

    # The good copies are taken once, and only if they are not already there. Re-copying on every call is
    # the bug `fault_webfetch.py` was written after doing once already: a `restore` that snapshots first
    # saves whatever fault is currently in the file.
    for key, path in BACKUPS.items():
        if not os.path.exists(path):
            shutil.copyfile(FILES[key], path)
            print(f"backed up {os.path.basename(FILES[key])} to {path}")
        else:
            print(f"using the existing good copy at {path}")
            if not backup_knows(key):
                print(f"note: {os.path.basename(FILES[key])} has edits this good copy does not know")
                print("      about, so a `restore` would refuse. Delete the copy to re-take it.")

    if sys.argv[1] == "restore":
        for key in FILES:
            if not backup_knows(key):
                print(f"REFUSING to restore {os.path.basename(FILES[key])}: the source has edits the")
                print("  good copy does not know about. Take a fresh copy (`del` it and re-run any")
                print("  fault), or restore by hand — copying this one over would throw that work away.")
                return 1
        for key, path in BACKUPS.items():
            shutil.copyfile(path, FILES[key])
        print("restored")
        if not build_and_install():
            return 1
        print("checking the restored build (all four checkers have to pass):")
        failed = [name for name, code, _out in run_checkers() if code != 0]
        if failed:
            print(f"\n{' , '.join(failed)} FAIL ON THE RESTORED BUILD")
            return 1
        print("\nRESTORED BUILD VERIFIED")
        return 0

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
