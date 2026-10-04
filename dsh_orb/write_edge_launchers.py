"""Write the two launcher scripts that put the Edge voice in front of the orb.

A file rather than a one-liner: the payloads contain quotes, backslashes and `%` signs, and the
shell mangles every one of them. `.cmd` files are also written with explicit CRLF, since cmd.exe
misreads a lone LF as part of the command.
"""

from __future__ import annotations

import pathlib

LAUNCHER = """@echo off
rem Edge read-aloud proxy for the DSH orb read-aloud button.
rem
rem Same contract as everything that came before it (GET /health, POST /speak -> audio), but with no
rem local model and - the reason for the switch - no download leg: the audio is streamed back from
rem the endpoint as it is synthesised instead of being fetched as a finished file. Measured on this
rem machine against the same 52 characters: 0.48s to first audio and 0.91s in total, where the host
rem it replaced needed 6.8s and 10.2s, most of that spent pulling the file down.
rem
rem Note what is NOT here: a redirect of the server's own output into its log. cmd.exe opens a
rem redirect target without FILE_SHARE_WRITE, so the server's own open of the same file is refused
rem and it dies at import with an errno 13 nobody ever sees. The server owns its log; this file
rem keeps its own lines separately, in logs\\launcher.log.
rem
rem The voice and output format live in edge_server.py (DEFAULT_VOICE / DEFAULT_FORMAT) rather than
rem being passed here, so this file stays pure ASCII and cannot be mangled by the console code page.
rem Endpoints: GET http://127.0.0.1:8765/health   POST http://127.0.0.1:8765/speak
cd /d D:\\tools\\edgetts
if not exist logs mkdir logs
echo [%date% %time%] starting edge_server>>logs\\launcher.log
D:\\tools\\indextts\\py311\\python.exe edge_server.py
echo [%date% %time%] edge_server exited with %errorlevel%>>logs\\launcher.log
"""

POINTER = """@echo off
rem The read-aloud service the DSH orb starts on demand.
rem
rem This is the file DSH_ORB_TTS_LAUNCH points at, which makes it the switch between engines. It now
rem forwards to the Edge read-aloud proxy, which has no download leg and is therefore an order of
rem magnitude quicker than either host before it.
rem
rem Every earlier engine is still installed and still works. To go back, change the call below:
rem   D:\\tools\\milora\\start_server.cmd      Milora AIvoice - free, public docs, ~10s per sentence
rem   D:\\tools\\indextts\\start_indextts.cmd   the local IndexTTS model - clone of your own voice
rem All of them listen on 8765, so only one can be up at a time.
call "D:\\tools\\edgetts\\start_server.cmd"
"""


def main() -> int:
    edgetts = pathlib.Path(r"D:\tools\edgetts")
    (edgetts / "logs").mkdir(parents=True, exist_ok=True)
    targets = {
        edgetts / "start_server.cmd": LAUNCHER,
        pathlib.Path(r"D:\tools\indextts\start_server.cmd"): POINTER,
    }
    for path, body in targets.items():
        path.write_text(body, encoding="ascii", newline="\r\n")
        raw = path.read_bytes()
        crlf = raw.count(b"\r\n")
        lone_lf = raw.count(b"\n") - crlf
        print(f"{path}  {len(raw)} bytes  crlf={crlf}  lone_lf={lone_lf}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
