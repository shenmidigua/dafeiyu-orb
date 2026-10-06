"""Build the training set for the 大肥鱼 wake word — the phrase said twice.

Three groups of audio, for three different jobs:

  * **positives** — the wake word itself, in every Chinese voice the endpoint has, across seven
    speaking rates and three pitches. Roughly 1500 clips. Rate and pitch are free speaker variation:
    the same voice at -25% and +20 Hz is a different acoustic object, and a wake word has to survive
    exactly that drift.
  * **adversarial** — the near-misses from `wake_phrases.ADVERSARIAL`. These are what the model would
    otherwise conflate with the target, and they are the reason the phrase was checked for
    separability before any of this was built.
  * **filler** — ordinary Chinese speech, synthesised as long paragraphs and then cut into clips. In
    real use the wake word is surrounded by talking, so this is where the false-accept rate is
    actually decided.

Everything is synthesised on one endpoint, through a pool of connections: a turn costs a fraction of
a second but a handshake costs more than one, so a single connection would make this take an hour
instead of minutes.

Usage:
    wake_dataset.py synth [--limit N]   # synthesise audio into data/positives, data/negatives
    wake_dataset.py features            # turn that audio into data/features/*.npy
    wake_dataset.py stats               # report what was built
"""

from __future__ import annotations

import argparse
import asyncio
import json
import pathlib
import random
import sys
import wave

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).parent))

import wake_phrases  # noqa: E402
import wake_tts  # noqa: E402
import wake_features  # noqa: E402
from wake_features import pcm16_from_wav  # noqa: E402

DATA = wake_tts.DATA
POSITIVE_DIR = DATA / "positives"
NEGATIVE_DIR = DATA / "negatives"
FEATURE_DIR = DATA / "features"

# The endpoint tolerates this many concurrent sessions; measured, not guessed — see the run notes.
WORKERS = 8

# A session that the endpoint closes is not recoverable, so a failed turn is re-tried on a fresh one.
# See the worker in `synthesise` for the run that made this necessary.
SAY_ATTEMPTS = 4
RECONNECT_BACKOFF = 0.6

# Negatives are cut from long paragraphs. 2 s with a 1 s hop gives each clip a different slice of
# context rather than 15 near-copies of the same moment.
SEGMENT_SECONDS = 2.0
SEGMENT_HOP = 1.0
SENTENCES_PER_PARAGRAPH = 6
PARAGRAPHS_PER_VOICE = 15

# Positives are short and their window count is what makes the class balanced at all, so every window
# is kept. Negatives are long, highly redundant between neighbouring frames, and numerous; keeping
# every window would spend gigabytes to say the same thing eight times.
NEGATIVE_WINDOWS_PER_VARIANT = 2

# How many different preceding-conversations each clip is seen behind.
#
# One was the shape of a real failure rather than a saving. `_rate_probe.py` scored the same phrase in
# the same voice at 0.001 and at 0.999, changing nothing but which filler slice happened to precede
# it. With one warm-up per clip the ring contents are effectively part of the label, so the model is
# free to key on the context instead of on the phrase - and nothing about a wake word may depend on
# what was said just before it. The window count per clip is held roughly constant by drawing fewer
# per variant, so this buys variation rather than volume.
WARM_VARIANTS = 3

# What a positive window has to contain, and how much of the clip survives around the phrase.
#
# The old rule — "at least half the ring came from the clip" — cannot express the doubled wake word.
# A doubled clip is about twice as long as its phrase, so under that rule the windows where only the
# *first* 大肥鱼 has been said also counted as positive, while a clip of 大肥鱼 said once was negative.
# The same input, two labels: whatever the model learned there would be noise.
#
# So the rule is now containment: a window is positive only once it holds the **whole phrase**, i.e.
# once the ring has reached the clip's speech end. `prepare_positive` measures that point per clip,
# and `extract` passes it as `require_clip_embeddings`. The trailing audio is then trimmed to a fixed
# number of ring slots so that the windows after the phrase end stay inside the ring's reach — with
# more tail than that, the last windows would slide past the *start* of the phrase and degenerate back
# into single-word examples.
#
# `extract` asserts the invariant and reports the worst case, so a ring too small to hold the phrase
# fails the build instead of quietly producing a model trained on the wrong thing.
#
# The tail is per clip — `prepare_positive` keeps as much as the invariant allows, up to
# `MAX_TAIL_SLOTS` — because a fixed tail yields very few windows for the slow readings, where the
# phrase already fills most of the ring. `TAIL_SLOTS` is only the value a comment can name.
TAIL_SLOTS = 6
MIN_TAIL_SLOTS = 2
MAX_TAIL_SLOTS = 12
# Leading silence kept on a positive clip. Small: the warm-up already supplies the "what came before"
# variety, and every frame of lead-in is a frame the ring cannot spend on the phrase.
LEAD_SECONDS = 0.16
# Frame RMS above which audio counts as talking, when finding the phrase's own end.
SPEECH_RMS = 0.004
# A doubled 大肥鱼 measures 8.7–19.4 slots across voices and rates. Anything under this means the trim
# cut the phrase rather than found its end, and the clip is dropped rather than mislabelled.
MIN_PHRASE_SLOTS = 9

