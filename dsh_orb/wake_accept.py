"""Run the acceptance pair: does saying it twice wake the orb, and saying it once leave it alone?

Eight files, two voices, one table. The doubled and single files of a voice share everything except
the phrase - same warm-up talk, same gap, same voice, same length - so a difference in behaviour is
about the phrase and nothing else. The second voice exists because every voice used here was also used
in training, and a model that has merely memorised one timbre would pass a single-voice run.

Four of the eight are **truncations**: the doubled phrase with a syllable missing, which the user
reported waking the orb and which the single-word file could never have caught, because a truncation
is still said twice. They belong here rather than only in the offline probes: those measure scores and
this measures the orb, and the user's complaint was about the orb.

`wake_phrase_verify.mjs` supplies the verdict per file; this only sequences the runs and refuses to
report a pass if any single run failed. A run whose harness was broken exits 2 and is reported as
`broken`, never as a verdict about the wake word.

Cheaper tools that stand either side of this one: `wake_accept_offline.py` scores the same four files
without a browser, so a bad model is caught before a build; `wake_accept_diagnose.mjs` prints every
CDP target and every page error unfiltered, for when a run comes back `broken`.

Usage: wake_accept.py [--seconds 25]
"""

from __future__ import annotations

import argparse
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
NODE = r"C:/Users/digua/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
VERIFY = HERE / "wake_phrase_verify.mjs"

CASES = [
    ("wake-mic-doubled.wav", "fired", "say it twice, normal voice", 9500),
    ("wake-mic-single.wav", "quiet", "say it once, normal voice", 9501),
    ("wake-mic-doubled-xb.wav", "fired", "say it twice, other voice", 9502),
    ("wake-mic-single-xb.wav", "quiet", "say it once, other voice", 9503),
    # The two shapes the user reported. Both are the doubled phrase with a syllable missing, so both
    # are still said twice - the case the pair above cannot see.
    ("wake-mic-truncated-both.wav", "quiet", "鱼 missing from both halves", 9504),
    ("wake-mic-truncated-tail.wav", "quiet", "the final 鱼 missing", 9505),
    ("wake-mic-truncated-both-xb.wav", "quiet", "鱼 missing from both halves, other voice", 9506),
    ("wake-mic-truncated-tail-xb.wav", "quiet", "the final 鱼 missing, other voice", 9507),
    # The third family: the doubled phrase with material between the halves. Both halves are complete
    # and in order, they just do not touch, which is why neither `single` nor the truncations above
    # reach it - the ring holds the whole utterance as one object. Also said twice, also must not wake.
    ("wake-mic-interrupted.wav", "quiet", "a hesitation between the halves", 9508),
    ("wake-mic-interrupted-count.wav", "quiet", "a count between the halves — the user's report", 9509),
    ("wake-mic-interrupted-xb.wav", "quiet", "a hesitation, other voice", 9510),
    ("wake-mic-interrupted-count-xb.wav", "quiet", "a count, other voice", 9511),
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=25)
    args = parser.parse_args()

    rows = []
    for name, expect, note, port in CASES:
        mic = HERE / name
        if not mic.exists():
            print(f"  {name}: missing - run make_wake_mic.py first")
            return 2
        print()
        print(f"  ===== {name}  (expect {expect}: {note}) =====")
        result = subprocess.run(
            [NODE, str(VERIFY), "--mic", str(mic), "--expect", expect,
             "--port", str(port), "--seconds", str(args.seconds)],
            cwd=str(HERE), capture_output=True)
        # The harness needs plain bytes or a Chinese badge line dies in the GBK decode.
        for stream in (result.stdout, result.stderr):
            text = stream.decode("utf-8", errors="replace")
            for line in text.splitlines():
                if line.strip():
                    print(f"    {line}")
        if result.returncode == 0:
            verdict = "PASS"
        elif result.returncode == 1:
            verdict = "FAIL"
        else:
            verdict = "BROKEN"
        rows.append((name, expect, verdict))

    print()
    print("  ==================== acceptance ====================")
    width = max(len(name) for name, _, _ in rows)
    for name, expect, verdict in rows:
        print(f"    {name:{width}}  expected {expect:6}  {verdict}")

    failed = [name for name, _, verdict in rows if verdict != "PASS"]
    print()
    if failed:
        print(f"  {len(failed)} of {len(rows)} run(s) did not pass: {', '.join(failed)}")
        return 1
    print(f"  All {len(rows)} runs behaved as expected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
