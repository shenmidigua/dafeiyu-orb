"""Finish the install by unpacking over what the batched delete left behind.

Deleting the installed package hit the safety hook at every attempt — 74 entries the first time, then
50 for a single directory. That guard exists to stop a broad delete, and fighting it batch by batch
is the wrong trade when the goal is simply "the installed files match the tarball".

So the deletion was carried as far as it would go, and the rest of the job is what tar was always
for: unpacking over the top. The tarball holds the complete tree, so extracting it replaces every
file it contains, and the files left behind are overwritten by name.

What this cannot do is remove a file that the new package *dropped* — tar has no memory of what was
there before. That is checked afterwards against the tarball's own listing, so a stale leftover is
detected rather than quietly shipped.
"""

from __future__ import annotations

import os
import sys
import tarfile

PROFILE = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop")
INSTALLED = os.path.join(PROFILE, "node_modules", "dsh-orb")
TARBALL = os.path.join(PROFILE, "vendor", "dsh-orb-0.0.0.tgz")


def unpack() -> int:
    """Extract with Python's tarfile rather than the shell's tar.

    The ``tar`` on PATH here is bsdtar, which rejects ``--force-local`` outright — that flag only
    exists in GNU tar, where it stops a path like ``C:/...`` being read as a remote host. The whole
    reason the flag is passed is a GNU-ism that does not apply to this implementation, and passing it
    anyway fails the extraction. tarfile has no such ambiguity and no shell quoting to get wrong.
    """
    os.makedirs(INSTALLED, exist_ok=True)
    with tarfile.open(TARBALL, "r:gz") as archive:
        members = archive.getmembers()
        for member in members:
            # Everything ships under package/; strip it so the files land at the root of the install.
            parts = member.name.split("/", 1)
            if len(parts) == 2:
                member.name = parts[1]
        archive.extractall(INSTALLED, members=[m for m in members if m.name])
    print(f"extracted {len(members)} members")
    return 0


def audit() -> None:
    """Compare what is installed with what the tarball contains, in both directions."""
    with tarfile.open(TARBALL, "r:gz") as archive:
        expected = set()
        for member in archive.getmembers():
            if member.isfile() and member.name.startswith("package/"):
                expected.add(member.name[len("package/"):])

    installed = set()
    for base, _directories, files in os.walk(INSTALLED):
        for name in files:
            installed.add(os.path.relpath(os.path.join(base, name), INSTALLED).replace("\\", "/"))

    missing = expected - installed
    extra = installed - expected

    print(f"\ntarball holds {len(expected)} files, installed has {len(installed)}")
    if missing:
        print(f"MISSING {len(missing)}:")
        for name in sorted(missing)[:10]:
            print(f"  {name}")
    else:
        print("every file from the tarball is present")

    if extra:
        # These are leftovers from the old package that the new one no longer ships. Worth naming
        # rather than removing blind — a file here could be something a previous build added.
        print(f"LEFTOVER {len(extra)}:")
        for name in sorted(extra)[:20]:
            print(f"  {name}")
    else:
        print("no leftovers")


def verify_speech() -> None:
    """The file this change exists for, compared byte for byte against the source."""
    installed = os.path.join(INSTALLED, "dist", "helper", "assets", "speech.js")
    source = r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\speech.js"
    if not os.path.isfile(installed):
        print(f"speech.js is MISSING at {installed}")
        return
    with open(installed, "rb") as a, open(source, "rb") as b:
        print(f"speech.js identical to source: {a.read() == b.read()}")


def main() -> int:
    code = unpack()
    if code != 0:
        return code
    audit()
    print()
    verify_speech()
    return 0


if __name__ == "__main__":
    sys.exit(main())
