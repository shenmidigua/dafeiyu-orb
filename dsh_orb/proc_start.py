"""Report when processes started, and find the ones that matter by image name.

The desktop's own tooling does not cooperate here: `tasklist.exe` prints nothing and a PowerShell
probe returns an empty stdout, so process information is read straight from the Win32 snapshot API.

Two questions this answers, which the install check cannot:

*   Did the helper that is running now start *before* or *after* the build it is supposed to be
    running? A helper older than the last install is still the previous build.
*   Is the read-aloud service actually resident?
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import re
import sys
from datetime import datetime

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.OpenProcess.restype = wintypes.HANDLE
k32.CloseHandle.argtypes = [wintypes.HANDLE]
k32.GetProcessTimes.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(wintypes.FILETIME),
    ctypes.POINTER(wintypes.FILETIME),
    ctypes.POINTER(wintypes.FILETIME),
    ctypes.POINTER(wintypes.FILETIME),
]

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
MAX_PATH = 260


class PROCESSENTRY32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD),
        ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD),
        ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD),
        ("szExeFile", ctypes.c_char * MAX_PATH),
    ]


def snapshot() -> list[tuple[int, int, str]]:
    """Every live process as (pid, parent pid, image name)."""
    k32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    handle = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if handle == INVALID_HANDLE_VALUE:
        return []
    rows: list[tuple[int, int, str]] = []
    entry = PROCESSENTRY32()
    entry.dwSize = ctypes.sizeof(entry)
    try:
        more = k32.Process32First(handle, ctypes.byref(entry))
        while more:
            name = entry.szExeFile.decode("mbcs", errors="replace")
            rows.append((entry.th32ProcessID, entry.th32ParentProcessID, name))
            more = k32.Process32Next(handle, ctypes.byref(entry))
    finally:
        k32.CloseHandle(handle)
    return rows


def started_at(pid: int) -> datetime | None:
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
    ok = k32.GetProcessTimes(
        handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel), ctypes.byref(user)
    )
    k32.CloseHandle(handle)
    if not ok:
        return None
    ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
    return datetime.fromtimestamp(ticks / 10_000_000 - 11644473600)


def describe(pid: int, role: str) -> None:
    start = started_at(pid)
    if start is None:
        print(f"  {pid:<8}{role:<30}(not running)")
        return
    elapsed = (datetime.now() - start).total_seconds()
    print(f"  {pid:<8}{role:<30}started {start:%Y-%m-%d %H:%M:%S}  ({elapsed / 60:.0f} min ago)")


def main(argv: list[str]) -> int:
    pattern = re.compile(argv[1] if len(argv) > 1 else r"python|electron|DeepSeek|node", re.I)
    rows = snapshot()
    print(f"{len(rows)} processes alive\n")

    print("running now:")
    interesting = [r for r in rows if pattern.search(r[2])]
    for pid, parent, name in sorted(interesting, key=lambda r: r[2].lower()):
        start = started_at(pid)
        stamp = f"{start:%H:%M:%S}" if start else "  ?   "
        print(f"  {pid:<8}parent={parent:<8}{stamp:<10}{name}")

    named = [arg for arg in argv[2:] if arg.isdigit()]
    if named:
        print("\nasked about:")
        for pid in named:
            describe(int(pid), "")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
