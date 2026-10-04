"""Report what is filling the C drive, without deleting anything.

C: is at 100% with 119 MB free, and that is exactly why the model now dies: ``torch.load`` needs
scratch space on the system drive, and a full one makes the mmap behind ``load_tensor`` fail with an
access violation rather than a disk-full error. So the crash that looks like a broken pickle file
is really a full disk.

Nothing is removed here. Reporting the sizes and letting the user choose is the point — several
places this lists are caches that rebuild themselves, and a couple are not, and which is which is
not something to guess at from a size.
"""

from __future__ import annotations

import os
import shutil
import time

TARGETS = [
    r"C:\Users\digua\AppData\Local\Temp",
    r"C:\Users\digua\.workbuddy",
    r"C:\Users\digua\AppData\Local",
    r"C:\Users\digua\AppData\Roaming",
    r"C:\Users\digua\AppData\LocalLow",
    r"C:\Users\digua\Downloads",
    r"C:\Users\digua\Desktop",
]


def folder_size(path: str) -> int:
    total = 0
    for base, _directories, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(base, name))
            except OSError:
                pass
    return total


def report_disk() -> None:
    print("disks")
    for drive in ("C:\\", "D:\\"):
        usage = shutil.disk_usage(drive)
        print(f"  {drive} {usage.free / 2 ** 30:6.2f} GB free of {usage.total / 2 ** 30:.0f} GB "
              f"({usage.used / usage.total * 100:.0f}% used)")
    print()


def report_folders() -> None:
    print("folder sizes")
    for target in TARGETS:
        if not os.path.isdir(target):
            continue
        size = folder_size(target)
        print(f"  {size / 2 ** 30:6.2f} GB  {target}")
    print()


def report_temp_detail(limit: int = 20) -> None:
    """The Temp folder is the interesting one, so it is broken down rather than just totalled."""
    temp = r"C:\Users\digua\AppData\Local\Temp"
    if not os.path.isdir(temp):
        return
    print("largest entries in Temp")

    entries = []
    for name in os.listdir(temp):
        path = os.path.join(temp, name)
        try:
            size = os.path.getmtime(path), os.path.getsize(path) if os.path.isfile(path) else folder_size(path)
        except OSError:
            continue
        entries.append((size[1], name, size[0]))

    entries.sort(reverse=True)
    now = time.time()
    for size, name, modified in entries[:limit]:
        age_days = (now - modified) / 86400
        print(f"  {size / 2 ** 20:8.1f} MB  {age_days:6.1f} days old  {name[:60]}")

    stale = sum(size for size, _name, modified in entries if now - modified > 7 * 86400)
    total = sum(size for size, _n, _m in entries)
    print(f"\n  total {total / 2 ** 30:.2f} GB, of which {stale / 2 ** 30:.2f} GB is older than a week")
    print("  (nothing has been deleted — this is a report)")


def main() -> int:
    report_disk()
    report_folders()
    report_temp_detail()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