# The boundary fix: the positive clips' own *prefix* windows, labelled negative.
#
# `extract` used to drop them. A window whose right edge has not yet reached the phrase's end is
# neither kept as a positive nor labelled as a negative — it is thrown away — and that is why the
# model says "yes" before the phrase is over.
#
# The measurement is `wake_boundary_probe.py`, run on the deployed model over 40 positive clips and
# three warm-ups. It scores the positive clips' own windows by how many ring slots away from the
# phrase's last frame they are:
#
#     one slot short    72.5% of windows already score 0.95 or more
#     two slots short   33.3%
#     three slots short 10.0%
#     at the phrase end 97.5%
#
# So the model's "yes" begins *inside* the phrase, and a reading with a syllable missing lands in a
# region that is already positive. That is the reported defect — 大肥大肥 and 大肥鱼大肥 both wake the
# orb — and no threshold touches it, because the truncations peak at 1.000, the same place the phrase
# peaks. A longer run of consecutive windows does not reach it either: they hold for three and four
# windows, which is most of what the real phrase holds.
#
# Prefix windows are the negatives that sit at exactly the offset the boundary is wrong at, so
# labelling them is the change that moves it. Two properties make them worth more than their mass:
# they cost no synthesis, and they add no phrase to the distribution — they are the same audio the
# positives come from, cut one, two and three slots earlier. The last attempt at this defect added a
# phrase family instead, tripled its mass, and cost ten times the false alarms (see
# `adversarial_tasks`); this one changes where the label sits rather than what is being said.
#
# How many windows per warm-up variant. The offsets rotate with the variant rather than being fixed,
# so each offset in the band is seen behind a different preceding conversation per clip.
#
# One, and the second one was tried and removed. The reasoning for two was sound and the result was
# not: with one window per variant each offset is learned from 1470 examples at -1 and 1470 at -2, and
# the first model trained this way left one truncation firing in a single voice out of five on a run of
# exactly three windows. Doubling the count *and* stepping the offset with the variant — so every
# offset also gets two of the three warm-ups — was meant to steady exactly those estimates.
#
# It did not close that case, and it cost elsewhere. Same clips, same folds, same epochs, one variable:
#
#                                  one per variant      two per variant
#     held-out near-miss clip FP          0.8%                1.8%
#     held-out near-miss p99              0.932               0.988
#     shipped rule recall at 0.95         98.0%               97.6%
#     windows at offset 0                 73.9%               70.6%
#
# The direction matches the three-pitch experiment above — more mass on the family that is *nearly the
# positive* moves where the model is looking rather than sharpening the edge — and the model kept is
# the one-per-variant one. The truncation probes of the two runs do not settle it on their own, because
# those clips are synthesised fresh each time and a run is not a replicate; the near-miss numbers do,
# because both models are scored on the same held-out clips.
PREFIX_SLOTS = 3
PREFIX_WINDOWS_PER_VARIANT = 1

PITCHES = ["-10Hz", "+0Hz", "+15Hz"]


def positive_tasks() -> list[tuple[str, str, str, str]]:
    """(text, voice, rate, pitch) — the wake word, said every way the endpoint can say it."""
    return [(carrier, voice, rate, pitch)
            for voice in wake_tts.VOICES
            for carrier in wake_phrases.POSITIVE_CARRIERS
            for rate in wake_tts.RATES
            for pitch in PITCHES]


