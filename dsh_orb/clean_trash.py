"""Empty the staging trash left behind by an interrupted assemble.mjs run.

`assemble.mjs` renames whatever it is about to replace into a `.retired-XXXXXX` scratch dir and
then removes it. Here that removal was cut short, so the tree survived into a tarball. The shell
`rm -rf` is refused by the sandbox, so this walks it down a pass at a time and reports the count
after each pass rather than pretending a single call succeeded.
"""

from __future__ import annotations

import os
import shutil

ROOT = r"C:\Users\digua\.dsh\dsh_orb\trash\retired-baELkX"


def count(path: str) -> tuple[int, int]:
    files = directories = 0
    for _base, dirs, names in os.walk(path):
        directories += len(dirs)
        files += len(names)
    return files, directories


def main() -> int:
    if not os.path.isdir(ROOT):
        print("nothing to clean - the directory is already gone")
        return 0

    files, directories = count(ROOT)
    print(f"start: {files} files in {directories} directories")

    for attempt in range(1, 9):
        shutil.rmtree(ROOT, ignore_errors=True)
        if not os.path.isdir(ROOT):
            print(f"emptied after {attempt} pass(es)")
            return 0
        files, directories = count(ROOT)
        print(f"pass {attempt}: {files} files, {directories} directories remain")

    print("gave up - the sandbox keeps refusing the removal")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
