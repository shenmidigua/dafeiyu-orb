"""Prove `wake-meter.test.ts` has teeth: inject every fault, run the suites, expect a failure.

A regression test that has never been seen to fail is not evidence. `wake-meter.test.ts` is green on
the shipped page, and that is exactly what it would look like if every assertion in it were vacuous -
so the check is the other way round: put each known-broken version of the page back, and require at
least one assertion to break for each. A fault that leaves the suite green is a fault nothing is
guarding, and it is reported as such rather than counted as a pass.

Fault 13 is the one the user reported, so it is also the one that matters most here.

The source is restored from the good copies at the end and the result is compared byte for byte: a
sweep that leaves a fault behind would poison every later run, and "restored" is a claim about bytes,
not about a script having printed "restored".

Usage:  python fault_meter_check.py            all nineteen faults
        python fault_meter_check.py 13 16      just these
"""

import hashlib
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HELPER = os.path.join(ROOT, "packages", "helper")
ASSETS = os.path.join(HELPER, "assets")
BACKUP_DIR = os.path.join(os.environ.get("LOCALAPPDATA", r"C:\Users\digua\AppData\Local"), "Temp")

FAULT = os.path.join(HERE, "fault_meter.py")
PYTHON = sys.executable
NODE = r"C:\Users\digua\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"

TESTS = [
    os.path.join("tests", "wake-meter.test.ts"),
    os.path.join("tests", "transcript-model.test.ts"),
]

# The two files `fault_meter.py` can write, and where it keeps the version they should be left as.
GUARDED = {
    "shell.js": os.path.join(BACKUP_DIR, "wake.meter.good.shell.js"),
    "wake.js": os.path.join(BACKUP_DIR, "wake.meter.good.wake.js"),
}

FAULTS = list(range(1, 23))

NOT_OK = re.compile(r"^\s*not ok \d+ - (.+)$", re.M)


def sha(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def run_tests() -> tuple[int, int, list[str]]:
    """(passed, failed, names of everything that failed), from the suite's own TAP output."""
    result = subprocess.run(
        [NODE, "--experimental-transform-types", "--disable-warning=ExperimentalWarning",
         "--test", *TESTS],
        cwd=HELPER, capture_output=True, text=True, encoding="utf8", errors="replace",
    )
    output = (result.stdout or "") + (result.stderr or "")
    passed = int((re.search(r"^# pass (\d+)$", output, re.M) or [0, 0])[1])
    failed = int((re.search(r"^# fail (\d+)$", output, re.M) or [0, 0])[1])
    names = []
    for name in NOT_OK.findall(output):
        # Suites and their subtests both report, so the suite carries the detail: keep the leaves.
        cleaned = name.strip()
        if cleaned not in names:
            names.append(cleaned)
    if failed == 0 and "ERR_" in output:
        # A crash before the runner could count anything - a page that does not parse, say.
        names.append(output.strip().splitlines()[-1][:160])
    return passed, failed, names


def main() -> int:
    wanted = [int(a) for a in sys.argv[1:]] or FAULTS
    unknown = [n for n in wanted if n not in FAULTS]
    if unknown:
        print(f"no such fault: {unknown}")
        return 2

    before = {name: sha(os.path.join(ASSETS, name)) for name in GUARDED}

    # The suites are run once on the untouched source first: a fault's "failure" only means something
    # against a baseline that was actually green, and a broken harness would otherwise look like
    # nineteen beautifully teethy faults.
    passed, failed, names = run_tests()
    print(f"baseline: {passed} pass, {failed} fail")
    if failed != 0:
        print("the suite is not green before anything was touched, so nothing below would prove:")
        for name in names:
            print(f"    {name}")
        return 1

    # Then the stale good copies are dropped, so `fault_meter.py` takes a fresh one from the source
    # that was just measured green. Without this the backups outlive the code they were taken from:
    # editing the source after a sweep and re-running it restores the *pre-edit* file, which silently
    # reverts the work and then reports "CHANGED" as if the sweep had failed to put things back.
    dropped = [good for good in GUARDED.values() if os.path.exists(good)]
    for good in dropped:
        os.remove(good)
    if dropped:
        print(f"dropped {len(dropped)} stale good copy/copies so this run backs up what it measured")

    rows = []
    for number in wanted:
        applied = subprocess.run([PYTHON, FAULT, str(number)], capture_output=True, text=True,
                                 encoding="utf8", errors="replace")
        if applied.returncode != 0:
            rows.append((number, "NOT APPLIED", applied.stdout.strip(), []))
            subprocess.run([PYTHON, FAULT, "restore"], capture_output=True)
            continue
        passed, failed, names = run_tests()
        rows.append((number, "caught" if failed > 0 else "BLIND", f"{failed} fail / {passed} pass",
                     names))
        subprocess.run([PYTHON, FAULT, "restore"], capture_output=True)

    restored = subprocess.run([PYTHON, FAULT, "restore"], capture_output=True, text=True,
                              encoding="utf8", errors="replace")
    after = {name: sha(os.path.join(ASSETS, name)) for name in GUARDED}
    clean = before == after

    width = max(len(name) for name in GUARDED)
    for number, verdict, summary, names in rows:
        print(f"fault {number:>2}  {verdict:<11} {summary}")
        for name in names[:4]:
            print(f"            - {name}")
        if len(names) > 4:
            print(f"            ... and {len(names) - 4} more")
    print()
    for name in GUARDED:
        print(f"{name.ljust(width)}  {'unchanged' if before[name] == after[name] else 'CHANGED'}  {after[name][:16]}")
    if not clean:
        print("THE SOURCE WAS NOT RESTORED - do not trust this run, and fix the source by hand")
        return 1

    blind = [number for number, verdict, _, _ in rows if verdict != "caught"]
    if blind:
        print(f"faults nothing caught: {blind} - those paths are unguarded")
        return 1
    print(f"all {len(rows)} faults caught, source restored")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
