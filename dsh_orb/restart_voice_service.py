"""Start the read-aloud service on 8765, the way the orb's helper starts it, and prove no window appeared.

Two jobs, both about the same thing: what happens when the ball decides it needs a voice service.

The first is the plain one — stop whatever holds the port and bring the current engine up, so the
thing under test is the thing just written rather than whatever was left running an hour ago. The
interpreter is started with `CREATE_NO_WINDOW` here, which is the flag measured to produce no window
at all (`window_flags_probe.py`, variant C).

The second is the one that matters for the real path. The helper does not use `CREATE_NO_WINDOW`; it
hands `cmd.exe` the launcher and asks Windows to hide it (`windowsHide: true`, no `detached`), which
is variant B in that same probe. So `--via-launcher` reproduces those exact flags, spawns through the
`.cmd` file the helper points at, and then counts the visible console windows that appeared. That
combination — the real launcher, the real flags, a window census — is the only way to check the
launcher change without clicking anything.

Usage:
    restart_voice_service.py                    stop 8765, start the engine directly, quiet
    restart_voice_service.py --keep             stop it and start nothing
    restart_voice_service.py --via-launcher     stop it, start it through the helper's launcher, census
    restart_voice_service.py --script PATH      use a different server script
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as wintypes
import json
import pathlib
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

CREATE_NO_WINDOW = 0x08000000
STARTF_USESHOWWINDOW = 0x00000001
SW_HIDE = 0

PYTHON = r"D:\tools\indextts\py311\python.exe"
DEFAULT_SCRIPT = r"D:\tools\edgetts\edge_server.py"
# The file DSH_ORB_TTS_LAUNCH resolves to, which is the switch between engines.
LAUNCHER = r"D:\tools\indextts\start_server.cmd"
PORT = 8765

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
user32 = ctypes.windll.user32

# `&` and angle brackets are the interesting case: the orb reads chat replies back, and one of these
# left unescaped makes the request malformed, so the far side answers with silence instead of an
# error anybody can act on.
TRICKY = "按钮叫“朗读” & 这句里有 <尖括号> 和 & 符号，应该照常读出来。"


class PE(ctypes.Structure):
    _fields_ = [
        ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
        ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
    ]


def processes() -> list[tuple[int, int, str]]:
    snap = k32.CreateToolhelp32Snapshot(0x2, 0)
    entry = PE()
    entry.dwSize = ctypes.sizeof(PE)
    out: list[tuple[int, int, str]] = []
    if k32.Process32FirstW(snap, ctypes.byref(entry)):
        while True:
            out.append((entry.th32ProcessID, entry.th32ParentProcessID, entry.szExeFile))
            if not k32.Process32NextW(snap, ctypes.byref(entry)):
                break
    k32.CloseHandle(snap)
    return out


def image_path(pid: int) -> str:
    handle = k32.OpenProcess(0x1000, False, pid)
    if not handle:
        return ""
    try:
        size = wintypes.DWORD(1024)
        buffer = ctypes.create_unicode_buffer(1024)
        if k32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
            return buffer.value
        return ""
    finally:
        k32.CloseHandle(handle)


def port_busy() -> bool:
    probe = socket.socket()
    probe.settimeout(1)
    try:
        probe.connect(("127.0.0.1", PORT))
        return True
    except OSError:
        return False
    finally:
        probe.close()


def taskkill(pid: int) -> str:
    # A single slash: this goes straight to CreateProcess, not through MSYS, which is the only place
    # `//F` is needed. The output is GBK on a Chinese Windows, so it is decoded as such rather than
    # as utf-8, which is what `text=True` would assume.
    done = subprocess.run(["taskkill.exe", "/F", "/PID", str(pid)],
                          capture_output=True, creationflags=CREATE_NO_WINDOW)
    return done.stdout.decode("gbk", errors="replace").strip() or \
        done.stderr.decode("gbk", errors="replace").strip()


def stop_service() -> None:
    """Kill only the process running the proxy, by pid.

    Not `taskkill /IM python.exe`: two other python processes on this machine belong to the tool
    runtime, and that would take them with it. The test is the interpreter's path, which is unique to
    the voice tree.
    """
    victims = []
    for pid, _ppid, name in processes():
        if name.lower() not in ("python.exe", "pythonw.exe"):
            continue
        path = image_path(pid)
        if "py311" not in path and "\\tools\\" not in path:
            continue
        victims.append((pid, name, path))

    if not victims:
        print("nothing running the service")
    for pid, name, path in victims:
        print(f"  kill {pid:>6} {name}  {path}")
        print("       ", taskkill(pid) or "(no output)")
    time.sleep(1.0)
    print(f"  port {PORT} busy after the kill: {port_busy()}")


# -- windows --------------------------------------------------------------------------------------


class WindowCensus:
    """Visible top-level windows, by owned process, so a new black box cannot go unnoticed."""

    def __init__(self) -> None:
        self.rows = self._take()

    @staticmethod
    def _take() -> list[tuple[int, int, str]]:
        found: list[tuple[int, int, str]] = []

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            pid = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
            length = user32.GetWindowTextLengthW(hwnd)
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            klass = ctypes.create_unicode_buffer(256)
            user32.GetClassNameW(hwnd, klass, 256)
            found.append((pid.value, klass.value, buf.value))
            return True

        user32.EnumWindows(visit, 0)
        return found

    def new_console_windows(self, before: set[int]) -> list[tuple[int, str, str]]:
        return [row for row in self.rows
                if row[0] not in before and row[1] == "ConsoleWindowClass"]


def descendants(root_pid: int) -> set[int]:
    rows = processes()
    tree = {root_pid}
    changed = True
    while changed:
        changed = False
        for pid, ppid, _name in rows:
            if ppid in tree and pid not in tree:
                tree.add(pid)
                changed = True
    return tree


# -- the two ways to start it ----------------------------------------------------------------------


def start_direct(script: pathlib.Path) -> int:
    log = script.with_name("logs") / "edge-server.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as handle:
        handle.write(f"--- direct launch {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
    proc = subprocess.Popen(
        [PYTHON, str(script)],
        cwd=str(script.parent),
        creationflags=CREATE_NO_WINDOW,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    print(f"started pid {proc.pid}")
    return proc.pid


def start_via_launcher(launcher: pathlib.Path) -> int:
    """Spawn the launcher with the exact flags the helper uses: hidden, and **not** detached.

    `DETACHED_PROCESS` is what put a black window on screen — a detached process has no console, so
    the `python.exe` inside the `cmd.exe` allocates one of its own, and a console a process allocates
    for itself is not covered by the hide request that travelled with `CreateProcess`.
    `STARTF_USESHOWWINDOW` with `SW_HIDE` is the combination measured to produce no window and no
    `conhost` at all.
    """
    startup = subprocess.STARTUPINFO()
    startup.dwFlags |= STARTF_USESHOWWINDOW
    startup.wShowWindow = SW_HIDE
    comspec = r"C:\Windows\System32\cmd.exe"
    proc = subprocess.Popen(
        [comspec, "/d", "/s", "/c", str(launcher)],
        cwd=str(launcher.parent),
        startupinfo=startup,
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    print(f"launched {launcher.name} (pid {proc.pid}) the way the helper does")
    return proc.pid


# -- checks ---------------------------------------------------------------------------------------


def health(attempts: int = 40) -> bool:
    for _ in range(attempts):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=2) as response:
                return response.status == 200
        except Exception:  # noqa: BLE001 - not up yet is the normal case while polling
            time.sleep(0.25)
    return False


def speak(text: str) -> tuple[int, bytes]:
    payload = json.dumps({"text": text}).encode("utf8")
    request = urllib.request.Request(f"http://127.0.0.1:{PORT}/speak", data=payload,
                                     headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--script", default=DEFAULT_SCRIPT)
    parser.add_argument("--launcher", default=LAUNCHER)
    parser.add_argument("--keep", action="store_true", help="stop it and start nothing")
    parser.add_argument("--via-launcher", action="store_true",
                        help="start through the .cmd the helper runs, and check for windows")
    parser.add_argument("--no-speak", action="store_true", help="skip the synthesis check")
    args = parser.parse_args()

    print("stopping whatever holds the port")
    stop_service()
    if args.keep:
        return 0

    before_pids: set[int] = set()
    before = WindowCensus()
    if args.via_launcher:
        before_pids = {row[0] for row in before.rows}
        root = start_via_launcher(pathlib.Path(args.launcher))
    else:
        root = start_direct(pathlib.Path(args.script))

    up = health()
    print(f"health: {'ok' if up else 'NEVER ANSWERED'}")
    if not up:
        return 1

    tree = descendants(root)
    print(f"process tree under pid {root}:")
    for pid, ppid, name in sorted(processes(), key=lambda r: r[2]):
        if pid in tree:
            print(f"  {pid:>6} ppid={ppid:<6} {name}")

    if args.via_launcher:
        time.sleep(1.0)
        appeared = WindowCensus().new_console_windows(before_pids)
        console_anywhere = [(pid, klass, title) for pid, klass, title in WindowCensus().rows
                            if klass == "ConsoleWindowClass"]
        print()
        print(f"new visible console windows: {len(appeared)}"
              f"{'  <-- black window is back' if appeared else '  (the whole point)'}")
        for pid, klass, title in appeared:
            print(f"  pid={pid} {klass} title={title!r}")
        print(f"visible console windows on the whole desktop: {len(console_anywhere)}")

    if args.no_speak:
        return 0

    print()
    print("synthesis check, including the characters that have to be escaped")
    started = time.perf_counter()
    status, audio = speak(TRICKY)
    elapsed = time.perf_counter() - started
    print(f"  status {status}  {len(audio)} bytes  {elapsed:.2f}s")
    if status != 200:
        print(f"  body: {audio[:200].decode('utf8', 'replace')}")
        return 1
    header = audio[:3]
    looks_like_mp3 = header == b"ID3" or (audio[0] == 0xFF and audio[1] & 0xE0 == 0xE0)
    print(f"  header {audio[:4].hex()}  {'MP3' if looks_like_mp3 else 'NOT MP3'}")
    return 0 if looks_like_mp3 else 1


if __name__ == "__main__":
    sys.exit(main())
