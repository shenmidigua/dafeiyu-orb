"""Report what the wake-word engine will actually see, straight from the running helper.

The point of this script is that "the ball says the wake word is unavailable" has three quite
different causes — the switch is off, the models are not where the profile says, or the models
cannot be parsed — and the ball's own wording does not distinguish them. This reads the truth
from two places that cannot disagree with the engine:

  1. the profile file on disk, validated exactly as `readWakeDirectory` validates it;
  2. the environment block of the live helper process, which is what the engine really reads.

The second one is the important half. `enabled` is read once, at helper launch, and baked into
`DSH_ORB_WAKE`; editing `orb-wake.json` afterwards changes nothing until the next restart. Twice
now this has looked like "the setting I just changed did nothing", and the file was correct both
times.

Usage:
    dsh_orb/wake_doctor.py            # find the helper and report
    dsh_orb/wake_doctor.py --config   # only validate the profile file
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.wintypes as w
import datetime
import json
import os
import stat

PROFILE = os.path.join(os.path.expanduser("~"), ".dsh", "profiles", "desktop", "orb-wake.json")
HELPER_EXE = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-orb", "electron-runtime", "electron.exe")

MODELS = ("melspectrogram.onnx", "embedding_model.onnx", "silero_vad.onnx")
RUNTIME = ("ort/ort.wasm.min.js", "ort/ort-wasm-simd-threaded.mjs", "ort/ort-wasm-simd-threaded.wasm")
DEFAULT_KEYWORD = "hey_jarvis"

TH32CS_SNAPPROCESS = 0x00000002
TH32CS_SNAPMODULE = 0x00000008
TH32CS_SNAPMODULE32 = 0x00000010
PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", w.DWORD), ("cntUsage", w.DWORD), ("th32ProcessID", w.DWORD),
        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", w.DWORD),
        ("cntThreads", w.DWORD), ("th32ParentProcessID", w.DWORD),
        ("pcPriClassBase", ctypes.c_long), ("dwFlags", w.DWORD), ("szExeFile", w.WCHAR * 260),
    ]


class MODULEENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", w.DWORD), ("th32ModuleID", w.DWORD), ("th32ProcessID", w.DWORD),
        ("GlblcntUsage", w.DWORD), ("ProccntUsage", w.DWORD), ("modBaseAddr", ctypes.c_void_p),
        ("modBaseSize", w.DWORD), ("hModule", w.HMODULE), ("szModule", w.WCHAR * 256),
        ("szExePath", w.WCHAR * 260),
    ]


class PROCESS_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Reserved1", ctypes.c_void_p), ("PebBaseAddress", ctypes.c_void_p),
        ("Reserved2", ctypes.c_void_p * 2), ("UniqueProcessId", ctypes.c_void_p),
        ("Reserved3", ctypes.c_void_p),
    ]


class FILETIME(ctypes.Structure):
    _fields_ = [("low", w.DWORD), ("high", w.DWORD)]


def kernel32() -> ctypes.WinDLL:
    lib = ctypes.WinDLL("kernel32", use_last_error=True)
    lib.CreateToolhelp32Snapshot.restype = w.HANDLE
    lib.CreateToolhelp32Snapshot.argtypes = [w.DWORD, w.DWORD]
    lib.Process32FirstW.restype = w.BOOL
    lib.Process32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    lib.Process32NextW.restype = w.BOOL
    lib.Process32NextW.argtypes = [w.HANDLE, ctypes.POINTER(PROCESSENTRY32W)]
    lib.Module32FirstW.restype = w.BOOL
    lib.Module32FirstW.argtypes = [w.HANDLE, ctypes.POINTER(MODULEENTRY32W)]
    lib.GetProcessTimes.argtypes = [w.HANDLE] + [ctypes.POINTER(FILETIME)] * 4
    return lib


def keyword_file(keyword: str) -> str:
    """The file the engine will ask for. Mirrors `keywordFile` on both sides of the wire."""
    return "hey_jarvis_v0.1.onnx" if keyword == DEFAULT_KEYWORD else f"{keyword}.onnx"


def required_files(keyword: str) -> tuple[str, ...]:
    return (*MODELS, keyword_file(keyword), *RUNTIME)


def report_config() -> tuple[bool, dict]:
    """Validate the profile the way the host does, and print what it found."""
    print(f"profile: {PROFILE}")
    if not os.path.exists(PROFILE):
        print("  *** the profile file does not exist — the host will use its defaults (off)")
        return False, {}
    with open(PROFILE, encoding="utf8") as handle:
        settings = json.load(handle)
    print(f"  modified      {datetime.datetime.fromtimestamp(os.path.getmtime(PROFILE))}")
    print(f"  enabled       {settings.get('enabled')}")
    print(f"  keyword       {settings.get('keyword')!r} -> {keyword_file(str(settings.get('keyword', '')))}")
    print(f"  threshold     {settings.get('threshold')}")
    print(f"  autoExpand    {settings.get('autoExpandOnWake')}")
    print(f"  dictation     {settings.get('dictation')}")
    root = str(settings.get('assetDirectory', ''))
    print(f"  assets        {root or '(not configured)'}")

    if root == "":
        print("\n  no assetDirectory: the host will search the working directory and four levels up")
        return settings.get('enabled') is True, settings
    root = os.path.abspath(root)
    print(f"  resolved      {root}")
    missing = []
    for name in required_files(str(settings.get('keyword', DEFAULT_KEYWORD))):
        target = os.path.join(root, name.replace('/', os.sep))
        try:
            info = os.stat(target)
            ok = stat.S_ISREG(info.st_mode)
            size = f"{info.st_size:,}"
        except OSError:
            ok, size = False, "-"
        if not ok:
            missing.append(name)
        print(f"    {'OK  ' if ok else 'MISS'} {name:<34} {size:>12}")
    if missing:
        print(f"\n  *** {len(missing)} required file(s) missing — the host will refuse this directory")
        return False, settings
    print("\n  the host will accept this directory")
    return settings.get('enabled') is True, settings


def find_helper() -> tuple[int, str] | None:
    """The helper is the `electron.exe` under the orb runtime, not the Desktop's own."""
    lib = kernel32()
    snapshot = lib.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    found = None
    if lib.Process32FirstW(snapshot, ctypes.byref(entry)):
        while True:
            if entry.szExeFile.lower() == "electron.exe":
                mods = lib.CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32,
                                                   entry.th32ProcessID)
                module = MODULEENTRY32W()
                module.dwSize = ctypes.sizeof(module)
                if lib.Module32FirstW(mods, ctypes.byref(module)):
                    if os.path.normcase(module.szExePath) == os.path.normcase(HELPER_EXE):
                        found = (entry.th32ProcessID, module.szExePath)
                        lib.CloseHandle(mods)
                        break
                lib.CloseHandle(mods)
            if not lib.Process32NextW(snapshot, ctypes.byref(entry)):
                break
    lib.CloseHandle(snapshot)
    return found


