import datetime, os, ctypes, ctypes.wintypes as wintypes

inst = r"C:\Users\digua\.dsh\profiles\desktop\node_modules\dsh-orb\dist\helper\assets\shell.js"
mt = os.path.getmtime(inst)
print("installed shell.js mtime :", datetime.datetime.fromtimestamp(mt))

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


class FT(ctypes.Structure):
    _fields_ = [("lo", wintypes.DWORD), ("hi", wintypes.DWORD)]


def start(pid):
    h = k32.OpenProcess(0x1000, False, pid)
    if not h:
        return None
    c = FT()
    e = FT()
    k32.GetProcessTimes(h, ctypes.byref(c), ctypes.byref(e), ctypes.byref(FT()), ctypes.byref(FT()))
    k32.CloseHandle(h)
    v = (c.hi << 32) | c.lo
    return datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=v // 10)


s = start(15464)
print("helper 15464 started (UTC):", s)
print("installed written  (UTC)  :", datetime.datetime.fromtimestamp(mt, datetime.timezone.utc).replace(tzinfo=None))
if s is not None and datetime.datetime.fromtimestamp(mt, datetime.timezone.utc).replace(tzinfo=None) < s:
    print("RESULT: helper started AFTER the fix was written -> running the fixed code")
else:
    print("RESULT: WARNING - helper predates the fix")

ctypes.windll.user32.SetCursorPos(80, 1000)
print("pointer parked")
