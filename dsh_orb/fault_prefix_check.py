"""Prove `wake_prefix_check.py` has teeth: inject each fault, run it, require it to fail.

An assertion that passes is evidence of nothing until it has been seen to fail on the thing it claims
to catch. So: for each fault in `fault_prefix.py`, break the source, run the check, and require a
non-zero exit. A fault the check does not notice is reported as a failure of *the check*, not of the
fault. Afterwards the source is restored and compared byte for byte against a copy taken before
anything was touched, because a driver that leaves the tree modified is worse than no driver.

Usage:  python fault_prefix_check.py

Two traps this exists to avoid, both of which have cost time on this project before:

  * **A stale backup.** `fault_prefix.py` copies the good source once and keeps it. If the source is
    edited afterwards, the next inject/restore silently reverts the edit and the driver reports
    "restored" while having thrown the work away. The backup is deleted here, before the first
    injection, so it is always taken from the source as it stands now.
  * **A check that fails for the wrong reason.** A fault that makes `extract` raise is not the same as
    a fault the *check* catches, so the check's own output is scanned for its FAIL lines rather than
    only its exit code. If a fault is only ever caught by a crash, that is reported separately.
"""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
PY = r"D:/tools/indextts/py311/python.exe"
sys.path.insert(0, str(HERE))

import fault_prefix  # noqa: E402

DATASET = HERE / "wake_dataset.py"
# Taken from the injector rather than written out a second time. The two disagreed once: this file
# deleted a hard-coded `C:\Windows\Temp` path while the injector built its own from `%TEMP%`, so the
# stale copy was never removed, the injector declined to re-take it, and `restore` wrote a version of
# the source from two edits earlier back over the tree. The hash comparison below is the only reason
# it was noticed, and it noticed by failing rather than by passing, which is the right direction — but
# the run was wasted.
BACKUP = fault_prefix.BACKUP

FAULT_COUNT = 4


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=HERE, capture_output=True, text=True, encoding="utf8",
                          errors="replace")


def main() -> int:
    # The backup must not outlive an edit to the source. See the docstring.
    if BACKUP.exists():
        BACKUP.unlink()
        print(f"removed the stale backup at {BACKUP}")

    pristine = digest(DATASET)
    print(f"wake_dataset.py {pristine[:16]}")

    results: list[tuple[int, bool, bool, str]] = []
    for fault in range(1, FAULT_COUNT + 1):
        injected = run([PY, "fault_prefix.py", str(fault)])
        if injected.returncode != 0:
            print(f"  fault {fault}: INJECTION FAILED\n{injected.stdout}{injected.stderr}")
            results.append((fault, False, False, "injection failed"))
            break

        # The backup has to hold *this* source, because `restore` is only ever as good as it. A
        # mismatch here means the injector reused a copy from before the last edit, and the run would
        # otherwise end by silently reverting that edit.
        if digest(BACKUP) != pristine:
            print(f"  fault {fault}: THE INJECTOR REUSED A STALE BACKUP at {BACKUP} "
                  f"({digest(BACKUP)[:16]} against {pristine[:16]}). Restore would revert the source.")
            return 1

        suite = run([PY, "wake_prefix_check.py", "--smoke", "--clips", "4"])
        caught_by_check = "FAIL " in suite.stdout
        noticed = suite.returncode != 0
        detail = ""
        for line in suite.stdout.splitlines():
            if "FAIL " in line:
                detail = line.strip()[:150]
                break
        if not noticed:
            detail = "the check passed on broken code"
        results.append((fault, noticed, caught_by_check, detail))

        run([PY, "fault_prefix.py", "restore"])
        if digest(DATASET) != pristine:
            print(f"  fault {fault}: RESTORE DID NOT BRING THE SOURCE BACK")
            return 1
        print(f"  fault {fault}: {'caught' if caught_by_check else 'noticed (crash)'} — {detail}")

    run([PY, "fault_prefix.py", "restore"])
    final = digest(DATASET)
    if final != pristine:
        print(f"  source is not byte-identical after the run: {final[:16]} against {pristine[:16]}")
        return 1
    print(f"  source restored byte for byte ({final[:16]})")

    teeth = [f for f, noticed, _, _ in results if noticed]
    blind = [f for f, noticed, _, _ in results if not noticed]
    print()
    print(f"  {len(teeth)}/{FAULT_COUNT} faults were caught")
    if blind:
        print(f"  BLIND to fault(s) {blind}: the check does not assert what they break")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