def adversarial_tasks() -> list[tuple[str, str, str, str]]:
    """Near-misses, at every rate the positives use, so the boundary is learned and not just the
    neighbourhood.

    The rate list here used to be `("-15%", "+15%")`, which excludes `+0%` — the rate a person
    actually speaks at, and therefore the rate every acceptance probe and every real utterance is
    recorded at. The model was never shown 喂，大肥鱼 at normal speed and scored it 0.996 on the
    probe: high enough to fire, on the exact phrase the change exists to suppress. A negative set
    that misses the evaluation point is not a boundary, it is a hole, and no threshold can close it
    without also throwing away true positives. The negatives now mirror the positives' rate list.

    Every near-miss, the truncation family included, is synthesised at `+0Hz` and at every rate. The
    truncations were once given every *pitch* as well — three times the mass, on the reasoning that the
    hardest family deserves the axis the positives vary along — and it was reverted, so do not add it
    back without reading this.

    It made the model worse at everything else. Same feature stage, same training, same evaluation:

        truncations at +0Hz only      0.0 false alarms/hour of speech, filler window FP 0.00%
        truncations at three pitches  34.8 false alarms/hour,        filler window FP 0.12%

    Raising the threshold does not recover it — 12.6/hour even at 0.997, which is where recall starts
    to go. Tripling the hardest family took it from 8% of the adversarial clips to 29%, and a boundary
    shaped by the negatives that are *nearly the positive* is a boundary that has stopped describing
    ordinary speech. The family is hard because it is the phrase with a syllable missing; making it the
    biggest group in the set does not make the model better at the boundary, it moves where the model
    is looking.

    `wake_boundary_probe.py` is the measurement that should guide the next attempt. It scores the
    positive clips' own windows by distance from the phrase's last frame, and the model crosses the
    threshold a slot or two early — 72.5% of windows one slot short against 97.5% at the end — which is
    why a shape one syllable short fires. The negatives that would move that edge are the *prefix
    windows of the positive clips themselves*, which `extract` currently drops rather than labels; that
    costs no synthesis and adds no phrase to the distribution. It has not been tried.

    One caveat on the table above: a run is not a replicate, and the same configuration has produced
    0.0 and 3.1 false alarms/hour in two different runs. The regression is large enough to act on, but
    "the truncations at three pitches cost 34.8" is one observation, not a measurement of the effect
    size.
    """
    return [(text, voice, rate, "+0Hz")
            for voice in wake_tts.VOICES
            for text in wake_phrases.ADVERSARIAL
            for rate in wake_tts.RATES]


def paragraph_plan(rng: random.Random) -> list[tuple[str, str]]:
    """(paragraph, voice) — long stretches of ordinary speech to be cut into negatives."""
    return [("".join(rng.sample(wake_phrases.FILLER, SENTENCES_PER_PARAGRAPH)), voice)
            for voice in wake_tts.VOICES
            for _ in range(PARAGRAPHS_PER_VOICE)]


