"""Does the deployed model fire on a *truncated* double, and could a stricter rule stop it?

Reported by the user: 「大肥大肥」 and 「大肥鱼大肥」 both wake the orb. Both are the doubled phrase with
syllables missing — 大肥[鱼] 大肥[鱼] — which is the one family `wake_phrases.py` never put in the
adversarial list. That list attacks the phrase said **once**; a truncation is still said twice, and it
is a different mistake: the model may have learned "大肥 comes round again" rather than "大肥鱼 twice".

The second family, reported after the first was fixed: 「大肥鱼一二三大肥鱼」. Both halves complete and
in order, with something inserted between them — so the mistake is that the two halves need not touch.
The file kept its name because the name is what the run notes point at; the second block below is the
family it now also covers, and the columns are the same because the question is the same.

Two numbers, in this order, because they have different fixes:

  * **peak** — the highest window score. If a truncation peaks where the real phrase peaks, then no
    threshold separates them and the model is what is wrong.
  * **longest run** — how many consecutive windows stay above the threshold, in the order the ring
    produces them. This is the quantity the shipped rule consumes (`CONSECUTIVE_WINDOWS = 3`), so
    "would raising the window count buy anything" is answered by the same run of numbers rather than
    by intuition: a four-syllable truncation that holds for six windows cannot be excluded by asking
    for four.

A third column, **needs**, is the direct answer to "can the white line go higher". A clip fires at
threshold `T` when some `RULE_WINDOWS`-long stretch of its window scores is entirely above `T`, so the
largest `T` that still fires it is the *minimum* of its best run — and the worst case over warm-ups is
the number printed. A phrase is removable by the threshold alone exactly when its `needs` is below the
`0.99` ceiling the helper clamps to; above that, no setting of the white line reaches it, which is a
different finding from "the threshold did not happen to help".

Both are measured for the **deployed** model and for whatever `wake_train.py` last exported. They are
not the same file: `orb-wake.json` points at an asset directory, and the last training run wrote to
its own output directory. The gap between the two is itself a finding — a fix that was trained but
never deployed looks exactly like a fix that did not work.

Usage:  <pipeline python> wake_truncation_probe.py [--voices 3] [--tries 3]
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_phrases  # noqa: E402
import wake_tts  # noqa: E402
from wake_dataset import warm_windows  # noqa: E402
from wake_features import OrbFeatures, pcm16_from_wav  # noqa: E402

# Where the orb looks, read from the file the orb reads rather than retyped: a probe that hard-codes a
# path stops describing the deployment the first time the setting is changed.
SETTINGS = pathlib.Path.home() / ".dsh" / "profiles" / "desktop" / "orb-wake.json"
TRAINED = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")

# Clips are cached under a key made of the voice and the phrase's own text, so a run that dies halfway
# costs the clips it had already fetched rather than all of them, and repeating the measurement does
# not re-dial the endpoint at all. The text is hashed rather than abbreviated: two phrases that differ
# only past the cut would otherwise share one file, and the probe would score the wrong audio while
# reporting the right phrase. `--refresh` is the way out when the synthesis itself changes.
CACHE = pathlib.Path(r"C:\Users\digua\wakeword\data\probe-clips")

# Mirrors `wake_dataset.SAY_ATTEMPTS` / `RECONNECT_BACKOFF`. A session the endpoint closes stays
# closed, so a retry on the same socket only spends the wait; the socket has to be replaced.
SAY_ATTEMPTS = 4
RECONNECT_BACKOFF = 0.6

# `CONSECUTIVE_WINDOWS` in `packages/helper/assets/wake.js`. Duplicated rather than imported because
# the two live in different languages; if they ever disagree this probe stops describing the orb.
RULE_WINDOWS = 3
# `Math.min(0.99, Math.max(0.05, config.threshold))` in the same file. The white line is a setting, but
# it is a setting with a roof, and a question about raising it is a question about the roof.
CEILING = 0.99
HIGH = 0.99

CONTROL = [("大肥鱼大肥鱼", "the phrase, whole — this is the line every number below is read against")]

# What each shape is, for the report only. The phrases themselves come from `wake_phrases`, so the
# probe and the training data cannot drift apart: a probe with its own copy of the list goes on
# measuring a family the model was never shown, and reports it as the model's fault.
TRUNCATION_NOTES = {
    "大肥大肥": "鱼 dropped from both halves — the user's first report",
    "大鱼大鱼": "肥 dropped from both halves",
    "大肥鱼大肥": "the final 鱼 dropped — the user's second report",
    "大肥大肥鱼": "the first half's 鱼 dropped",
    "肥鱼大肥鱼": "the leading 大 dropped",
    "大肥鱼肥鱼": "the second half's 大 dropped",
    "大肥大鱼": "鱼 from the first half, 肥 from the second",
}

TRUNCATIONS = [(phrase, TRUNCATION_NOTES.get(phrase, "a syllable missing"))
               for phrase in wake_phrases.TRUNCATED_DOUBLES]

# The second family, and the reason this file is no longer only about truncations: material inserted
# *between* the two halves. Same probe, same rule, same table — because what the user reported was "the
# orb woke on something that is not the phrase", and the shape of the near-miss is the probe's business
# only as far as it changes the reading.
INTERRUPTION_NOTES = {
    "大肥鱼一二三大肥鱼": "a count between the halves — the user's report",
    "大肥鱼一二大肥鱼": "the same, shorter",
    "大肥鱼一二三四五大肥鱼": "the insertion outgrows the ring",
    "大肥鱼那个大肥鱼": "a filler word",
    "大肥鱼，那个，大肥鱼": "the same filler, pauses written",
    "大肥鱼嗯大肥鱼": "a hesitation",
    "大肥鱼然后大肥鱼": "a conjunction",
    "大肥鱼是不是大肥鱼": "a question tag",
}

INTERRUPTED = [(phrase, INTERRUPTION_NOTES.get(phrase, "material between the halves"))
               for phrase in wake_phrases.INTERRUPTED_DOUBLES]


def deployed_model() -> pathlib.Path | None:
    """The keyword file the orb is actually loading, from the orb's own settings."""
    try:
        settings = json.loads(SETTINGS.read_text(encoding="utf8"))
        keyword = settings.get("keyword", "")
        directory = pathlib.Path(settings["assetDirectory"])
        return directory / f"{keyword}.onnx"
    except Exception:
        return None


