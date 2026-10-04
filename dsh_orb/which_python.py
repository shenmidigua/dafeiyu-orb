"""List every python/wscript/cmd process and the full path behind it.

The service log shows three separate "starting milora_server" lines and a service that answers on
8765, which would mean more than one process bound the same port. Windows lets that happen when
SO_REUSEADDR is set (`HTTPServer.allow_reuse_address` is 1), and the later binder wins new
connections — so "which process answers" becomes a coin toss. This finds out whether that is the
state the machine is actually in.

`tasklist.exe` prints nothing in this sandbox, so the process list comes from
CreateToolhelp32Snapshot, and each image path from QueryFullProcessImageName (pid -> handle ->
path). Start times come from GetProcessTimes so the instances can be ordered.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import datetime
import sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

TH32CS_SNAPPROCESS = 0x00000002
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
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


class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD), ("dwHighDateTime", wintypes.DWORD)]


def snapshot() -> list[PROCESSENTRY32]:
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == -1:
        raise OSError("CreateToolhelp32Snapshot failed")
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        found = []
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            found.append(entry)
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = k32.Process32Next(snap, ctypes.byref(entry))
        return found
    finally:
        k32.CloseHandle(snap)


def image_path(pid: int) -> str:
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(MAX_PATH)
        buffer = ctypes.create_unicode_buffer(MAX_PATH * 4)
        size.value = len(buffer)
        if k32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        k32.CloseHandle(handle)


def start_time(pid: int) -> str:
    handle = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return "?"
    try:
        created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        if not k32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                   ctypes.byref(kernel), ctypes.byref(user)):
            return "?"
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        # FILETIME is 100 ns ticks since 1601-01-01.
        epoch = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=ticks // 10)
        return epoch.strftime("%H:%M:%S")
    finally:
        k32.CloseHandle(handle)


INTERESTING = ("python", "pythonw", "wscript", "cmd.exe", "conhost")


def main() -> int:
    rows = []
    for entry in snapshot():
        name = entry.szExeFile.decode("gbk", errors="replace")
        if not any(key in name.lower() for key in INTERESTING):
            continue
        pid = entry.th32ProcessID
        rows.append((start_time(pid), pid, entry.th32ParentProcessID, name, image_path(pid)))

    rows.sort()
    print(f"{'started':>8}  {'pid':>6}  {'ppid':>6}  {'image':<14} path")
    for started, pid, ppid, name, path in rows:
        print(f"{started:>8}  {pid:>6}  {ppid:>6}  {name:<14} {path}")

    python_rows = [r for r in rows if "python" in r[3].lower()]
    print(f"\npython processes: {len(python_rows)}")
    print(f"cmd processes:    {len([r for r in rows if r[3].lower() == 'cmd.exe'])}")
    print(f"conhost processes:{len([r for r in rows if r[3].lower() == 'conhost.exe'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