def read_environment(pid: int) -> dict[str, str]:
    """The environment block of a live process: PEB -> ProcessParameters -> Environment.

    The offsets are the 64-bit Windows ones (PEB.ProcessParameters at 0x20, and
    RTL_USER_PROCESS_PARAMETERS.Environment at 0x80 with its size at 0x3F0). `cmd` cannot answer
    this and neither can the helper itself, which is the whole reason this exists.
    """
    lib = kernel32()
    ntdll = ctypes.WinDLL("ntdll")
    handle = lib.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise OSError(f"OpenProcess({pid}) failed: {ctypes.get_last_error()}")
    try:
        pbi = PROCESS_BASIC_INFORMATION()
        returned = w.DWORD()
        status = ntdll.NtQueryInformationProcess(handle, 0, ctypes.byref(pbi),
                                                 ctypes.sizeof(pbi), ctypes.byref(returned))
        if status != 0:
            raise OSError(f"NtQueryInformationProcess failed: {status:#x}")

        def read(address: int, size: int) -> bytes:
            buffer = ctypes.create_string_buffer(size)
            got = ctypes.c_size_t()
            if not lib.ReadProcessMemory(handle, ctypes.c_void_p(address), buffer, size,
                                         ctypes.byref(got)):
                return b""
            return buffer.raw[: got.value]

        parameters = int.from_bytes(read(pbi.PebBaseAddress + 0x20, 8), "little")
        env_pointer = int.from_bytes(read(parameters + 0x80, 8), "little")
        env_size = int.from_bytes(read(parameters + 0x3F0, 4), "little")
        blob = b""
        while len(blob) < env_size:
            chunk = read(env_pointer + len(blob), min(0x8000, env_size - len(blob)))
            if not chunk:
                break
            blob += chunk
    finally:
        lib.CloseHandle(handle)

    result: dict[str, str] = {}
    for entry in blob.decode("utf-16-le", "replace").split("\0"):
        if "=" in entry:
            name, _, value = entry.partition("=")
            result[name] = value
    return result


