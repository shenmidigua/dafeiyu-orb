"""Stop a fake-host helper without touching the real one DSH is running.

Both are `electron.exe` from the same runtime directory, so they cannot be told apart by name.
They differ by parent: the real helper's parent is `DeepSeek Harness.exe`, while fake-host's is
`node.exe`. Killing every `electron.exe` (which is the obvious move) takes the live ball down with
it — so this only ever targets the node.exe children.
"""
import ctypes
import ctypes.wintypes as wintypes
import subprocess
import sys

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
TH32CS_SNAPPROCESS = 0x2


class PE(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]


def snapshot():
    h = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    pe = PE()
    pe.dwSize = ctypes.sizeof(PE)
    out = []
    if k32.Process32FirstW(h, ctypes.byref(pe)):
        while True:
            out.append((pe.th32ProcessID, pe.th32ParentProcessID, pe.szExeFile))
            if not k32.Process32NextW(h, ctypes.byref(pe)):
                break
    k32.CloseHandle(h)
    return out


def main() -> int:
    procs = snapshot()
    node_pids = {pid for pid, _, name in procs if name.lower() == "node.exe"}
    if not node_pids:
        print("no node.exe running - nothing to do")
        return 0

    # Electrodes whose parent is a node process, plus their own descendants.
    targets = set()
    changed = True
    while changed:
        changed = False
        for pid, ppid, name in procs:
            if name.lower() != "electron.exe" or pid in targets:
                continue
            if ppid in node_pids or ppid in targets:
                targets.add(pid)
                changed = True

    if not targets:
        print(f"no fake-host electron found (node.exe pids: {sorted(node_pids)})")
        return 0

    print(f"node.exe pids : {sorted(node_pids)}")
    print(f"killing       : {sorted(targets)}")
    for pid in sorted(targets):
        r = subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        print(f"  {pid} -> exit {r.returncode}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