async def synthesise(tasks, out_dir: pathlib.Path, label: str, workers: int = WORKERS) -> int:
    """One clip per task, written as it arrives.

    Writes are serialised but synthesis is not: the expensive part is the round trip, and eight of
    those run at once against eight sockets.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    queue: asyncio.Queue = asyncio.Queue()
    for task in tasks:
        queue.put_nowait(task)

    written = 0
    failures = 0
    done = 0

    async def worker(index: int) -> None:
        nonlocal written, failures, done
        link = None
        try:
            while True:
                try:
                    text, voice, rate, pitch = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                samples = None
                for attempt in range(1, SAY_ATTEMPTS + 1):
                    try:
                        # Opening is *inside* the retry, not before it. A handshake is a network call
                        # like any other and the endpoint refuses those too — with a 503, on a service
                        # that answers fine a second later. An `open()` outside the loop turns one
                        # transient refusal into the end of the stage: eight workers fail to dial, the
                        # exception leaves `gather`, and the run dies having written ten clips into a
                        # group it had already cleared. That is not hypothetical, it is this line's
                        # history, and the cost was 4990 adversarial clips.
                        if link is None:
                            link = await wake_tts.Connection.open()
                        samples = await link.say(voice, text, rate, pitch)
                        break
                    except Exception as error:  # noqa: BLE001
                        # A closed session stays closed. Retrying on the same socket spends the rest
                        # of the stage failing — which is exactly what happened once: 1140 of 1470
                        # positives were dropped because eight workers kept writing into sockets the
                        # endpoint had already hung up, and the stage reported it as 1140 separate
                        # failures rather than as eight dead connections.
                        if link is not None:
                            try:
                                await link.close()
                            except Exception:  # noqa: BLE001
                                pass
                            link = None
                        if attempt == SAY_ATTEMPTS:
                            failures += 1
                            print(f"  w{index}: {type(error).__name__} on {text[:12]!r}/{voice}"
                                  f" (failure #{failures}, gave up after {attempt} attempts)")
                            break
                        print(f"  w{index}: {type(error).__name__} — reconnecting "
                              f"(attempt {attempt}/{SAY_ATTEMPTS - 1})")
                        await asyncio.sleep(RECONNECT_BACKOFF * attempt)
                if samples is None:
                    continue
                wake_tts.write_wav(out_dir / f"{label}-{written:06d}.wav", samples)
                written += 1
                done += 1
                if done % 200 == 0:
                    print(f"  {done}/{len(tasks)}")
        finally:
            if link is not None:
                await link.close()

    await asyncio.gather(*[worker(i) for i in range(workers)])
    if failures:
        print(f"  {failures} clip(s) failed and were skipped")
    return written


async def synthesise_paragraphs(plan, out_dir: pathlib.Path, label: str,
                                workers: int = WORKERS) -> int:
    """Synthesise long paragraphs and cut each into fixed-length clips.

    Cutting here rather than synthesising each clip separately is what makes the filler cheap: one
    long turn yields a dozen clips, and each costs a handshake less than it would on its own.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    queue: asyncio.Queue = asyncio.Queue()
    for item in plan:
        queue.put_nowait(item)

    written = 0
    failures = 0
    done = 0

    async def worker(index: int) -> None:
        nonlocal written, failures, done
        link = await wake_tts.Connection.open()
        try:
            while True:
                try:
                    text, voice = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    long_clip = await link.say(voice, text, "+0%", "+0Hz", timeout=120.0)
                except Exception as error:  # noqa: BLE001
                    failures += 1
                    print(f"  w{index}: {type(error).__name__} on a {len(text)}-char paragraph"
                          f" (failure #{failures})")
                    continue
                for segment in cut(long_clip):
                    wake_tts.write_wav(out_dir / f"{label}-{written:06d}.wav", segment)
                    written += 1
                done += 1
                if done % 20 == 0:
                    print(f"  {done}/{len(plan)} paragraphs -> {written} clips")
        finally:
            await link.close()

    await asyncio.gather(*[worker(i) for i in range(workers)])
    if failures:
        print(f"  {failures} paragraph(s) failed and were skipped")
    return written


def cut(samples: np.ndarray) -> list[np.ndarray]:
    """Slice long audio into overlaps of `SEGMENT_SECONDS`."""
    length = int(SEGMENT_SECONDS * wake_tts.TARGET_RATE)
    step = int(SEGMENT_HOP * wake_tts.TARGET_RATE)
    return [samples[start:start + length]
            for start in range(0, len(samples) - length + 1, step)]


def speech_bounds(samples: np.ndarray) -> tuple[int, int] | None:
    """`(first, one-past-last)` sample of talking, by 80 ms frame RMS, or None if all silent.

    Resolution is one frame, which is finer than the grid the ring advances on, so nothing is lost.
    """
    frame = wake_features.FRAME_SAMPLES
    count = len(samples) // frame
    if count == 0:
        return None
    rows = np.asarray(samples[:count * frame], dtype=np.float32).reshape(count, frame)
    rms = np.sqrt((rows ** 2).mean(axis=1))
    loud = np.where(rms > SPEECH_RMS)[0]
    if len(loud) == 0:
        return None
    return int(loud[0]) * frame, int(loud[-1] + 1) * frame


def prepare_positive(samples: np.ndarray) -> tuple[np.ndarray, int] | None:
    """Trim a positive clip to `lead-in .. phrase end + TAIL_SLOTS`, and locate the phrase's end.

    Returns the trimmed clip and the number of ring slots between the clip's first frame and the
    phrase's last one — the value `extract` hands to `windows()` as `require_clip_embeddings`, and the
    one number the whole labelling rule rests on.

    The end comes from energy rather than from the TTS, because the endpoint pads its output with
    silence of unpredictable length and "the phrase stops here" is what makes a window positive. Only
    the trailing end is measured: every carrier phrase is a prefix, so the phrase is the last thing
    said, and `wake_phrases` forbids suffixes for exactly this reason.
    """
    bounds = speech_bounds(samples)
    if bounds is None:
        return None
    start, end = bounds
    keep_from = max(0, start - int(LEAD_SECONDS * wake_tts.TARGET_RATE))
    last_phrase_frame = (end - keep_from) // wake_features.FRAME_SAMPLES
    before = wake_features.slots_at(wake_features.WARMUP_FRAMES)
    through = wake_features.slots_at(wake_features.WARMUP_FRAMES + last_phrase_frame + 1)
    require = through - before
    # How much trailing audio to keep, per clip rather than fixed. Every window kept is one that has
    # reached the phrase end, so the tail is what decides how many positives a clip yields — and a
    # fixed tail would starve the slow readings, whose phrase already fills most of the ring.
    #
    # The bound is the invariant from `TAIL_SLOTS`: the *last* window must still reach back past the
    # start of the phrase. That window begins `require + tail - WINDOW_FRAMES` slots from the clip's
    # first frame, so the tail has to stay under `WINDOW_FRAMES - require`.
    tail_slots = min(MAX_TAIL_SLOTS, max(MIN_TAIL_SLOTS, wake_features.WINDOW_FRAMES - require - 1))
    keep_to = min(len(samples), end + tail_slots * wake_features.SLOT_SAMPLES)
    clip = np.asarray(samples[keep_from:keep_to], dtype=np.float32)
    if len(clip) < wake_features.FRAME_SAMPLES:
        return None
    return clip, require


