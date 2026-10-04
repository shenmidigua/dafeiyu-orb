"""Find out which process-creation flags keep a `cmd.exe -> python.exe` pair windowless.

The orb's helper starts its read-aloud service with `spawn(cmd.exe, ..., { detached: true,
windowsHide: true })` and a black window appears anyway. Reading the process table says why: the
console the user sees is owned by `conhost.exe` whose parent is the *python* process, not the cmd
one. A detached process is created without a console, so the console program started inside it
allocates one for itself — and a console allocated by the program itself is not covered by the
hide request that travelled with CreateProcess.

So the candidates are not "detached or not" but "does the child already have a console". Each
variant below starts the same `cmd.exe -> python.exe` pair for a few seconds and then asks Windows
whether any *visible top-level window* belongs to that process tree. A hidden console still has a
window object; `IsWindowVisible` is what separates "invisible" from "the user sees a black box".

Run: python window_flags_probe.py
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
import subprocess
import sys
import time

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
u32 = ctypes.WinDLL("user32", use_last_error=True)

DETACHED_PROCESS = 0x00000008
CREATE_NEW_CONSOLE = 0x00000010
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200

STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0
SW_SHOWNORMAL = 1

PYTHON = r"D:\tools\indextts\py311\python.exe"
CMD = r"C:\Windows\System32\cmd.exe"

# Stands in for start_server.cmd: a cmd that runs a console python which stays resident. `-c` keeps
# it self-contained so the probe never touches the real launcher or the real port.
#
# The whole inner command is wrapped in one more pair of quotes because `/s` strips the outermost
# ones and then takes the rest literally — without it cmd would see `python.exe" -c "…`, which is
# a syntax error and exits before python ever runs.
INNER = f'"{PYTHON}" -c "import time; time.sleep(6)"'
COMMAND = f'{CMD} /d /s /c "{INNER}"'


class STARTUPINFO(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("lpReserved", wintypes.LPWSTR),
        ("lpDesktop", wintypes.LPWSTR),
        ("lpTitle", wintypes.LPWSTR),
        ("dwX", wintypes.DWORD),
        ("dwY", wintypes.DWORD),
        ("dwXSize", wintypes.DWORD),
        ("dwYSize", wintypes.DWORD),
        ("dwXCountChars", wintypes.DWORD),
        ("dwYCountChars", wintypes.DWORD),
        ("dwFillAttribute", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("wShowWindow", wintypes.WORD),
        ("cbReserved2", wintypes.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wintypes.HANDLE),
        ("hStdOutput", wintypes.HANDLE),
        ("hStdError", wintypes.HANDLE),
    ]


def all_pids() -> set[int]:
    """Every live pid, so a window can be attributed to a tree by following parents."""
    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260),
        ]

    snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snap == -1:
        return set()
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        pid = 0
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            pid = pid + 1
            entry = PROCESSENTRY32()
            entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
            ok = k32.Process32Next(snap, ctypes.byref(entry))
        return set()
    finally:
        k32.CloseHandle(snap)


class INFO(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD), ("szExeFile", ctypes.c_char * 260),
    ]


def processes() -> dict[int, tuple[int, str]]:
    """pid -> (parent pid, exe name) for every process, via CreateToolhelp32Snapshot."""
    snap = k32.CreateToolhelp32Snapshot(0x00000002, 0)
    if snap == -1:
        return {}
    rows: dict[int, tuple[int, str]] = {}
    try:
        entry = INFO()
        entry.dwSize = ctypes.sizeof(INFO)
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            rows[entry.th32ProcessID] = (
                entry.th32ParentProcessID,
                entry.szExeFile.decode("gbk", errors="replace"),
            )
            entry = INFO()
            entry.dwSize = ctypes.sizeof(INFO)
            ok = k32.Process32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return rows


def descendants(root_pid: int, rows: dict[int, tuple[int, str]]) -> set[int]:
    """`root_pid` plus everything whose parent chain reaches it."""
    children: dict[int, list[int]] = {}
    for pid, (parent, _) in rows.items():
        children.setdefault(parent, []).append(pid)
    out, stack = set(), [root_pid]
    while stack:
        pid = stack.pop()
        if pid in out:
            continue
        out.add(pid)
        stack.extend(children.get(pid, []))
    return out


WNDENUMPROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def visible_windows_for(pids: set[int]) -> list[tuple[int, str, str]]:
    """Top-level windows belonging to `pids`, with their visibility and class name."""
    found: list[tuple[int, str, str]] = []

    def callback(hwnd, _lparam):
        pid = wintypes.DWORD()
        u32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in pids:
            return True
        length = u32.GetWindowTextLengthW(hwnd)
        title = ctypes.create_unicode_buffer(length + 1)
        u32.GetWindowTextW(hwnd, title, length + 1)
        klass = ctypes.create_unicode_buffer(256)
        u32.GetClassNameW(hwnd, klass, 256)
        visible = bool(u32.IsWindowVisible(hwnd))
        found.append((pid.value, klass.value, f"visible={visible} title={title.value!r}"))
        return True

    u32.EnumWindows(WNDENUMPROC(callback), 0)
    return found


def variant(name: str, creationflags: int, hidden_startupinfo: bool) -> None:
    startup = None
    if hidden_startupinfo:
        # `subprocess.STARTUPINFO` rather than a hand-rolled ctypes one: subprocess calls `.copy()`
        # on it before spawning, which a raw ctypes structure does not have.
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = subprocess.SW_HIDE

    before = processes()
    proc = subprocess.Popen(
        COMMAND,
        creationflags=creationflags,
        startupinfo=startup,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        time.sleep(1.6)                      # let cmd spawn python and the console settle
        after = processes()
        tree = descendants(proc.pid, after)
        conhosts = [p for p in tree if after.get(p, (0, ""))[1].lower() == "conhost.exe"]
        windows = visible_windows_for(tree)
        visible = [w for w in windows if "visible=True" in w[2]]

        print(f"\n--- {name} ---")
        print(f"  creationflags 0x{creationflags:08X}  startupinfo={'SW_HIDE' if hidden_startupinfo else 'none'}")
        print(f"  tree          {sorted(tree)}")
        print(f"  conhost       {conhosts}")
        print(f"  windows       {len(windows)} total, {len(visible)} visible")
        for w in windows:
            print(f"    pid={w[0]} class={w[1]} {w[2]}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.6)


def main() -> int:
    print(f"parent console: {k32.GetConsoleWindow()}")
    for name, flags, si in [
        ("A. detached  (what the helper does now)", DETACHED_PROCESS, False),
        ("B. windowsHide (STARTF_USESHOWWINDOW + SW_HIDE), no detach", 0, True),
        ("C. CREATE_NO_WINDOW", CREATE_NO_WINDOW, False),
        ("D. CREATE_NEW_CONSOLE + SW_HIDE", CREATE_NEW_CONSOLE, True),
    ]:
        variant(name, flags, si)
    return 0


if __name__ == "__main__":
    sys.exit(main())
