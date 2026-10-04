"""Restart explorer.exe to free the 7.64 GB it is holding.

Explorer is using two processes and 7.64 GB, which is two orders of magnitude more than it should —
its thumbnail and icon caches have grown without bound, most likely from this session creating and
copying a lot of media files. That is what is starving the IndexTTS load, not the 3 GB weight file.

Restarting rather than logging off keeps everything else running: the taskbar flickers and the
desktop icons reload, but open applications are untouched. `taskkill` on explorer is what makes
Windows start a fresh copy, so killing is the mechanism rather than an unfortunate side effect.

The restart is verified by process state afterwards, not by the command's return value — the same
rule the DSH launcher follows, since both have been observed reporting success without the process
actually coming back.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import subprocess
import time

EXPLORER = "explorer.exe"


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


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)


def explorer_processes() -> list[tuple[str, int, int]]:
    """Return (name, pid, working-set bytes) for every explorer process."""
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == -1:
        return []
    found = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return []
        while True:
            if entry.szExeFile.lower() == EXPLORER:
                handle = kernel32.OpenProcess(0x0400 | 0x0010, False, int(entry.th32ProcessID))
                if handle:
                    counters = _Counters()
                    counters.cb = ctypes.sizeof(_Counters)
                    size = (psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
                            and counters.WorkingSetSize) or 0
                    kernel32.CloseHandle(handle)
                    found.append((entry.szExeFile, int(entry.th32ProcessID), size))
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def free_memory() -> tuple[float, float]:
    class _Status(ctypes.Structure):
        _fields_ = [
            ("dwLength", wintypes.DWORD),
            ("dwMemoryLoad", wintypes.DWORD),
            ("ullTotalPhys", ctypes.c_size_t),
            ("ullAvailPhys", ctypes.c_size_t),
            ("ullTotalPageFile", ctypes.c_size_t),
            ("ullAvailPageFile", ctypes.c_size_t),
            ("ullTotalVirtual", ctypes.c_size_t),
            ("ullAvailVirtual", ctypes.c_size_t),
            ("ullAvailExtendedVirtual", ctypes.c_size_t),
        ]

    status = _Status()
    status.dwLength = ctypes.sizeof(_Status)
    kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    return status.ullAvailPhys / 2 ** 30, status.dwMemoryLoad


def main() -> int:
    before = explorer_processes()
    print("before:")
    total = 0
    for name, pid, size in before:
        total += size
        print(f"  pid {pid:6}  {size / 2 ** 30:5.2f} GB")
    print(f"  total {total / 2 ** 30:.2f} GB in {len(before)} processes")

    available, load = free_memory()
    print(f"  RAM {available:.2f} GB free ({load}% used)\n")

    if not before:
        print("no explorer process found — nothing to restart")
        return 1

    # Note the single slashes. The doubled form `//F` is only needed when the command text passes
    # through an MSYS shell, which rewrites a leading `/F` into a drive path. Here the arguments go
    # straight to the executable with no shell in between, so `//F` is taken literally and taskkill
    # rejects it: "无效参数/选项 - '//F'". Single slashes are correct for a direct call.
    #
    # Output is captured as bytes rather than text: this is a Chinese Windows, so taskkill writes
    # GBK, and asking Python to decode that as UTF-8 raises inside the reader thread before the
    # result is ever parsed.
    result = subprocess.run(["taskkill.exe", "/F", "/IM", EXPLORER],
                            capture_output=True, timeout=120)
    print(f"taskkill exit {result.returncode}")
    for label, blob in (("stdout", result.stdout), ("stderr", result.stderr)):
        if blob:
            print(f"  {label}: {blob.decode('gbk', errors='replace').strip()[:200]}")

    # Give Windows a moment to spawn the replacement, then check rather than assume.
    for attempt in range(10):
        time.sleep(2)
        after = explorer_processes()
        if after and all(pid not in {p for _n, p, _s in before} for _n, p, _s in after):
            print(f"\nexplorer came back after {attempt * 2 + 2}s")
            break
    else:
        after = explorer_processes()

    print("\nafter:")
    total = 0
    for name, pid, size in after:
        total += size
        print(f"  pid {pid:6}  {size / 2 ** 30:5.2f} GB")
    print(f"  total {total / 2 ** 30:.2f} GB in {len(after)} processes")

    available, load = free_memory()
    print(f"\nRAM {available:.2f} GB free ({load}% used)")
    return 0 if after else 1


if __name__ == "__main__":
    raise SystemExit(main())
