"""Swap one file inside the in-use dsh-orb release tarball.

Rebuilding the bundle through `assemble.mjs` needs every package's `dist/` to exist, and most of
them are not built in this tree. The fix is a single asset file, so the release tarball is opened,
that one entry replaced, and the archive rewritten — which keeps the shipped package in step with
what is installed without pretending to do a full build.

Usage: `swap_release_shell.py [--apply]`
"""

from __future__ import annotations

import shutil
import sys
import tarfile
from pathlib import Path

VENDOR = Path(r"C:\Users\digua\.dsh\profiles\desktop\vendor\dsh-orb-0.0.0.tgz")
FIXED = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\shell.js")
WORK = Path(r"C:\Users\digua\.dsh\dsh_orb\tarwork")
ENTRY = Path("package") / "dist" / "helper" / "assets" / "shell.js"


def main() -> int:
    apply = "--apply" in sys.argv

    if not VENDOR.is_file():
        print(f"missing {VENDOR}")
        return 1
    if not FIXED.is_file():
        print(f"missing {FIXED}")
        return 1

    print(f"release  {VENDOR}  {VENDOR.stat().st_size} bytes")
    print(f"fixed    {FIXED}  {FIXED.stat().st_size} bytes")

    if WORK.exists():
        shutil.rmtree(WORK, ignore_errors=True)
    WORK.mkdir(parents=True, exist_ok=True)

    with tarfile.open(VENDOR, "r:gz") as src:
        names = src.getnames()
        src.extractall(WORK)
    print(f"extracted {len(names)} entries")

    target = WORK / ENTRY
    if not target.is_file():
        print(f"entry not found in archive: {ENTRY}")
        return 1
    before = target.stat().st_size
    shutil.copyfile(FIXED, target)
    print(f"replaced {ENTRY}: {before} -> {target.stat().st_size} bytes")

    new_tgz = WORK / "dsh-orb-0.0.0.tgz"
    with tarfile.open(new_tgz, "w:gz") as out:
        out.add(WORK / "package", arcname="package", recursive=True)
    with tarfile.open(new_tgz, "r:gz") as check:
        count = len(check.getnames())
    print(f"repacked {new_tgz.name}: {new_tgz.stat().st_size} bytes, {count} entries (was {len(names)})")

    if count != len(names):
        print("entry count changed; refusing to install")
        return 1

    if not apply:
        print("\ndry run — pass --apply to install over the release tarball")
        return 0

    import time
    stamp = time.strftime("%Y%m%d_%H%M%S")
    backup = VENDOR.with_name(f"{VENDOR.name}.bak-{stamp}")
    shutil.copyfile(VENDOR, backup)
    print(f"backed up old release -> {backup.name}")
    shutil.copyfile(new_tgz, VENDOR)
    print(f"installed new release -> {VENDOR}  {VENDOR.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
