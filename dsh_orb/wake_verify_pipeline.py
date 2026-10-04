"""Which feature path does the shipped `hey_jarvis` model actually respond to?

The orb can already be woken by saying "Hey Jarvis", so the pretrained classifier demonstrably works
against whatever `assets/wake.js` feeds it. That makes it a reference: push the same phrase through
both feature implementations, and whichever one the classifier lights up on is the one that matches
the renderer.

This matters because the two implementations disagree about the input scale handed to the
melspectrogram model (float [-1,1] versus raw int16) and about how often an embedding is emitted. A
model trained against the wrong one of those would score in an offline evaluation and do nothing on
the device — with no error anywhere to say why.

A negative control is included: the same Chinese voice saying 大肥鱼. The classifier has never seen
that phrase, so it must stay quiet; if it did not, the setup would be measuring nothing.
"""

from __future__ import annotations

import asyncio
import pathlib
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_tts  # noqa: E402
from wake_features import KEYWORD, FeatureExtractor, OrbFeatures  # noqa: E402

CLIPS = [
    ("en-US-AriaNeural", "Hey Jarvis", "should fire"),
    ("en-US-GuyNeural", "Hey Jarvis", "should fire"),
    ("en-US-JennyNeural", "Hey Jarvis", "should fire"),
    ("en-US-AriaNeural", "Hey Jarvis, are you there?", "should fire"),
    ("zh-CN-XiaoyiNeural", "大肥鱼", "must stay quiet"),
    ("en-US-AriaNeural", "Good morning everyone", "must stay quiet"),
]


async def record():
    link = await wake_tts.Connection.open()
    try:
        return [(voice, text, note, await link.say(voice, text)) for voice, text, note in CLIPS]
    finally:
        await link.close()


def score_windows(windows: np.ndarray) -> np.ndarray:
    """Run the shipped classifier over pre-extracted windows."""
    session = ort.InferenceSession(str(KEYWORD), providers=["CPUExecutionProvider"])
    name = session.get_inputs()[0].name
    if windows.shape[0] == 0:
        return np.zeros(0, dtype=np.float32)
    return np.array([session.run(None, {name: window[None, :, :]})[0].ravel()[0]
                     for window in windows], dtype=np.float32)


def main() -> int:
    clips = asyncio.run(record())
    print(f"  {len(clips)} clips")
    print()

    orb = OrbFeatures(ncpu=4)
    oww = FeatureExtractor(ncpu=4)

    print(f"  {'phrase':32} {'expect':16} {'orb max':>8} {'orb mean':>9} "
          f"{'oww max':>8} {'oww mean':>9}")
    print("  " + "-" * 88)
    orb_fires = oww_fires = 0
    for voice, text, note, samples in clips:
        orb_windows = orb.windows(samples)
        oww_windows = oww.windows(samples)
        orb_scores = score_windows(orb_windows)
        oww_scores = score_windows(oww_windows)

        orb_max = float(orb_scores.max()) if orb_scores.size else 0.0
        oww_max = float(oww_scores.max()) if oww_scores.size else 0.0
        if note == "should fire":
            orb_fires += orb_max > 0.5
            oww_fires += oww_max > 0.5
        label = f"{voice.split('-')[1][:6]} {text[:16]}"
        print(f"  {label:32} {note:16} {orb_max:8.3f} {orb_scores.mean():9.3f} "
              f"{oww_max:8.3f} {oww_scores.mean():9.3f}  "
              f"({orb_windows.shape[0]}/{oww_windows.shape[0]} windows)")

    print()
    print(f"  positives fired: orb {orb_fires}/4, openWakeWord-python {oww_fires}/4")
    print()
    if orb_fires > oww_fires:
        print("  VERDICT: the renderer's own path (OrbFeatures) is the one the shipped model")
        print("           responds to. Train against that one.")
    elif oww_fires > orb_fires:
        print("  VERDICT: openWakeWord's Python path is the one that works, which contradicts how")
        print("           wake.js reads — investigate before training.")
    else:
        print("  VERDICT: inconclusive: neither path fires. Check the clips actually say the phrase")
        print("           by listening to them, before concluding anything about the features.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
