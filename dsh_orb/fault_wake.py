"""Revert each fix to its broken form, so the new assertions can be shown to have teeth.

The pattern here is the one the rest of `dsh_orb/` uses: a good copy is taken once, before the
first injection, and every later call restores from it. An earlier version re-took the backup on
each run, which meant the inject/restore loop walked the source towards the last fault injected
and the final "restore" restored a broken file -- two runs of the loop and the good version was
gone.

Line endings are detected rather than assumed. `str.replace` with a `\\n` needle silently fails to
match on a CRLF file, which looks exactly like "the test has no teeth" and cost an hour once.
"""

import io
import os
import shutil
import sys

HOST = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "packages", "host", "src")
PREFS = os.path.join(HOST, "preferences.ts")
ASSETS = os.path.join(HOST, "wake-assets.ts")
# The backup is per-file, named after the file it stands in for. The earlier version used one
# prefix for both and tested `exists(BACKUP)`, which is a path no file is ever written to -- so
# every restore reported "no backup to restore from" and the first fault stayed in the source for
# the rest of the loop. Existence is checked per file, which is what actually gets tested.
BACKUP = {PREFS: PREFS + ".fault-backup", ASSETS: ASSETS + ".fault-backup"}

# Fault 1: setWakeEnabled writes the snapshot read at construction instead of re-reading, so a
# field edited on disk while the host runs is reverted by the next unrelated toggle.
FAULT_1 = (
    "this.wakeValue = { ...readWake(this.dir), enabled }",
    "this.wakeValue = { ...this.wakeValue, enabled }",
)

# Fault 2: resolveWakeAssets trusts the configured directory without opening it.
FAULT_2 = (
    "    const configured = readWakeDirectory(preference.assetDirectory, preference.keyword)",
    "    const configured = preference.assetDirectory === ''\n"
    "      ? undefined\n"
    "      : resolve(preference.assetDirectory)",
)

FAULTS = {1: (PREFS, FAULT_1), 2: (ASSETS, FAULT_2)}


def read(path: str) -> str:
    # newline="" keeps the line endings exactly as they are on disk, which is what makes the
    # needle below matchable in the first place.
    with io.open(path, encoding="utf8", newline="") as handle:
        return handle.read()


def write(path: str, text: str) -> None:
    with io.open(path, "w", encoding="utf8", newline="") as handle:
        handle.write(text)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "restore"}:
        print(__doc__)
        print("usage: fault_wake.py 1|2|restore")
        return 2

    if sys.argv[1] == "restore":
        missing = [path for path in (PREFS, ASSETS) if not os.path.exists(BACKUP[path])]
        if missing:
            print(f"no backup for {[os.path.basename(p) for p in missing]}")
            return 1
        for path in (PREFS, ASSETS):
            shutil.copyfile(BACKUP[path], path)
        print("restored both files")
        return 0

    for path in (PREFS, ASSETS):
        if not os.path.exists(BACKUP[path]):
            shutil.copyfile(path, BACKUP[path])
    print(f"backed up to {os.path.basename(BACKUP[PREFS])} / {os.path.basename(BACKUP[ASSETS])}")

    path, (needle, replacement) = FAULTS[int(sys.argv[1])]
    source = read(path)
    if needle not in source:
        print(f"*** fault {sys.argv[1]} NOT APPLIED: needle not found in {os.path.basename(path)} ***")
        return 1
    write(path, source.replace(needle, replacement, 1))
    print(f"fault {sys.argv[1]} applied to {os.path.basename(path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
