"""Enumerate process memory through the Windows API, because tasklist returns nothing here.

``tasklist`` produces no output in this sandbox regardless of format flags — verified directly, not
assumed — so it is useless for finding what is holding 29 GB. The same information is available
through Toolhelp32 and, for working set, GetProcessMemoryInfo, both of which work from ctypes.

Working set per *image name* is summed rather than per PID. A hundred renderer processes of one
Electron app are a single problem, and grouping by name is what makes that visible; listing PIDs
would bury it under noise.

``GetProcessMemoryInfo`` needs PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, which can fail for
protected processes. Those are skipped rather than aborting the report, and the count of skips is
printed so a partial picture is not mistaken for a complete one.

Nothing is terminated. This reports only.
"""

from __future__ import annotations

import ctypes
from ctypes import wintypes

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class PROCESSENTRY32W(ctypes.Structure):
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
        ("szExeFile", wintypes.WCHAR * 260),
    ]


class _Counters(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def working_set(pid: int) -> int:
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return 0
    try:
        counters = _Counters()
        counters.cb = ctypes.sizeof(_Counters)
        if not psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
            return 0
        return counters.WorkingSetSize
    finally:
        kernel32.CloseHandle(handle)


def enumerate_processes() -> list[tuple[str, int]]:
    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == -1:
        return []
    found = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        while True:
            found.append((entry.szExeFile, int(entry.th32ProcessID)))
            entry = PROCESSENTRY32W()          # reset: Process32NextW does not clear the struct
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def main() -> int:
    processes = enumerate_processes()
    print(f"enumerated {len(processes)} processes\n")

    grouped: dict[str, float] = {}
    counts: dict[str, int] = {}
    skipped = 0
    for name, pid in processes:
        size = working_set(pid)
        if size == 0:
            skipped += 1
            continue
        grouped[name] = grouped.get(name, 0.0) + size
        counts[name] = counts.get(name, 0) + 1

    print(f"{'image':40} {'n':>4} {'working set':>12}")
    for name, size in sorted(grouped.items(), key=lambda item: -item[1]):
        if size < 100 * 1024 * 1024:
            continue
        print(f"{name[:40]:40} {counts[name]:4} {size / 2 ** 30:9.2f} GB")

    print(f"\ntotal measured {sum(grouped.values()) / 2 ** 30:.2f} GB"
          f"   (skipped {skipped} of {len(processes)} — no access)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
