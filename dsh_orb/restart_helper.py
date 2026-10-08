"""Restart the orb helper so its page loads the just-installed assets, and prove it came back.

The helper's page is only read at startup — `main.ts` calls `win.loadFile('floating.html')` once, when
the window is created — so a file copied into the installed profile does nothing until the helper is
respawned. The DSH host does the respawning itself (`orb.ts`: a helper that exits is relaunched after
500 ms, up to three failures inside a minute), which makes "kill the helper" the whole of the action
here: nothing has to relaunch it by hand, and a helper that stays down is a failure this script reports
rather than hides.

Everything is read through Win32 rather than a shell: the harness session has no `powershell` on its
PATH (only `pwsh`), and a helper that reports "command not found" is worse than no helper at all. So the
command lines come out of the target process's own PEB and the start times out of `GetProcessTimes`.

What is checked afterwards:

  * the helper's main process exists again, and its process creation time is later than the kill;
  * it owns at least one top-level window whose title is empty and whose box is ball-or-strip sized —
    the ball's own frameless window, not a panel left open.

Usage: `restart_helper.py [--dry]`
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

HOME = None  # set below, after the imports that need nothing from the user's profile
HELPER_MAIN = "dsh-orb"
PROFILE_MARK = "helper-data"

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll", use_last_error=True)

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
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


class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p),
        ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2", ctypes.c_void_p * 2),
        ("UniqueProcessId", ctypes.c_void_p),
        ("Reserved3", ctypes.c_void_p),
    ]


def _read(handle: int, address: int, size: int) -> bytes:
    buffer = ctypes.create_string_buffer(size)
    read = ctypes.c_size_t(0)
    ok = kernel32.ReadProcessMemory(handle, ctypes.c_void_p(address), buffer,
                                    ctypes.c_size_t(size), ctypes.byref(read))
    if not ok:
        raise OSError(f"ReadProcessMemory failed at 0x{address:x} ({ctypes.get_last_error()})")
    return buffer.raw[: read.value]


def _pointer(blob: bytes, offset: int) -> int:
    return int.from_bytes(blob[offset:offset + 8], "little")


def command_line_of(pid: int) -> str | None:
    """The target process's own command line, out of its PEB. `None` when it cannot be read."""
    # Only 64-bit targets: this helper, the ball's Electron, and the probes are all x64 here, and the
    # PEB offsets used below are the 64-bit ones.
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return None
    try:
        info = PROCESS_BASIC_INFORMATION()
        returned = ctypes.c_ulong(0)
        status = ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(info),
                                                 ctypes.sizeof(info), ctypes.byref(returned))
        if status != 0 or not info.PebBaseAddress:
            return None
        peeked = _read(handle, info.PebBaseAddress + 0x20, 8)
        params = _pointer(peeked, 0)
        if not params:
            return None
        # RTL_USER_PROCESS_PARAMETERS, x64: Length/MaximumLength at +0x00, then Flags, DebugFlags,
        # ConsoleHandle, ConsoleFlags, StandardInput/Output/Error, CurrentDirectory (CURDIR, 0x20 bytes)
        # and DllPath before the command line — which puts the UNICODE_STRING CommandLine at +0x70.
        head = _read(handle, params + 0x70, 16)
        length = int.from_bytes(head[0:2], "little")
        buffer = _pointer(head, 8)
        if length == 0 or not buffer:
            return None
        return _read(handle, buffer, length).decode("utf-16-le", "replace")
    except OSError:
        return None
    finally:
        kernel32.CloseHandle(handle)


def started_at(pid: int) -> datetime | None:
    """Process creation time, as a local `datetime`."""
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return None
    try:
        created, exited, kernel, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited),
                                        ctypes.byref(kernel), ctypes.byref(user)):
            return None
        ticks = (created.dwHighDateTime << 32) | created.dwLowDateTime
        # FILETIME counts 100 ns intervals from 1601-01-01 UTC.
        return datetime(1601, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=ticks / 10)
    finally:
        kernel32.CloseHandle(handle)


