"""What this machine can actually run a local voice model on.

The choice between local TTS options is decided almost entirely by the GPU, so read it rather than
guess. Every other route is blocked or silent in this sandbox: `wmic` prints nothing, the PowerShell
tool does not echo stdout, and the security policy refuses both `cmd.exe` and `powershell.exe`
launched from bash. The registry is readable and is the same source `dxdiag` uses, so it is the one
path that works.
"""

from __future__ import annotations

import ctypes
import winreg

HKLM = winreg.HKEY_LOCAL_MACHINE
# The display adapter class. Enumerated by index because the subkey names are numbered, not named.
DISPLAY_CLASS = r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"
# The registry spells the bus as a bare DWORD, while the device manager reports it in megabytes.
VRAM_UNIT_DIVISOR = 1024 * 1024


def video_adapters() -> list[str]:
    found: list[str] = []
    for index in range(20):
        try:
            with winreg.OpenKey(HKLM, DISPLAY_CLASS + f"\\{index:04d}") as key:
                name = str(winreg.QueryValueEx(key, "DriverDesc")[0])
        except OSError:
            continue
        try:
            with winreg.OpenKey(key, "HardwareInformation") as hardware:
                raw = int(winreg.QueryValueEx(hardware, "HardwareInformation.qwMemorySize")[0])
            vram = f"  VRAM {raw / VRAM_UNIT_DIVISOR:.0f} GB"
        except OSError:
            # Integrated adapters report nothing here. Say so rather than leaving a bare guess.
            vram = "  VRAM not reported (likely integrated)"
        found.append(f"  {name}{vram}")
    return found


def cpu_name() -> str:
    try:
        with winreg.OpenKey(HKLM, r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
            return str(winreg.QueryValueEx(key, "ProcessorNameString")[0]).strip()
    except OSError as error:
        return f"unavailable ({error.__class__.__name__})"


def memory() -> tuple[float, float]:
    class MEMORYSTATUSEX(ctypes.Structure):
        _fields_ = [
            ("dwLength", ctypes.c_ulong),
            ("dwMemoryLoad", ctypes.c_ulong),
            ("ullTotalPhys", ctypes.c_ulonglong),
            ("ullAvailPhys", ctypes.c_ulonglong),
            ("ullTotalPageFile", ctypes.c_ulonglong),
            ("ullAvailPageFile", ctypes.c_ulonglong),
            ("ullTotalVirtual", ctypes.c_ulonglong),
            ("ullAvailVirtual", ctypes.c_ulonglong),
            ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
        ]

    status = MEMORYSTATUSEX()
    status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    return status.ullTotalPhys / 1024**3, status.ullAvailPhys / 1024**3


def main() -> None:
    print("GPU:")
    for line in video_adapters() or ["  none reported"]:
        print(line)
    print(f"\nCPU: {cpu_name()}")
    total, available = memory()
    print(f"RAM: {total:.1f} GB total, {available:.1f} GB available now")


if __name__ == "__main__":
    main()
