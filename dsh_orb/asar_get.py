"""Extract one file out of an Electron asar archive.

`asar_ls.py` answers "what is in there"; this answers "what does it say". An asar is a JSON directory
tree whose entries carry byte offsets into the blob section that follows the header, so extraction is
a header read plus one seek — no need to unpack 121 MB to look at one file.

Usage: `asar_get.py <archive> <entry-path> [out-file]`

With no `out-file` the file is written next to the archive under `_asar_get/`, keeping the entry's
own directory shape so it stays obvious what came from where.
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path


def read_index(archive: Path) -> tuple[dict, int]:
    """The archive's directory tree, and the offset its file blobs start at."""
    with archive.open("rb") as handle:
        head = handle.read(16)
        _, header_size, _json_size, json_len = struct.unpack("<IIII", head)
        raw = handle.read(json_len)
    return json.loads(raw.decode("utf8")), 8 + header_size


def find(node: dict, parts: list[str]) -> dict | None:
    for part in parts:
        node = node.get("files", {}).get(part, {})  # type: ignore[assignment]
        if not node:
            return None
    return node


def main() -> int:
    if len(sys.argv) not in {3, 4}:
        print(__doc__)
        return 2
    archive = Path(sys.argv[1])
    entry = sys.argv[2].replace("\\", "/").strip("/")
    if not archive.is_file():
        print(f"FAIL: {archive} is not a file")
        return 1

    index, data_start = read_index(archive)
    node = find(index, entry.split("/"))
    if node is None or "offset" not in node:
        print(f"FAIL: {entry} is not a file in {archive.name}")
        return 1

    size = int(node["size"])
    offset = data_start + int(node["offset"])
    with archive.open("rb") as handle:
        handle.seek(offset)
        body = handle.read(size)

    destination = Path(sys.argv[3]) if len(sys.argv) == 4 else (
        Path(__file__).parent / "_asar_get" / entry.replace("/", "_"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(body)
    print(f"{entry} -> {destination} ({size:,} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