def report_helper() -> bool | None:
    """Compare what the profile says with what the running helper was actually launched with.

    `None` means "no answer available" — the helper is not running — which is neither agreement
    nor disagreement. Reporting that as a mismatch would send the reader looking for a stale
    setting when the only fact is that nothing has been launched yet.
    """
    located = find_helper()
    if located is None:
        print("helper: not running (start the Desktop app; the ball launches the helper)")
        return None
    pid, exe = located
    print(f"\nhelper: pid {pid}  {exe}")
    lib = kernel32()
    handle = lib.OpenProcess(0x1000, False, pid)
    if handle:
        # Every out-parameter must be a real pointer. Passing `None` for three of the four makes
        # the call write through a null pointer, which raises an access violation rather than
        # returning an error — so this reports the start time or dies trying.
        created, exited, kernel, user = FILETIME(), FILETIME(), FILETIME(), FILETIME()
        try:
            lib.GetProcessTimes(
                handle,
                ctypes.byref(created),
                ctypes.byref(exited),
                ctypes.byref(kernel),
                ctypes.byref(user),
            )
            stamp = ((created.high << 32) | created.low) // 10000 - 11644473600000
            print(f"  started       {datetime.datetime.fromtimestamp(stamp / 1000)}")
        finally:
            lib.CloseHandle(handle)

    environment = read_environment(pid)
    assets = environment.get("DSH_ORB_WAKE_ASSETS")
    tuning = environment.get("DSH_ORB_WAKE")
    print(f"  DSH_ORB_WAKE_ASSETS  {assets or '(not set — the helper has no models)'}")
    if tuning is None:
        print("  DSH_ORB_WAKE         (not set — the helper reads defaults, i.e. off)")
        print("\n  *** this helper was launched with wake off. Restart the Desktop app.")
        return False
    parsed = json.loads(tuning)
    print(f"  DSH_ORB_WAKE         enabled={parsed.get('enabled')} "
          f"keyword={parsed.get('keyword')!r} threshold={parsed.get('threshold')}")

    if parsed.get("enabled") is not True:
        print("\n  *** the helper was launched with `enabled: false`, which is what the ball is")
        print("      reporting. The profile may well say otherwise — the helper reads this once,")
        print("      at launch, so a change to orb-wake.json needs a restart to take effect.")
        return False
    if not assets:
        print("\n  *** wake is on but no model directory was handed over; every model request 404s")
        return False
    if not os.path.isdir(assets):
        print(f"\n  *** the handed-over directory does not exist: {assets}")
        return False
    print("\n  the helper has both the switch on and a model directory: the engine can start")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", action="store_true", help="only check the profile file")
    args = parser.parse_args()

    config_ok, settings = report_config()
    if args.config:
        return 0 if config_ok else 1
    print()
    helper_ok = report_helper()
    print()
    if helper_ok is None:
        if config_ok:
            print("the profile is correct; start the Desktop app and run this again to confirm")
            return 0
        print("the profile itself needs fixing — see the *** lines above")
        return 1
    if config_ok and helper_ok:
        print("both halves agree: wake should start")
        return 0
    print("the two halves disagree — see the *** lines above for which one is stale")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