def cache_path(voice: str, text: str) -> pathlib.Path:
    digest = hashlib.sha1(text.encode("utf8")).hexdigest()[:10]
    return CACHE / f"{voice}-{digest}.wav"


async def record(voices: list[str], phrases: list[str], refresh: bool = False):
    """Synthesise every phrase in every voice, retrying a dropped session on a fresh socket.

    The retry is the point of this function rather than a list comprehension. The endpoint drops
    sessions under load — the same failure `wake_dataset.synthesise` already survives — and one drop
    used to end the whole run: the exception left `asyncio.run` and the probe died before scoring a
    single clip, which is how the interruption family went unmeasured the first time it was asked for.

    A clip that fails all attempts ends the run instead of being skipped, and that is deliberate. The
    denominator here is the voice list: the report reads "k/5 voices fire", so quietly dropping the
    voice whose clip refused would change the measurement while leaving every printed number looking
    healthy. Better to fail loudly and be re-run against the cache.
    """
    CACHE.mkdir(parents=True, exist_ok=True)
    clips = []
    missing = []
    for voice in voices:
        for text in phrases:
            path = cache_path(voice, text)
            if path.exists() and not refresh:
                clips.append((voice, text, pcm16_from_wav(path)))
                continue
            missing.append((voice, text, path))

    if not missing:
        print(f"  clips:   {len(clips)} from cache ({CACHE})")
        return clips
    print(f"  clips:   {len(clips)} cached, {len(missing)} to synthesise")

    link = None
    try:
        for index, (voice, text, path) in enumerate(missing, 1):
            samples = None
            for attempt in range(1, SAY_ATTEMPTS + 1):
                try:
                    if link is None:
                        link = await wake_tts.Connection.open()
                    samples = await link.say(voice, text)
                    break
                except Exception as error:  # noqa: BLE001
                    if link is not None:
                        try:
                            await link.close()
                        except Exception:  # noqa: BLE001
                            pass
                        link = None
                    if attempt == SAY_ATTEMPTS:
                        raise SystemExit(
                            f"the read-aloud endpoint dropped {text!r} in {voice} {SAY_ATTEMPTS} "
                            f"times ({type(error).__name__}); nothing was measured. Re-run to resume "
                            f"from the {len(clips) + index - 1} clip(s) already cached.")
                    print(f"    {type(error).__name__} on {text!r}/{voice} — "
                          f"reconnecting (attempt {attempt}/{SAY_ATTEMPTS - 1})")
                    await asyncio.sleep(RECONNECT_BACKOFF * attempt)
            wake_tts.write_wav(path, samples)
            clips.append((voice, text, samples))
            if index % 10 == 0 or index == len(missing):
                print(f"    {index}/{len(missing)} synthesised")
    finally:
        if link is not None:
            await link.close()
    return clips


