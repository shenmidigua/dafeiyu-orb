"""Exercise the TTS service the same way the orb does, and report what came back."""
import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:8765/speak"
TEXT = sys.argv[1] if len(sys.argv) > 1 else "这是一条测试音频，你简单回复我。"
OUT = sys.argv[2] if len(sys.argv) > 2 else r"D:\tools\indextts\out\orb_check.wav"

body = json.dumps({"text": TEXT}).encode("utf-8")
req = urllib.request.Request(URL, data=body, headers={"Content-Type": "application/json"})
# The sandbox exports http_proxy pointing at its own egress proxy, which answers 502 for a
# loopback POST. The service is local, so go direct — the orb does the same (Electron uses the
# system proxy, and the registry has ProxyEnable=0).
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
started = time.time()
with opener.open(req, timeout=300) as response:
    audio = response.read()
    kind = response.headers.get("Content-Type")
elapsed = time.time() - started

with open(OUT, "wb") as f:
    f.write(audio)

import wave

with wave.open(OUT, "rb") as w:
    seconds = w.getnframes() / w.getframerate()

print(f"content-type : {kind}")
print(f"bytes        : {len(audio):,}")
print(f"elapsed      : {elapsed:.1f}s for {seconds:.1f}s of audio  (RTF {elapsed / seconds:.2f})")
print(f"saved        : {OUT}")
