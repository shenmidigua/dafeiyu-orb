"""Build the training set for the 大肥鱼 wake word.

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
from wake_features import pcm16_from_wav  # noqa: E402

DATA = wake_tts.DATA
POSITIVE_DIR = DATA / "positives"
NEGATIVE_DIR = DATA / "negatives"
FEATURE_DIR = DATA / "features"

# The endpoint tolerates this many concurrent sessions; measured, not guessed — see the run notes.
WORKERS = 8

# Negatives are cut from long paragraphs. 2 s with a 1 s hop gives each clip a different slice of
# context rather than 15 near-copies of the same moment.
SEGMENT_SECONDS = 2.0
SEGMENT_HOP = 1.0
SENTENCES_PER_PARAGRAPH = 6
PARAGRAPHS_PER_VOICE = 15

# Positives are short and their window count is what makes the class balanced at all, so every window
# is kept. Negatives are long, highly redundant between neighbouring frames, and numerous; keeping
# every window would spend gigabytes to say the same thing eight times.
NEGATIVE_WINDOWS_PER_CLIP = 6

# How much of the 16-embedding ring a window must draw from the clip before a positive clip's window
# counts as a positive example. Eight is half the ring: enough that the phrase is unmistakably present
# and the model is not being taught to fire on its first syllable.
POSITIVE_MIN_RING_FRAMES = 8

PITCHES = ["-10Hz", "+0Hz", "+15Hz"]


def positive_tasks() -> list[tuple[str, str, str, str]]:
    """(text, voice, rate, pitch) — the wake word, said every way the endpoint can say it."""
    return [(carrier, voice, rate, pitch)
            for voice in wake_tts.VOICES
            for carrier in wake_phrases.POSITIVE_CARRIERS
            for rate in wake_tts.RATES
            for pitch in PITCHES]


def adversarial_tasks() -> list[tuple[str, str, str, str]]:
    """Near-misses, at two rates, so the boundary is learned and not just the neighbourhood."""
    return [(text, voice, rate, "+0Hz")
            for voice in wake_tts.VOICES
            for text in wake_phrases.ADVERSARIAL
            for rate in ("-15%", "+15%")]


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
        link = await wake_tts.Connection.open()
        try:
            while True:
                try:
                    text, voice, rate, pitch = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                try:
                    samples = await link.say(voice, text, rate, pitch)
                except Exception as error:  # noqa: BLE001
                    failures += 1
                    print(f"  w{index}: {type(error).__name__} on {text[:12]!r}/{voice}"
                          f" (failure #{failures})")
                    continue
                wake_tts.write_wav(out_dir / f"{label}-{written:06d}.wav", samples)
                written += 1
                done += 1
                if done % 200 == 0:
                    print(f"  {done}/{len(tasks)}")
        finally:
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

      * `positive` — everything but the first and last frame. Those two straddle the edges of the
        phrase, where the window is part voice and part silence; labelling them positive teaches the
        model that the middle of the phrase and the boundary sound alike.
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
    names: list[str] = []
    total = 0
    for index, path in enumerate(files, 1):
        speech = pool_slice(pool_audio, rng, warmup_length()) if pool_audio else None
        warmup = warmup_audio(nprng, speech)
        # Positives must have the phrase substantially in the ring before they count as positive;
        # negatives are negative whenever no wake word is present, whatever the mix.
        windows = extractor.windows(pcm16_from_wav(path), warmup,
                                    require_clip_embeddings=POSITIVE_MIN_RING_FRAMES
                                    if keep == "positive" else 0)
        if windows.shape[0] == 0:
            continue
        if keep == "positive":
            # The ends are dropped for the same reason as before — but the windows are now ordered by
            # how much of the phrase is in the ring, so the last one is the fully-said phrase and the
            # first is the half-said one. Dropping the first keeps the model from firing early.
            selected = windows[1:] if windows.shape[0] > 1 else windows
        else:
            count = min(NEGATIVE_WINDOWS_PER_CLIP, windows.shape[0])
            picks = rng.sample(range(windows.shape[0]), count)
            selected = windows[sorted(picks)]
        if selected.shape[0] == 0:
            continue
        batches.append(selected)
        names.append(path.name)
        total += selected.shape[0]
        if index % 500 == 0:
            print(f"  {index}/{len(files)} clips -> {total} windows")

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
    return stacked.shape[0]


def command_synth(args: argparse.Namespace) -> int:
    rng = random.Random(0)
    positives = positive_tasks()
    adversarial = adversarial_tasks()
    paragraphs = paragraph_plan(rng)
    print(f"  planned: {len(positives)} positives, {len(adversarial)} adversarial, "
          f"{len(paragraphs)} paragraphs")
    if args.limit:
        positives = positives[:args.limit]
        adversarial = adversarial[:max(1, args.limit // 4)]
        paragraphs = paragraphs[:max(1, args.limit // 16)]
        print(f"  limited to: {len(positives)} / {len(adversarial)} / {len(paragraphs)}")

    print("== positives ==")
    count = asyncio.run(synthesise(positives, POSITIVE_DIR, "positive"))
    print(f"  {count} clips")

    print("== adversarial negatives ==")
    count = asyncio.run(synthesise(adversarial, NEGATIVE_DIR, "adversarial"))
    print(f"  {count} clips")

    print("== filler negatives ==")
    count = asyncio.run(synthesise_paragraphs(paragraphs, NEGATIVE_DIR, "filler"))
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
    return 0


def command_stats(_: argparse.Namespace) -> int:
    print(f"  positives: {wav_count(POSITIVE_DIR)} wav")
    print(f"  negatives: {wav_count(NEGATIVE_DIR)} wav")
    for name in ("positive", "negative"):
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
    args = parser.parse_args()
    return {"synth": command_synth, "features": command_features,
            "stats": command_stats}[args.command](args)


if __name__ == "__main__":
    raise SystemExit(main())
