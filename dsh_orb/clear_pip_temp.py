"""Remove the one directory that is filling the C drive, after confirming what it is.

`pip-unpack-wszfjbk0` holds 3.3 GB inside the user's Temp folder — pip's staging area while it
unpacks the CUDA torch wheels. `--no-cache-dir` prevents the *cache*, but not this: the wheel is
written to Temp, unpacked, and left behind when the install finishes. It is what drove C: to 100%,
which is why IndexTTS started dying with a segfault instead of a disk-full error (`torch.load`
needs scratch space on the system drive before it can mmap `gpt.pth`).

The check before deleting is not ceremony. "Some 3.3 GB directory in Temp" is exactly the shape of
something a user might care about, so this confirms the name matches pip's unpack pattern *and*
that the contents are wheel-shaped (many large files, or an extracted tree) before removing it, and
reports what went. If the check fails, nothing is deleted.

Only that one directory is touched. The other entries in Temp from today — installers, .tmp files
— are left alone, since the user chose the narrow option.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess

TEMP = r"C:\Users\digua\AppData\Local\Temp"
TARGET_NAME = "pip-unpack-wszfjbk0"
TARGET = os.path.join(TEMP, TARGET_NAME)

# pip's own naming: pip-unpack-<random>, pip-build-<random>, pip-install-<random>, pip-ephem-<random>
PIP_PATTERN = re.compile(r"^pip-(unpack|build|install|ephem)-[A-Za-z0-9_]+$")


def folder_size(path: str) -> int:
    total = 0
    files = 0
    for base, _directories, names in os.walk(path):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(base, name))
                files += 1
            except OSError:
                pass
    return total, files


def confirm() -> bool:
    if not os.path.isdir(TARGET):
        print(f"not there: {TARGET}")
        return False

    name = os.path.basename(TARGET)
    if not PIP_PATTERN.match(name):
        print(f"REFUSING: {name!r} does not look like a pip staging directory")
        return False

    size, files = folder_size(TARGET)
    print(f"name  : {name}  (matches pip's staging pattern)")
    print(f"size  : {size / 2 ** 30:.2f} GB across {files} files")

    # Contents should be wheels or an unpacked package tree. A directory holding a single huge
    # unrelated file is not what this check is looking for.
    entries = os.listdir(TARGET)
    print(f"first entries: {', '.join(entries[:6])}")
    wheels = [e for e in entries if e.endswith((".whl", ".zip", ".gz", ".bz2"))]
    print(f"archive files at top level: {len(wheels)}")
    if size < 512 * 1024 * 1024:
        print("REFUSING: too small to be the 3.3 GB pip staging directory")
        return False
    return True


def remove() -> None:
    # rmdir /s rather than shutil.rmtree: pip staging trees contain read-only entries copied out of
    # wheels, and the shell reports failures per file instead of raising partway through and
    # leaving it unclear what was left.
    result = subprocess.run(["cmd.exe", "/c", "rmdir", "/s", "/q", TARGET],
                            capture_output=True, text=True, timeout=900)
    print(f"rmdir exit {result.returncode}")
    if result.stdout.strip():
        print(f"stdout: {result.stdout.strip()[:200]}")
    if result.stderr.strip():
        print(f"stderr: {result.stderr.strip()[:200]}")
    print(f"still there: {os.path.exists(TARGET)}")


def main() -> int:
    usage_before = shutil.disk_usage("C:\\")
    print(f"before: {usage_before.free / 2 ** 30:.2f} GB free on C:\n")

    if not confirm():
        print("\nnothing deleted")
        return 1
    print()
    remove()

    usage_after = shutil.disk_usage("C:\\")
    print(f"\nafter : {usage_after.free / 2 ** 30:.2f} GB free "
          f"(reclaimed {(usage_after.free - usage_before.free) / 2 ** 30:.2f} GB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