def wav_count(directory: pathlib.Path) -> int:
    return len(list(directory.glob("*.wav"))) if directory.exists() else 0


def pool_from(directory: pathlib.Path, limit: int | None = None) -> list[np.ndarray]:
    """Load a directory of clips as in-memory audio, for use as warm-up material."""
    files = sorted(directory.glob("*.wav"))
    if limit is not None:
        files = files[:limit]
    return [pcm16_from_wav(path) for path in files]


def warm_windows(extractor, samples: np.ndarray, pool_audio: list[np.ndarray],
                 rng: random.Random, nprng: np.random.Generator,
                 require_clip_embeddings: int = 0) -> np.ndarray:
    """Windows for one clip, preceded by a warm-up, exactly as training does it.

    Every evaluator goes through here rather than assembling the warm-up itself. The ring state is
    most of every window, so a measurement that fills it differently from training is measuring a
    different problem — which is the mistake that produced a model scoring 1.000 on every Chinese
    sentence it heard.
    """
    from wake_features import warmup_audio, warmup_length

    speech = pool_slice(pool_audio, rng, warmup_length()) if pool_audio else None
    return extractor.windows(samples, warmup_audio(nprng, speech), require_clip_embeddings)


def pool_slice(pool_audio: list[np.ndarray], rng: random.Random, length: int) -> np.ndarray | None:
    """A `length`-sample stretch of talking, spliced from consecutive clips of the pool.

    Splicing is necessary because the clips are two seconds and the warm-up needs more. Six sentences
    cut together with hard joins is not what a quiet room sounds like, but it is close enough to what
    "somebody was talking just before" sounds like, and the alternative is no warm-up at all — which
    is the failure this exists to prevent. Joins are inside the warm-up only, never inside the clip
    being labelled.
    """
    if not pool_audio:
        return None
    start = rng.randrange(len(pool_audio))
    pieces: list[np.ndarray] = []
    total = 0
    for offset in range(len(pool_audio)):
        piece = pool_audio[(start + offset) % len(pool_audio)]
        pieces.append(piece)
        total += len(piece)
        if total >= length:
            break
    joined = np.concatenate(pieces)
    if len(joined) < length:
        return None
    begin = rng.randrange(0, len(joined) - length + 1)
    return joined[begin:begin + length]


# --------------------------------------------------------------------------------------------
# Features
# --------------------------------------------------------------------------------------------

