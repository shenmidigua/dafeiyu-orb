"""How the Edge proxy behaves as the text gets longer, and whether a whole reply beats splitting it.

The orb cuts a reply into sentences and fetches them one at a time, which was the right shape when a
request meant waiting on someone else's GPU. This endpoint answers in well under a second, so the
question is whether the per-request fixed cost (a websocket, a TLS handshake, a DRM token) now makes
the splitting a net loss. Measured rather than assumed, because the answer decides whether
MIN_SENTENCE_CHARS in speech.js should move.

Run with the same interpreter the proxy uses: D:\\tools\\indextts\\py311\\python.exe
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, r"D:\tools\edgetts")

import edge_server  # noqa: E402  - the path above has to be set first

VOICE = edge_server.DEFAULT_VOICE

# Rounded out by the lengths the orb actually deals with: the shortest sentence it will emit, the
# usual case, the longest it will allow, and a full reply of the kind that used to take 42 seconds.
CASES = [
    ("one short clause", "语音输入链路一切正常。"),
    ("one sentence", "收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。"),
    ("a long sentence", "收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常，你要是还想继续测别的内容，"
                        "直接说一声就行，我这边随时可以配合你继续做各种各样的测试项目。"),
    ("a whole reply", "收到，这条测试语音识别完整，延迟也正常，语音输入链路一切正常。"
                      "你要是还想继续测别的内容，直接说一声就行。"
                      "另外朗读的后端已经换掉了，现在这句话是新的服务合成的。"),
]

ROUNDS = 3


def measure(text: str) -> tuple[float, int]:
    started = time.perf_counter()
    audio = edge_server.synthesise(text, VOICE)
    return time.perf_counter() - started, len(audio)


def main() -> int:
    print(f"voice {VOICE}   fmt {edge_server.DEFAULT_FORMAT}   {ROUNDS} rounds each")
    print(f"{'case':>16} {'chars':>6} {'KB':>7} {'median':>8}   runs")
    for label, text in CASES:
        runs = []
        size = 0
        for _ in range(ROUNDS):
            seconds, size = measure(text)
            runs.append(seconds)
        runs.sort()
        median = runs[len(runs) // 2]
        shown = "  ".join(f"{r:.2f}" for r in runs)
        print(f"{label:>16} {len(text):>6} {size / 1024:>7.1f} {median:>7.2f}s   {shown}")

    whole = CASES[-1][1]
    print()
    print("same reply, split the way the orb splits it:")
    # Read from the file `dump_sentences.mjs` writes, so this measures the splitter the orb really
    # uses rather than a Python reimplementation that could quietly drift from the original.
    split_path = Path(__file__).with_name("reply_sentences.json")
    if split_path.is_file():
        pieces = json.loads(split_path.read_text(encoding="utf8"))["pieces"]
    else:
        print(f"  (no {split_path.name}; run dump_sentences.mjs first - falling back to halves)")
        pieces = [whole[: len(whole) // 2], whole[len(whole) // 2:]]
    elapsed = 0.0
    for index, piece in enumerate(pieces, 1):
        elapsed += measure(piece)[0]
        print(f"  sentence {index}: {len(piece):>3} chars  ready {elapsed:5.2f}s after the request went out")
    print(f"  {len(pieces)} requests, all of it in hand {elapsed:.2f}s after the first one was sent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
