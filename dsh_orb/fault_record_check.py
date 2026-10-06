"""Prove `wake_record_check.py` has teeth: inject each fault, run it, require it to fail.

An assertion that passes is evidence of nothing until it has been seen to fail on the thing it claims
to catch. So: for each fault in `fault_record.py`, break `wake_truncation_probe.record`, run the check,
and require a non-zero exit. A fault the check does not notice is reported as a failure of *the check*.
Afterwards the source is restored and compared byte for byte against a copy taken before anything was
touched, because a driver that leaves the tree modified is worse than no driver.

Two traps this exists to avoid, both of which have cost time on this project before:

  * **A stale backup.** The injector copies the good source once and keeps it. If the source is edited
    afterwards, the next inject/restore silently reverts the edit while reporting "restored". The
    backup is deleted here before the first injection, and its digest is compared against the source
    after every injection, so a reused copy is caught before it can throw work away.
  * **A fault caught by a crash rather than by an assertion.** A fault that makes `record` raise is not
    the same as a fault the *check* catches, so the check's own `FAIL` lines are scanned as well as its
    exit code.

Usage:  python fault_record_check.py
"""

from __future__ import annotations

import hashlib
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
PY = r"D:/tools/indextts/py311/python.exe"
sys.path.insert(0, str(HERE))

import fault_record  # noqa: E402

TARGET = HERE / "wake_truncation_probe.py"
# Taken from the injector rather than written out again: the two disagreed once, this file deleting a
# hard-coded `C:\Windows\Temp` path while the injector built its own from `%TEMP%`, and the run was
# wasted. The digest check below is the only reason it was noticed.
BACKUP = fault_record.BACKUP

FAULT_COUNT = 5


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(command, cwd=HERE, capture_output=True, text=True, encoding="utf8",
                          errors="replace")


def main() -> int:
    if BACKUP.exists():
        BACKUP.unlink()
        print(f"removed the stale backup at {BACKUP}")

    pristine = digest(TARGET)
    print(f"wake_truncation_probe.py {pristine[:16]}")
    print()

    results: list[tuple[int, bool, bool, str]] = []
    for fault in range(1, FAULT_COUNT + 1):
        injected = run([PY, "fault_record.py", str(fault)])
        if injected.returncode != 0:
            print(f"  fault {fault}: INJECTION FAILED\n{injected.stdout}{injected.stderr}")
            results.append((fault, False, False, "injection failed"))
            break

        if digest(BACKUP) != pristine:
            print(f"  fault {fault}: THE INJECTOR REUSED A STALE BACKUP at {BACKUP} "
                  f"({digest(BACKUP)[:16]} against {pristine[:16]}). Restore would revert the source.")
            return 1

        suite = run([PY, "wake_record_check.py"])
        caught_by_check = "FAIL " in suite.stdout
        noticed = suite.returncode != 0
        detail = ""
        for line in suite.stdout.splitlines():
            if "FAIL " in line:
                index = suite.stdout.splitlines().index(line) + 1
                detail = suite.stdout.splitlines()[index].strip()[:150]
                break
        if not noticed:
            detail = "the check passed on broken code"
        elif not caught_by_check:
            detail = "noticed, but by a crash rather than an assertion"
        results.append((fault, noticed, caught_by_check, detail))

        run([PY, "fault_record.py", "restore"])
        if digest(TARGET) != pristine:
            print(f"  fault {fault}: RESTORE DID NOT BRING THE SOURCE BACK")
            return 1
        print(f"  fault {fault}: {'caught' if caught_by_check else 'noticed (crash)'} — {detail}")

    run([PY, "fault_record.py", "restore"])
    final = digest(TARGET)
    if final != pristine:
        print(f"  source is not byte-identical after the run: {final[:16]} against {pristine[:16]}")
        return 1
    print()
    print(f"  source restored byte for byte ({final[:16]})")

    teeth = [f for f, noticed, _, _ in results if noticed]
    weak = [f for f, noticed, caught, _ in results if noticed and not caught]
    blind = [f for f, noticed, _, _ in results if not noticed]
    print(f"  {len(teeth)}/{FAULT_COUNT} faults were caught")
    if blind:
        print(f"  BLIND to fault(s) {blind}: the check does not assert what they break")
        return 1
    if weak:
        print(f"  fault(s) {weak} were caught only by a crash, not by an assertion")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
