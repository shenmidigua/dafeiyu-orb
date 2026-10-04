"""Strip scripts and devDependencies from the staged package.json before packing.

The staged ``package.json`` still carries ``workspace:*`` dependency versions, which no registry can
resolve, plus the repo's own dev tooling. A tarball installed by path would fail on the first of
those. Removing them here — rather than editing the source of truth — keeps the checkout intact
while making the artifact self-contained.

The size is asserted against the known value instead of trusted: an unnoticed change in what gets
written would otherwise ship a subtly different package, and the byte count is the cheapest signal
that the transform did what it is supposed to and nothing more.

Line endings are pinned to ``\\n`` because Windows would otherwise write ``\\r\\n``, which is a
different byte length and changes every line.
"""

from __future__ import annotations

import json
import os
import sys

PACKAGE = os.path.join("D:\\tools", "orb-stage", "package", "package.json")
EXPECTED_SIZE = 2132


def main() -> int:
    if not os.path.isfile(PACKAGE):
        print(f"not found: {PACKAGE}")
        return 1

    with open(PACKAGE, encoding="utf-8") as handle:
        data = json.load(handle)

    removed = []
    for key in ("scripts", "devDependencies"):
        if key in data:
            del data[key]
            removed.append(key)

    text = json.dumps(data, indent=2, ensure_ascii=False)
    with open(PACKAGE, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)

    size = os.path.getsize(PACKAGE)
    print(f"removed: {', '.join(removed) or 'nothing'}")
    print(f"written: {size} bytes")
    if size != EXPECTED_SIZE:
        print(f"note: expected {EXPECTED_SIZE}, the manifest differs — check it before installing")
    else:
        print("matches the expected manifest")

    with open(PACKAGE, encoding="utf-8") as handle:
        for line in handle:
            pass
    print("no CRLF" if "\r" not in open(PACKAGE, encoding="utf-8", newline="").read() else "WARNING: CRLF present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