def helpers() -> list[tuple[int, str, datetime | None]]:
    """The helper's main process only: `(pid, command line, started)`.

    The helper is several processes — main, GPU, renderers, network, audio — and they are told apart by
    their own command lines: only the main one names the helper's `main.js` and carries no `--type=`
    role. That is read from each process rather than inferred from the process list, so a second helper
    (a probe, or a restart in flight) is included rather than confused with this one.
    """
    found: list[tuple[int, str, datetime | None]] = []
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snapshot == -1:
        return found
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
            return found
        while True:
            if entry.szExeFile.lower() == "electron.exe":
                pid = int(entry.th32ProcessID)
                line = command_line_of(pid) or ""
                if PROFILE_MARK in line and HELPER_MAIN in line and "--type=" not in line:
                    found.append((pid, line, started_at(pid)))
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def main_windows(pids: set[int]) -> list[tuple[int, str, tuple[int, int, int, int]]]:
    """Top-level windows owned by `pids`: `(handle, title, (x, y, w, h))`."""
    windows: list[tuple[int, str, tuple[int, int, int, int]]] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(handle, _param):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if int(owner.value) not in pids:
            return True
        length = user32.GetWindowTextLengthW(handle)
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, buffer, length + 1)
        rect = wintypes.RECT()
        user32.GetWindowRect(handle, ctypes.byref(rect))
        windows.append((int(handle), buffer.value,
                        (rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top)))
        return True

    user32.EnumWindows(callback, 0)
    return windows


def describe_electron() -> None:
    """Every electron.exe, with what could be read out of it — for when `helpers()` finds nothing."""
    snapshot = kernel32.CreateToolhelp32Snapshot(0x00000002, 0)
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
    if not kernel32.Process32FirstW(snapshot, ctypes.byref(entry)):
        print("no processes could be listed")
        return
    while True:
        if entry.szExeFile.lower() == "electron.exe":
            pid = int(entry.th32ProcessID)
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
            line = command_line_of(pid)
            print(f"pid {pid:6d}  open={'yes' if handle else 'NO'}  cmdline={line!r}")
            if handle:
                kernel32.CloseHandle(handle)
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
            break
    kernel32.CloseHandle(snapshot)


def main() -> int:
    dry = "--dry" in sys.argv
    if "--debug" in sys.argv:
        describe_electron()
        return 0
    before = helpers()
    for pid, _line, started in before:
        print(f"helper main process: pid {pid}, started {started}")
    if not before:
        print("FAIL: no helper is running, so there is nothing to reload")
        return 1
    if len(before) > 1:
        print(f"note: {len(before)} helper main processes are running; all of them are restarted")

    killed_at = datetime.now(timezone.utc)
    if dry:
        print("--dry: not killing anything; the checks below are the ones that would run")
    else:
        for pid, _line, _started in before:
            print(f"killing helper pid {pid} (the host relaunches it within 500 ms)")
            subprocess.run(["taskkill.exe", "/F", "/PID", str(pid)], capture_output=True)

    after: list[tuple[int, str, datetime | None]] = []
    for attempt in range(1, 16):
        time.sleep(1)
        after = helpers()
        if after:
            break
        print(f"  waiting for the respawn ({attempt}s)")

    if not after:
        print("FAIL: the helper never came back — restart DSH, or toggle the orb off and on")
        return 1

    for pid, _line, started in after:
        print(f"helper is back: pid {pid}, started {started}")
    fresh = [item for item in after if item[2] is not None and item[2] > killed_at - timedelta(seconds=2)]
    if not dry and not fresh:
        print("FAIL: the running helper predates the kill, so the new page cannot be loaded")
        return 1

    time.sleep(4)
    pids = {pid for pid, _line, _started in after}
    windows = main_windows(pids)
    for _handle, title, box in windows:
        print(f"  window {title!r} {box}")
    ball = [item for item in windows if item[1] == "" and item[2][2] <= 800 and item[2][3] <= 288]
    if not ball:
        print("FAIL: no ball-sized untitled window — the orb is hidden, or the page did not load")
        return 1
    print(f"ok    the ball's own window is up at {ball[0][2][0]},{ball[0][2][1]} "
          f"{ball[0][2][2]}x{ball[0][2][3]}, so the reloaded page is live")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
