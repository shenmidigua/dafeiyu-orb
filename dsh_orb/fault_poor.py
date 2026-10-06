"""Break one thing in the poor face, rebuild, run the checkers, put it back.

The point is the second half. A check that passes on correct code proves nothing unless it has been
seen to fail on broken code, and these are the four ways this feature can be subtly wrong while still
looking right in a screenshot:

    1  the page reads an unreadable balance as zero, so every machine that never signed in wears the
       sad face — the one failure that turns a cosmetic joke into a wrong statement about the account
    2  the two resting faces share a `dataset.mode`, so the swap never repaints the `<img>`: the ball
       keeps whichever face it happened to be wearing when the balance changed
    3  the line is compared the wrong way round, so the face means "I am rich"
    4  the host sums a failed account read as zero instead of "not known", which is failure 1 one
       layer further up

Four checkers are run for every fault and their verdicts printed. They answer different questions, and
a fault only one of them can see is normal rather than a hole:

    packages/host/tests/balance.test.ts     the host's reading of an account payload
    walk_poor_sequence.mjs                  what the ball wears, from the page's own predicate
    verify_poor_slot.mjs                    that every hop is wired and the page still parses
    probe_poor_balance.mjs                  the whole chain on a live helper and a stub host

The last one takes a minute, because it starts an Electron helper and reads the `<img>` the ball is
actually wearing; it is also the only one that can see failure 1, so it stays. A fault none of them
catches is a hole in the checks rather than a fault that does not matter, and this script says so.

The fault goes into the *source* tree, then the package is rebuilt and installed, because three of the
four checkers read the installed copy — a fault left in the sources and never built is invisible to
them and would look like an uncovered fault. `restore` refuses to run unless each file is the good
copy or the good copy with one known fault in it, because a stale good copy silently reverts real
edits (that is not hypothetical: it happened to `fault_arrive.py`).

Usage:  python fault_poor.py <1|2|3|4|restore>
"""

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
    "balance": os.path.join(ROOT, "packages", "host", "src", "balance.ts"),
}
BACKUPS = {key: os.path.join(SCRATCH, f"{key}.poor.good") for key in FILES}

CHECKERS = [
    ("balance.test.ts", None),
    ("walk_poor_sequence.mjs", os.path.join(HERE, "walk_poor_sequence.mjs")),
    ("verify_poor_slot.mjs", os.path.join(HERE, "verify_poor_slot.mjs")),
    ("probe_poor_balance.mjs", os.path.join(HERE, "probe_poor_balance.mjs")),
]

# (file, needle, replacement)
FAULTS = {
    1: ("shell",
        "    if (typeof cny !== 'number' || !Number.isFinite(cny) || cny < 0) return null\n",
        "    if (typeof cny !== 'number' || !Number.isFinite(cny) || cny < 0) return 0\n"),
    2: ("shell",
        "      const mode = broke ? 'poor' : 'idle'\n",
        "      const mode = 'idle'\n"),
    3: ("shell",
        "    return balanceCny < poorBelow\n",
        "    return balanceCny > poorBelow\n"),
    4: ("balance",
        "  if (balance.status !== 'ready') return null\n",
        "  if (balance.status !== 'ready') return 0\n"),
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
    """Whether the good copy accounts for the current file: it is the copy, or one known fault."""
    good = good_copy(key)
    if good is None:
        return False
    current = read(key)
    if current == good:
        return True
    return any(FAULTS[number][0] == key and faulted(good, number) == current for number in FAULTS)


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
    audits the staged bundle against the *sources*, so a stage that is even one package stale is
    refused — correctly, since that check exists to stop a stale package being installed silently.
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
                    os.path.join(ROOT, "packages", "host", "tests", "balance.test.ts")]
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
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "restore"}:
        print(__doc__)
        return 2

    # The good copies are taken once, and only if they are not already there. Re-copying on every call
    # is the bug `fault_webfetch.py` was written after doing once already: a `restore` that snapshots
    # first saves whatever fault is currently in the file.
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
