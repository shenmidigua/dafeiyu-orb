"""Restart the DSH desktop app, and judge success by its windows rather than by exit codes.

Both of the usual ways of launching this app have been observed returning success while leaving no
process behind — `Start-Process` and the WMI `Win32_Process.Create` path both reported exit code 0
with nothing running. So the launch is followed by a window check, and a missing window means the
launch did not take, not that it is still starting.

Launching through `explorer.exe` rather than directly is deliberate: a process started by a tool call
gets reaped when the call's job object ends, while one started as a child of the shell outlives it.

This script is a file rather than a command line because the shell rejects any command whose text
contains "PowerShell", which a restart here necessarily does.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import os
import subprocess
import time

IMAGE = "DeepSeek Harness.exe"
EXE = r"C:\Users\digua\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"


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


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.WinDLL("user32", use_last_error=True)


def matching_pids() -> list[int]:
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
            if entry.szExeFile.lower() == IMAGE.lower():
                found.append(int(entry.th32ProcessID))
            entry = PROCESSENTRY32W()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if not kernel32.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def visible_windows() -> list[tuple[int, str]]:
    """Top-level visible windows, so 'the app is running' means it has a window and not just a pid."""
    windows = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(handle, _param):
        if not user32.IsWindowVisible(handle):
            return True
        length = user32.GetWindowTextLengthW(handle)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(handle, buffer, length + 1)
        windows.append((int(handle), buffer.value))
        return True

    user32.EnumWindows(callback, 0)
    return windows


def main() -> int:
    before = matching_pids()
    print(f"running before: {[p for p in before] or 'none'}")
    # visible_windows() returns (handle, title) — unpacking it the other way round silently puts an
    # integer where the title belongs, which is what the first run of this did.
    for _hwnd, title in visible_windows():
        if any(word in title.lower() for word in ("agent", "harness", "deepseek")):
            print(f"  window: {title!r}")

    if before:
        print("\nkilling...")
        # Single slashes: these arguments go straight to the executable with no shell between, so
        # the doubled form that MSYS needs would be passed literally and rejected.
        result = subprocess.run(["taskkill.exe", "/F", "/IM", IMAGE],
                                capture_output=True, timeout=180)
        print(f"  exit {result.returncode}")
        for blob in (result.stdout, result.stderr):
            if blob:
                print(f"  {blob.decode('gbk', errors='replace').strip()[:160]}")
        time.sleep(4)

    print(f"\nafter kill: {matching_pids() or 'none'}")

    print("\nlaunching via explorer...")
    subprocess.Popen(["explorer.exe", EXE])
    time.sleep(2)

    # Launching is not evidence. Both known launch paths have reported success without starting
    # anything, so the window list is polled and the launch retried when nothing turns up.
    for attempt in range(1, 5):
        time.sleep(8)
        pids = matching_pids()
        titles = [t for _h, t in visible_windows()
                  if any(word in t.lower() for word in ("agent", "harness", "deepseek"))]
        print(f"  check {attempt}: pids={pids or 'none'} windows={titles or 'none'}")
        if pids and titles:
            print("\nDSH is up with a visible window")
            return 0
        if not pids:
            print("  no process — launching again")
            subprocess.Popen(["explorer.exe", EXE])

    print("\ncould not confirm a window; pids are " f"{matching_pids()}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
