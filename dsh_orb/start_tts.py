"""Start the IndexTTS HTTP service detached, and wait until it answers /health.

The sandbox reaps processes that stay inside the tool call's job object, so the server is
launched with DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB and its output goes to a log file
(the model needs ~23s to load; the log is the only way to tell loading from a hang).
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = r"D:\tools\indextts"
PY = HERE + r"\py311\python.exe"
CMD = [PY, "tts_server.py"]
LOG = HERE + r"\logs\tts-server.log"
HEALTH = "http://127.0.0.1:8765/health"

DETACHED_PROCESS = 0x00000008
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_NO_WINDOW = 0x08000000


def health(timeout=2.0):
    try:
        with urllib.request.urlopen(HEALTH, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace").strip()
    except (urllib.error.URLError, OSError):
        return None


def main() -> int:
    existing = health()
    if existing:
        print("already running:", existing)
        return 0

    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "ab") as log:
        log.write(b"\n=== start requested ===\n")
        log.flush()
        flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        try:
            proc = subprocess.Popen(
                CMD, cwd=HERE, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                creationflags=flags | CREATE_BREAKAWAY_FROM_JOB, close_fds=True,
            )
            print("spawned pid", proc.pid, "(breakaway)")
        except OSError as error:
            print("breakaway refused:", error, "- retrying without it")
            proc = subprocess.Popen(
                CMD, cwd=HERE, stdout=log, stderr=log, stdin=subprocess.DEVNULL,
                creationflags=flags, close_fds=True,
            )
            print("spawned pid", proc.pid)

    # The model load is slow and prints progress; poll until it listens.
    deadline = time.time() + 150
    while time.time() < deadline:
        time.sleep(4)
        status = health()
        if status:
            print("READY:", status)
            return 0
        print("  ...waiting", flush=True)
    print("TIMED OUT - tail of log:")
    try:
        with open(LOG, "rb") as f:
            print(f.read()[-2500:].decode("utf-8", "replace"))
    except OSError:
        pass
    return 1


if __name__ == "__main__":
    sys.exit(main())