def extract(directory: pathlib.Path, out_path: pathlib.Path, keep: str,
            pool_dir: pathlib.Path | None = None) -> int:
    """Turn every WAV in `directory` into windows and stack them into one array.

    `keep` decides which windows of a clip survive:

      * `positive` — only the windows that hold the **whole** phrase. See `TAIL_SLOTS` above for why
        nothing weaker works for a repeated wake word: a window that has caught only the first half of
        the phrase is the same input as the phrase said once, and the phrase said once is a negative.
      * `sample` — a fixed number drawn at random. Neighbouring frames of a 2 s clip are nearly
        identical, so keeping all of them would multiply the file size by six to say the same thing
        six times, and would silently weight the loss towards whichever negatives happen to be long.

    Every clip is preceded by `warmup_audio`, drawn from `pool_dir` when the coin says "the user was
    talking". Without it the embedding ring starts empty and every window carries zeros that the orb
    never produces; see `wake_features.WARMUP_FRAMES` for the measurement that shows what that costs.

    Features come from `OrbFeatures`, not from openWakeWord's `AudioFeatures`. The two disagree, and
    the orb runs its own: `assets/wake.js` reimplements the chain in JavaScript. `wake_scale_compare.py`
    scored 大肥鱼 through both on 300 real clips and they came out within noise of each other, but
    "within noise of each other" is not a reason to train against the one that does *not* run.
    """
    from wake_features import OrbFeatures, pcm16_from_wav, warmup_audio, warmup_length

    files = sorted(directory.glob("*.wav"))
    if not files:
        print(f"  {directory.name}: no wav files")
        return 0

    extractor = OrbFeatures(ncpu=4)
    rng = random.Random(0)
    # Unrelated speech for the "user was already talking" half of the warm-up. Filler sentences are
    # exactly that, and drawing only from them keeps a clip's own phrase out of its own warm-up.
    pool = sorted(pool_dir.glob("*.wav")) if pool_dir is not None else []
    pool_audio = [pcm16_from_wav(path) for path in pool]
    nprng = np.random.default_rng(0)
    batches: list[np.ndarray] = []
    # The positive clips' prefix windows, kept in a parallel list so both files are written from the
    # same counter and stay in step clip for clip.
    prefix_batches: list[np.ndarray] = []
    names: list[str] = []
    total = 0
    requires: list[int] = []
    dropped_untrimmed = 0
    dropped_short = 0
    dropped_too_long = 0
    for index, path in enumerate(files, 1):
        samples = pcm16_from_wav(path)
        if keep == "positive":
            prepared = prepare_positive(samples)
            if prepared is None:
                dropped_untrimmed += 1
                continue
            samples, require = prepared
            # Too few slots means the trim cut into the phrase, so the "phrase end" it reported is not
            # one; too many means the phrase cannot fit the ring at all. Either way the clip would be
            # mislabelled, and a mislabelled positive is worse than a missing one.
            if require < MIN_PHRASE_SLOTS:
                dropped_short += 1
                continue
            if require > wake_features.WINDOW_FRAMES:
                dropped_too_long += 1
                continue
            requires.append(require)
        else:
            require = 0

        # Containment, per clip: every window kept has reached the phrase's last frame. Repeated over
        # several preceding conversations, so the ring contents cannot become part of the label.
        kept: list[np.ndarray] = []
        prefixes: list[np.ndarray] = []
        for variant in range(WARM_VARIANTS):
            speech = pool_slice(pool_audio, rng, warmup_length()) if pool_audio else None
            warm = warmup_audio(nprng, speech)
            if keep == "positive":
                # Two passes over one warm-up, deliberately. `every` is the clip with nothing filtered
                # out; `windows(..., require)` is the part of it that has reached the phrase's end.
                # The prefix band is their difference, taken as a difference of *lengths* rather than
                # recomputed from slot arithmetic: the slot count is the one number the labelling rule
                # rests on, and a second derivation of it is a second chance to be wrong in a way that
                # nothing checks. This is the same subtraction `wake_boundary_probe.py` does, so the
                # probe measures the band this line labels.
                every = extractor.windows(samples, warm, require_clip_embeddings=0)
                good = extractor.windows(samples, warm, require_clip_embeddings=require)
                kept.append(good)
                # Several prefixes per warm-up variant, walking back a slot at a time and rotating the
                # starting offset with the variant, so each offset in the band is seen behind more than
                # one preceding conversation — the property `WARM_VARIANTS` exists to protect, applied
                # to the windows that decide the boundary.
                before = every.shape[0] - good.shape[0]
                for step in range(PREFIX_WINDOWS_PER_VARIANT):
                    offset = 1 + (variant + step) % PREFIX_SLOTS
                    pick = before - offset
                    if pick < 0:
                        # Not a `continue`. Positives and prefixes are written as two files whose clip
                        # ids are read off the same counter, so a clip that drops out of one and not
                        # the other silently shifts every id after it — and the two sets would then be
                        # split across the fold fence by different clips, putting a clip's phrase in
                        # the held-out fold and its own prefix in training. MIN_PHRASE_SLOTS is 9, so
                        # this cannot happen unless that floor is lowered; if it is, this is the line
                        # that says so.
                        raise SystemExit(
                            f"{path.name}: {before} window(s) before the phrase's end, need "
                            f"{PREFIX_SLOTS}. Lower PREFIX_SLOTS or raise MIN_PHRASE_SLOTS.")
                    prefixes.append(every[pick:pick + 1])
                continue
            windows = extractor.windows(samples, warm, require_clip_embeddings=require)
            count = min(NEGATIVE_WINDOWS_PER_VARIANT, windows.shape[0])
            picks = rng.sample(range(windows.shape[0]), count) if windows.shape[0] else []
            if picks:
                kept.append(windows[sorted(picks)])
        if not kept:
            continue
        selected = np.vstack(kept)
        batches.append(selected)
        names.append(path.name)
        if keep == "positive":
            prefix_batches.append(np.vstack(prefixes))
        total += selected.shape[0]
        if index % 500 == 0:
            print(f"  {index}/{len(files)} clips -> {total} windows")

    if keep == "positive":
        if not batches:
            raise SystemExit(
                f"no positive windows at all. A window must hold the whole phrase, which needs a "
                f"ring of at least {max(requires) if requires else 'MIN_PHRASE_SLOTS'} slots; the ring "
                f"is {wake_features.WINDOW_FRAMES}. Raise wake_features.WINDOW_FRAMES.")
        print(f"  phrase needs {min(requires)}..{max(requires)} of the ring's "
              f"{wake_features.WINDOW_FRAMES} slots ({total} windows from {len(batches)} clips, "
              f"{total / len(batches):.1f} per clip)")
        skipped = dropped_untrimmed + dropped_short + dropped_too_long
        if skipped:
            print(f"  skipped {skipped} clip(s): {dropped_untrimmed} untrimmable, "
                  f"{dropped_short} shorter than the phrase floor, {dropped_too_long} longer than "
                  f"the ring")
        if len(prefix_batches) != len(batches):
            raise SystemExit(f"{len(prefix_batches)} prefix batches against {len(batches)} positive "
                             f"batches; the two are written from the same counter and a mismatch "
                             f"would shift every clip id after the first gap")
        print(f"  prefix negatives: {sum(b.shape[0] for b in prefix_batches)} windows, "
              f"{PREFIX_WINDOWS_PER_VARIANT} per warm-up variant at offsets "
              f"-1..-{PREFIX_SLOTS} from the phrase's end")

    stacked = np.vstack(batches).astype(np.float32)
    # Which clip each window came from, stored alongside the features. Without it the training script
    # cannot split without leaking: neighbouring windows of one clip are nearly identical, so a random
    # window-level split puts the same audio on both sides and reports a validation score that is
    # really a memorisation score.
    clip_ids = np.concatenate([np.full(batch.shape[0], index, dtype=np.int32)
                               for index, batch in enumerate(batches)])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.save(out_path, stacked)
    np.save(out_path.with_name(out_path.stem + "-clips.npy"), clip_ids)
    # The source filename of each clip, so evaluation can separate "a near-miss phrase" from
    # "somebody talking" — they fail in different ways and a single aggregate number hides which.
    out_path.with_name(out_path.stem + "-names.json").write_text(
        json.dumps(names, ensure_ascii=False), encoding="utf-8")

    if keep == "positive":
        # Written beside the positives, under their clip ids: `wake_train.py` copies the positive
        # split's fold table onto this one rather than dealing these clips its own, which is what puts
        # a clip's phrase and its own prefix windows on the same side of the held-out fence.
        prefix_stacked = np.vstack(prefix_batches).astype(np.float32)
        np.save(out_path.with_name("prefix.npy"), prefix_stacked)
        np.save(out_path.with_name("prefix-clips.npy"),
                np.concatenate([np.full(batch.shape[0], index, dtype=np.int32)
                                for index, batch in enumerate(prefix_batches)]))
        out_path.with_name("prefix-names.json").write_text(
            json.dumps(names, ensure_ascii=False), encoding="utf-8")
    return stacked.shape[0]