def score_clip(session, feed, extractor, pool_audio, samples, tries, rng):
    """Peak, worst-case peak, longest run, and the threshold that would exclude the clip.

    All four are worst-case over tries, for the reason `wake_probe_phrases.py` gives: the same phrase
    in the same voice scored 0.001 behind one stretch of talking and 0.999 behind another, and in
    deployment the context is whatever happened to be said. The run is measured over the whole window
    sequence including the warm-up, because the ring is continuous — the orb has no idea where the
    clip begins, so neither may the measurement.

    `needs` is the largest threshold under which a run of `RULE_WINDOWS` still completes, taken as the
    worst case over warm-ups so that a phrase is only called excludable if *every* context excludes
    it. It is the same arithmetic the engine does (`score > threshold`, `CONSECUTIVE_WINDOWS` in a
    row), read backwards: the engine fires iff the threshold is below the minimum of some run, so the
    threshold that stops it is the largest such minimum.
    """
    peak, low, run, needs = 0.0, 1.0, 0, 0.0
    for _ in range(tries):
        windows = warm_windows(extractor, samples, pool_audio, rng, np.random.default_rng(len(samples)))
        if windows.shape[0] == 0:
            continue
        scores = [float(session.run(None, {feed: window[None, :, :]})[0].ravel()[0])
                  for window in windows]
        peak = max(peak, max(scores))
        low = min(low, max(scores))
        streak = best = 0
        for value in scores:
            streak = streak + 1 if value >= THRESHOLD else 0
            best = max(best, streak)
        run = max(run, best)
        for start in range(0, len(scores) - RULE_WINDOWS + 1):
            needs = max(needs, min(scores[start:start + RULE_WINDOWS]))
    return peak, low, run, needs


