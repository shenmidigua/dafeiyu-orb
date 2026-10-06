"""Break one thing about `wake_truncation_probe.record`, so `wake_record_check.py` can be seen to fail.

Five faults, one per promise the recorder makes. Each is a change somebody could plausibly make while
editing the function — none of them is deliberately absurd, because a check that only catches absurd
breakage is not worth its own runtime:

    1  `SAY_ATTEMPTS = 1` — the retry removed. This is the state the functions was in when the
       endpoint dropped a session and the interruption family went unmeasured.
    2  the socket is not replaced after a failure, so the retry writes into a session the endpoint has
       already closed — the shape that cost 1140 positives in `wake_dataset.synthesise`
    3  the cache is never read, so every run re-dials the endpoint and a partial run costs everything
    4  `--refresh` stops ignoring the cache, so the flag that exists to re-synthesise quietly does not
    5  the cache key is built from the voice instead of the phrase, so every phrase in a voice shares
       one file: the probe then scores the audio of a *different* phrase while printing the right one.
       Nothing outside can see this, which is why the check asserts the key directly.

Usage:  python fault_record.py <1|2|3|4|5|restore>

Line endings are matched literally and then on a normalised copy, for the reason `fault_prefix.py`
gives: a `\\n` needle finds nothing in a CRLF file, and "the fault was never applied" is a silent way
to invalidate the whole run.
"""

import os
import pathlib
import shutil
import sys

TARGET = pathlib.Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\dsh_orb\wake_truncation_probe.py")
BACKUP = pathlib.Path(os.environ.get("TEMP", r"C:\Windows\Temp")) / "wake_truncation_probe.good.py"

ATTEMPTS = "SAY_ATTEMPTS = 4"
RESET = "                        link = None"
CACHE_READ = "            if path.exists() and not refresh:"
KEY = '    digest = hashlib.sha1(text.encode("utf8")).hexdigest()[:10]'

FAULTS = {
    1: (ATTEMPTS, "SAY_ATTEMPTS = 1"),
    2: (RESET, "                        pass"),
    3: (CACHE_READ, "            if False:"),
    4: (CACHE_READ, "            if path.exists():"),
    5: (KEY, '    digest = hashlib.sha1(voice.encode("utf8")).hexdigest()[:10]'),
}


def read() -> str:
    return TARGET.read_bytes().decode("utf8")


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"1", "2", "3", "4", "5", "restore"}:
        print(__doc__)
        return 2

    # Taken once, and only if absent. Re-copying on every call walks the source towards the last fault
    # injected, so the final `restore` restores the fault. The driver deletes this first, because a
    # backup that outlives an edit to the source silently reverts the edit.
    if not BACKUP.exists():
        shutil.copyfile(TARGET, BACKUP)
        print(f"backed up the good copy to {BACKUP}")
    else:
        print(f"using the existing good copy at {BACKUP}")

    if sys.argv[1] == "restore":
        shutil.copyfile(BACKUP, TARGET)
        print("restored")
        return 0

    needle, replacement = FAULTS[int(sys.argv[1])]
    source = read()
    crlf = "\r\n" in source
    text = source.replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    if text == source:
        text = source.replace(needle, replacement)
    if text == source:
        print(f"FAULT {sys.argv[1]} NOT APPLIED - the needle is not in the file")
        return 1
    # A fault that does not parse tests the parser, not the check. That has happened here: a needle
    # with the wrong indentation produced an IndentationError, and the driver counted it as the fault
    # being caught until the traceback was read.
    try:
        compile(text, str(TARGET), "exec")
    except SyntaxError as error:
        print(f"FAULT {sys.argv[1]} PRODUCED A SYNTAX ERROR at line {error.lineno}: {error.msg}")
        return 1
    TARGET.write_bytes(text.encode("utf8"))
    print(f"fault {sys.argv[1]} applied (crlf={crlf})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