def command_synth(args: argparse.Namespace) -> int:
    rng = random.Random(0)
    # (label, directory, tasks, what `--limit` divides by). The divisor is how much smaller the group
    # is than the positives, so a smoke run keeps the same proportions.
    groups = {
        "positives": ("positive", POSITIVE_DIR, positive_tasks(), 1),
        "adversarial": ("adversarial", NEGATIVE_DIR, adversarial_tasks(), 4),
        "filler": ("filler", NEGATIVE_DIR, paragraph_plan(rng), 16),
    }
    wanted = args.only.split(",") if args.only else list(groups)
    for name in wanted:
        if name not in groups:
            raise SystemExit(f"unknown group {name!r}; expected one of {sorted(groups)}")

    print("  planned: " + ", ".join(f"{len(groups[name][2])} {name}" for name in wanted))

    # Prove the endpoint answers *before* anything is deleted. The clear below is one-way — it removes
    # every clip in the group before writing a single replacement — so a refusal arriving at that
    # moment costs the whole dataset and only reports itself as a synthesis failure minutes later.
    # That is not hypothetical: it is how 4990 adversarial clips were lost, and the stage ran on into
    # the feature step afterwards because the failure was sitting behind a pipe.
    async def reachable() -> None:
        link = await wake_tts.Connection.open()
        await link.close()

    try:
        asyncio.run(reachable())
    except Exception as error:  # noqa: BLE001
        print(f"  the read-aloud endpoint is not reachable ({type(error).__name__}: {error})")
        print("  nothing has been deleted; try again in a minute.")
        return 1

    for name in wanted:
        label, directory, tasks, divisor = groups[name]
        if args.limit:
            tasks = tasks[:max(1, args.limit // divisor)]
        # Clear this group's previous output before writing it again.
        #
        # The writer names clips by how many it has written, so regenerating a group that comes back
        # *smaller* leaves the surplus behind — and the feature stage reads the directory, not the
        # plan, so it would train on two different phrase lists at once without anything failing.
        # A group that is not selected here is left untouched, which is why the stages are selectable
        # in the first place. Removed one file at a time, not recursively: a recursive delete has been
        # silently refused on this machine before, which is how 2156 stale clips would go unnoticed.
        stale = sorted(directory.glob(f"{label}-*.wav"))
        for path in stale:
            path.unlink()
        print(f"== {name} ==" + (f"  (cleared {len(stale)} previous clips)" if stale else ""))
        if name == "filler":
            count = asyncio.run(synthesise_paragraphs(tasks, directory, label))
        else:
            count = asyncio.run(synthesise(tasks, directory, label))
        print(f"  {count} clips")

    print()
    print(f"  positives on disk: {wav_count(POSITIVE_DIR)}")
    print(f"  negatives on disk: {wav_count(NEGATIVE_DIR)}")
    return 0


def command_features(_: argparse.Namespace) -> int:
    # The warm-up pool is filler only, for every split. Positives must not be warmed up with their own
    # phrase — the ring is what precedes the wake word, and nobody says the wake word twice in a row
    # to build up to saying it. Filler also cannot leak a label: it is negative material, but it only
    # ever appears in the part of the signal that is deliberately not being scored.
    print("== positives ==")
    positives = extract(POSITIVE_DIR, FEATURE_DIR / "positive.npy", keep="positive",
                        pool_dir=NEGATIVE_DIR)
    print(f"  {positives} windows")
    # Adversarial and filler are pooled: both are "speech that is not the wake word", and the
    # distinction between them is only useful when generating, where it can be re-derived from the
    # filename.
    print("== negatives ==")
    negatives = extract(NEGATIVE_DIR, FEATURE_DIR / "negative.npy", keep="sample",
                        pool_dir=NEGATIVE_DIR)
    print(f"  {negatives} windows")

    print()
    print(f"  positive:negative window ratio = 1:{negatives/max(1, positives):.2f}")
    # Reported separately because it is not a third group: the prefix windows are cut from the positive
    # clips, and `wake_train.py` adds them to the negative side of the loss. Keeping the number visible
    # is how a change to PREFIX_SLOTS is noticed as a change to the training set rather than as a
    # detail of the feature stage.
    prefix_path = FEATURE_DIR / "prefix.npy"
    if prefix_path.exists():
        prefix = np.load(prefix_path, mmap_mode="r")
        print(f"  prefix negatives: {prefix.shape[0]} windows "
              f"({prefix.shape[0]/max(1, positives)*100:.0f}% of the positive count)")
    else:
        print("  prefix negatives: missing — wake_train.py will refuse to run")
    return 0


def command_stats(_: argparse.Namespace) -> int:
    print(f"  positives: {wav_count(POSITIVE_DIR)} wav")
    print(f"  negatives: {wav_count(NEGATIVE_DIR)} wav")
    for name in ("positive", "negative", "prefix"):
        path = FEATURE_DIR / f"{name}.npy"
        if path.exists():
            array = np.load(path, mmap_mode="r")
            print(f"  {name}.npy: {array.shape}  {path.stat().st_size/2**20:.1f} MiB")
        else:
            print(f"  {name}.npy: missing")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["synth", "features", "stats"])
    parser.add_argument("--limit", type=int, default=0,
                        help="generate only a small slice, to prove the pipeline end to end")
    parser.add_argument("--only", default="",
                        help="comma-separated subset of positives,adversarial,filler to regenerate; "
                             "the groups left out are neither touched nor cleared")
    args = parser.parse_args()
    return {"synth": command_synth, "features": command_features,
            "stats": command_stats}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