THRESHOLD = 0.95


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", type=int, default=3)
    parser.add_argument("--tries", type=int, default=3)
    parser.add_argument("--refresh", action="store_true",
                        help="ignore cached clips and ask the endpoint for fresh audio")
    args = parser.parse_args()

    global THRESHOLD
    try:
        THRESHOLD = float(json.loads(SETTINGS.read_text(encoding="utf8")).get("threshold", THRESHOLD))
    except Exception:
        pass

    models = []
    live = deployed_model()
    if live is not None and live.exists():
        models.append(("deployed", live))
    else:
        print(f"  ! the orb's own model is missing: {live}")
    if TRAINED.exists() and (live is None or TRAINED.resolve() != live.resolve()):
        models.append(("last trained", TRAINED))
    if not models:
        raise SystemExit("no model to measure")

    phrases = ([text for text, _ in CONTROL] + [text for text, _ in TRUNCATIONS]
               + [text for text, _ in INTERRUPTED])
    voices = wake_tts.VOICES[:args.voices]
    print(f"  voices:  {', '.join(voices)}")
    print(f"  rule:    {RULE_WINDOWS} consecutive windows at or above {THRESHOLD}")
    # The number of warm-ups is the denominator that matters, and it is the reason a phrase can read
    # "quiet" here and still peak at 0.999 elsewhere: the same phrase in the same voice scores 0.001
    # behind one stretch of talking and 0.999 behind another, so a voice counts as firing only if it
    # fires behind *every* warm-up tried. A short run of tries is an optimistic measurement, not a
    # neutral one.
    print(f"  warm-ups:{args.tries} per voice — a voice fires only if it fires behind all of them")
    print()

    clips = asyncio.run(record(voices, phrases, refresh=args.refresh))

    pool = sorted(FILLER_DIR.glob("filler-*.wav"))[:200]
    pool_audio = [pcm16_from_wav(path) for path in pool]
    extractor = OrbFeatures(ncpu=4)

    for title, path in models:
        print(f"  == {title}: {path.name}  ({path.parent}) ==")
        session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        feed = session.get_inputs()[0].name
        rng = random.Random(0)

        results: dict[str, list[tuple[float, float, int, float]]] = {}
        for voice, text, samples in clips:
            results.setdefault(text, []).append(
                score_clip(session, feed, extractor, pool_audio, samples, args.tries, rng))

        def line(text: str, note: str, show_needs: bool = True) -> tuple[float, int, float]:
            values = results.get(text, [])
            if not values:
                return 0.0, 0, 0.0
            peak = max(high for high, _, _, _ in values)
            low = min(low for _, low, _, _ in values)
            run = max(run for _, _, run, _ in values)
            needs = max(need for _, _, _, need in values)
            hits = sum(1 for _, _, run, _ in values if run >= RULE_WINDOWS)
            verdict = "FIRES  " if hits else "quiet  "
            print(f"    {text:7} {verdict} peak {peak:6.3f}  low {low:6.3f}  "
                  f"longest run {run}/{RULE_WINDOWS}  "
                  f"{hits}/{len(values)} voice(s) fire  {note}")
            if show_needs:
                print(f"    {'':7}        needs {needs:6.3f} to exclude "
                      f"({'ABOVE the clamp' if needs >= CEILING else 'reachable'})")
            return peak, run, needs

        def report(entries, label: str) -> tuple[int, float, int, float]:
            """One family, and what the numbers say about it."""
            print(f"    -- {label} (must not fire) --")
            worst_peak, worst_run, worst_needs, firing = 0.0, 0, 0.0, 0
            for text, note in entries:
                peak, run, needs = line(text, note)
                worst_peak = max(worst_peak, peak)
                worst_run = max(worst_run, run)
                worst_needs = max(worst_needs, needs)
                if run >= RULE_WINDOWS:
                    firing += 1
            print()
            if firing == 0:
                print(f"    -> {firing}/{len(entries)} fire on this model. The rule holds.")
            else:
                print(f"    -> {firing}/{len(entries)} fire, the worst holding {worst_run} window(s) "
                      f"at {worst_peak:.3f}.")
                print(f"       Excluding the worst by the white line alone needs {worst_needs:.3f}; "
                      f"the line is at {THRESHOLD:.2f} and its clamp stops at {CEILING:.2f}.")
                if worst_needs >= CEILING:
                    print(f"       The clamp does not reach it. No setting of the white line stops this")
                    print(f"       family — the model has to be retrained on it.")
                elif worst_needs >= THRESHOLD:
                    print(f"       Reachable, but the price is paid on the positives: their margin has")
                    print(f"       to be measured before the line is moved. Raising it also delays every")
                    print(f"       real wake by the windows it no longer clears.")
                elif worst_peak >= control_peak - 0.005:
                    print(f"       There is no room under the threshold: the worst peaks where the")
                    print(f"       phrase peaks ({worst_peak:.3f} against {control_peak:.3f}).")
                else:
                    print(f"       Peak {worst_peak:.3f} against {control_peak:.3f} leaves "
                          f"{control_peak - worst_peak:.3f} of headroom, and the run is only "
                          f"{worst_run} window(s).")
            print()
            return firing, worst_peak, worst_run, worst_needs

        print("    -- the phrase, whole (must fire) --")
        control_peak, _, control_needs = line(CONTROL[0][0], CONTROL[0][1], show_needs=False)
        print(f"    {'':7}        its margin: it survives any white line below {control_needs:.3f}, which")
        print(f"    {'':7}        is how much room a higher line has before it costs real wakes.")
        print()
        report(TRUNCATIONS, "truncations of the same phrase — a syllable missing")
        report(INTERRUPTED, "interruptions of the same phrase — the halves not adjacent")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
