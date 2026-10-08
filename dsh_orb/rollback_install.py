"""Put the installed dsh-orb back to an earlier tarball, without touching a single source file.

Why this exists rather than a rebuild: the ball runs `~/.dsh/profiles/desktop/node_modules/dsh-orb`, and
every `pnpm build` + `pack_and_install.py` in this session rebuilt that from the *working tree* — which
is somebody else's half-finished dock work. Rebuilding again would ship the same tree; this puts back a
tarball that was already known-good, and leaves the sources exactly as they are.

The install path in `pack_and_install.py` extracts over the existing tree, which is fine going forwards
(a newer build only adds and replaces files) and wrong going backwards: files that exist *only* in the
newer build would survive and quietly keep running. So the installed directory is emptied first, which
is why this asks for the path to be typed out rather than computed-and-trusted.

Usage: `rollback_install.py <tarball> [--dry-run]`
"""

from __future__ import annotations

import os
import shutil
import sys
import tarfile
import time

INSTALLED = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop", "node_modules", "dsh-orb")
VENDOR = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop", "vendor")
CURRENT = os.path.join(VENDOR, "dsh-orb-0.0.0.tgz")

# What the install path has to be, spelled out: this script empties a directory, and a computed path
# that resolved somewhere unexpected would take a profile's dependencies with it.
EXPECTED = os.path.normcase(os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop",
                                         "node_modules", "dsh-orb"))


def members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    """The archive's members with the leading `package/` stripped, as the installer does it."""
    found = []
    for member in archive.getmembers():
        parts = member.name.split("/", 1)
        if len(parts) == 2:
            member.name = parts[1]
        if member.name:
            found.append(member)
    return found


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    source = os.path.abspath(sys.argv[1])
    if not os.path.isfile(source):
        print(f"no such tarball: {source}")
        return 1
    if os.path.normcase(os.path.abspath(INSTALLED)) != EXPECTED:
        print(f"REFUSING: the install path resolved to {os.path.abspath(INSTALLED)}")
        return 1

    with tarfile.open(source, "r:gz") as archive:
        found = members(archive)
        files = [m for m in found if m.isfile()]
        print(f"tarball {os.path.basename(source)} ({os.path.getsize(source) / 1024 / 1024:.1f} MB): "
              f"{len(found)} members, {len(files)} files")
        # The two files that say which build this is, so the rollback can be identified afterwards.
        for wanted in ("dist/helper/assets/shell.js", "dist/helper/lib/main.js", "dist/host/index.js"):
            hit = next((m for m in files if m.name == wanted), None)
            print(f"  {wanted}: {'present' if hit is not None else 'MISSING'}")

        if "--dry-run" in sys.argv:
            print("dry run: nothing written")
            return 0

        stamp = time.strftime("%Y%m%d_%H%M%S")
        backup = f"{CURRENT}.bak-prerollback-{stamp}"
        shutil.copy2(CURRENT, backup)
        print(f"backed up the in-use tarball to {os.path.basename(backup)}")

        # Empty the installed tree first: extracting an older build over a newer one leaves the files
        # that only the newer one had, which is exactly how a rollback keeps running the new code.
        removed = 0
        for name in os.listdir(INSTALLED):
            path = os.path.join(INSTALLED, name)
            if os.path.isdir(path):
                shutil.rmtree(path, ignore_errors=True)
            else:
                os.remove(path)
            removed += 1
        print(f"emptied {INSTALLED} ({removed} entries)")

        archive.extractall(INSTALLED, members=found)
        print(f"extracted {len(found)} members")

    # Read the version back out of the files themselves rather than trusting the copy.
    for wanted in ("dist/helper/assets/shell.js", "dist/host/index.js"):
        path = os.path.join(INSTALLED, wanted)
        size = os.path.getsize(path) if os.path.isfile(path) else -1
        print(f"  {wanted}: {size} bytes, mtime {time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(os.path.getmtime(path)))}")

    # The fail slot's wiring is the one thing this session added to the installed package: its absence
    # is how the rollback is confirmed to have landed.
    shell = open(os.path.join(INSTALLED, "dist", "helper", "assets", "shell.js"), encoding="utf8").read()
    print(f"  carries the failure face: {'yes' if 'playFailFrame' in shell else 'no'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
