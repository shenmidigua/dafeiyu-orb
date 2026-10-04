"""List entries inside an Electron asar archive, filtered.

An asar is a small pickled header followed by the file blobs. The header is a JSON directory
tree, so the whole listing costs one read of the first few hundred KB even for a 121 MB archive.

Usage: `asar_ls.py <archive> [substring ...]`
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def read_header(path: Path) -> dict:
    with path.open("rb") as fh:
        head = fh.read(16)
        # 4 bytes: 4 (size of the next two uint32s), then pickle header size, json size, json len
        _, header_size, json_size, json_len = struct.unpack("<IIII", head)
        raw = fh.read(json_len)
    return json.loads(raw.decode("utf8"))


def walk(node: dict, prefix: str, out: list[tuple[str, int]]) -> None:
    for name, entry in node.get("files", {}).items():
        full = f"{prefix}/{name}" if prefix else name
        if "files" in entry:
            walk(entry, full, out)
        else:
            out.append((full, int(entry.get("size", 0))))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: asar_ls.py <archive> [substring ...]")
        return 2
    archive = Path(sys.argv[1])
    needles = [n.lower() for n in sys.argv[2:]]

    header = read_header(archive)
    files: list[tuple[str, int]] = []
    walk(header, "", files)

    if not needles:
        print(f"{len(files)} entries")
        for f, s in files[:200]:
            print(f"{s:>12}  {f}")
        return 0

    hits = [(f, s) for f, s in files if any(n in f.lower() for n in needles)]
    print(f"{len(hits)} of {len(files)} entries match {needles}")
    for f, s in sorted(hits):
        print(f"{s:>12}  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
