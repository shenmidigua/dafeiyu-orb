"""How does the trained model behave in a room that is not silent?

The training set holds 3570 negatives and every one of them is clean TTS on a synthetic noise floor.
That is the dataset's blind spot, and it lines up with the symptom: the false accepts come from
background talking and video, not from the near-misses the adversarial list was built for.

So measure it before changing anything. Take the held-out filler, put it under noise the way a real
room has it, and re-score through the same warm-up the training used. If the rate barely moves, noise
is not the problem and augmentation is the wrong answer. If it climbs, the number says how much
augmentation has to buy.

Three noises, because they fail differently:

  * `babble` — several unrelated clips at once. Spectral structure everywhere, no gaps, which is the
    hard case for a mel filterbank trained on speech.
  * `hiss` — white. No spectral structure at all, so it is the control: a model that fires on it is
    reacting to energy rather than to speech.
  * `pink` — 1/f, where room tone and traffic actually sit. Between the other two.

SNR is referenced to the clip, not to the noise, so -5 dB means the sentence is genuinely underneath
the noise rather than the noise being added politely on top.

The wake word is scored under the same mixtures. If the positives fall off as fast as the negatives,
then the fix has to be augmentation that teaches the model to hear through noise while keeping the
word — not augmentation that merely blurs the decision.

Usage:
    python wake_noise_probe.py [--threshold 0.75] [--snr 5 0 -5] [--clips 120]
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys

import numpy as np
import onnxruntime as ort

sys.path.insert(0, str(pathlib.Path(__file__).parent))

from wake_dataset import pool_from, pool_slice  # noqa: E402
from wake_features import (  # noqa: E402
    SILENCE_LEVEL, OrbFeatures, pcm16_from_wav, warmup_audio, warmup_length,
)

MODEL = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
FILLER_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\negatives")
POSITIVE_DIR = pathlib.Path(r"C:\Users\digua\wakeword\data\positives")
OUT = pathlib.Path(__file__).parent / "noise-probe.json"

# Matches `wake_dataset.POSITIVE_MIN_RING_FRAMES`: a positive has to have the phrase substantially
# inside the ring before it counts as one.
POSITIVE_MIN_RING_FRAMES = 8


# --------------------------------------------------------------------------------------------------
# Noise
# --------------------------------------------------------------------------------------------------

def hiss(rng: np.random.Generator, length: int) -> np.ndarray:
    """White. Flat spectrum, which no room and no recording is."""
    return rng.standard_normal(length).astype(np.float32)


def pink(rng: np.random.Generator, length: int) -> np.ndarray:
    """One third of the power per octave: room tone, traffic, fans."""
    spectrum = rng.standard_normal(length // 2 + 1) + 1j * rng.standard_normal(length // 2 + 1)
    bins = np.arange(spectrum.size)
    shape = np.ones_like(spectrum.real)
    shape[1:] = 1.0 / np.sqrt(bins[1:])
    wave = np.fft.irfft(spectrum * shape, n=length).astype(np.float32)
    peak = float(np.abs(wave).max())
    return wave / peak if peak > 0 else wave


def babble(rng: np.random.Generator, length: int, pool: list[np.ndarray],
           voices: int = 4) -> np.ndarray:
    """Several unrelated clips at once, each a quarter of the total.

    Deliberately not a room simulation. Reverberation is a second variable and the point here is the
    part a keyword classifier actually fails on: overlapping formant structure with no silent frames.
    """
    if not pool:
        return hiss(rng, length)
    out = np.zeros(length, dtype=np.float32)
    for _ in range(voices):
        source = pool[int(rng.integers(0, len(pool)))]
        if len(source) < length:
            repeats = length // max(1, len(source)) + 1
            source = np.concatenate([source] * repeats)
        offset = int(rng.integers(0, len(source) - length + 1))
        out += source[offset:offset + length]
    return (out / voices).astype(np.float32)


def mix_at(speech: np.ndarray, noise: np.ndarray, snr_db: float) -> np.ndarray:
    """Add `noise` beneath `speech` so the signal sits `snr_db` above it."""
    length = max(len(speech), len(noise))
    clean = np.zeros(length, dtype=np.float32)
    clean[:len(speech)] = speech
    dirty = np.zeros(length, dtype=np.float32)
    dirty[:min(len(noise), length)] = noise[:length]
    power_s = float(np.mean(clean ** 2)) + 1e-12
    power_n = float(np.mean(dirty ** 2)) + 1e-12
    scale = np.sqrt(power_s / (power_n * (10.0 ** (snr_db / 10.0))))
    mixed = clean + dirty * scale
    # The orb's input never clips, and a clipped mixture is a different spectral object from a loud
    # one, so the peak is pulled back rather than left to saturate the mel filterbank.
    peak = float(np.abs(mixed).max())
    return (mixed / peak * 0.95).astype(np.float32) if peak > 1.0 else mixed.astype(np.float32)


# --------------------------------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------------------------------

class ClipScorer:
    """Peak score over one clip's windows, with the classifier session kept open.

    `OrbFeatures.score()` builds an InferenceSession per call, which is fine for an evaluator that
    runs a few thousand windows and ruinous for one that runs a few thousand *clips* across eleven
    conditions. The window assembly is still `OrbFeatures.windows`, so the features are identical to
    training — this only replaces who owns the session.
    """

    def __init__(self, extractor: OrbFeatures, model: pathlib.Path) -> None:
        self.extractor = extractor
        self.session = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name

    def peak(self, samples: np.ndarray, warmup: np.ndarray, require: int) -> float:
        windows = self.extractor.windows(samples, warmup, require_clip_embeddings=require)
        if windows.shape[0] == 0:
            return float("nan")
        best = -1.0
        for window in windows:
            out = self.session.run(None, {self.input: window[None, :, :]})[0].ravel()[0]
            best = max(best, float(out))
        return best


# --------------------------------------------------------------------------------------------------
# Probe
# --------------------------------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--threshold", type=float, default=0.75)
    parser.add_argument("--snr", type=float, nargs="+", default=[5.0, 0.0, -5.0])
    parser.add_argument("--clips", type=int, default=120)
    parser.add_argument("--model", type=pathlib.Path, default=MODEL)
    args = parser.parse_args()

    if not args.model.exists():
        print(f"{args.model} is missing; train first")
        return 1
    filler = sorted(FILLER_DIR.glob("filler-*.wav"))
    positives = sorted(POSITIVE_DIR.glob("positive-*.wav"))
    if not filler:
        print(f"no filler clips under {FILLER_DIR}")
        return 1

    rng = random.Random(11)
    nprng = np.random.default_rng(11)
    extractor = OrbFeatures(ncpu=4)
    scorer = ClipScorer(extractor, args.model)

    # The noise is built out of filler so no mixture contains the wake word. A "negative" with the
    # keyword buried in its own babble would be labelled wrong, and would train against the very
    # thing it is meant to defend.
    pool = pool_from(FILLER_DIR, limit=200)
    chosen = rng.sample(filler, min(args.clips, len(filler)))
    positives = positives[:args.clips]

    conditions = ["clean"] + [f"{name}@{snr:+.0f}dB"
                              for snr in args.snr for name in ("hiss", "pink", "babble")]

    def noise_for(condition: str, length: int) -> tuple[np.ndarray | None, float]:
        if condition == "clean":
            return None, 99.0
        name, snr = condition.split("@")
        snr_db = float(snr.replace("dB", ""))
        if name == "hiss":
            return hiss(nprng, length), snr_db
        if name == "pink":
            return pink(nprng, length), snr_db
        return babble(nprng, length, pool), snr_db

    results: dict[str, dict[str, float]] = {}
    print(f"model     {args.model}")
    print(f"threshold {args.threshold}")
    print(f"clips     {len(chosen)} filler / {len(positives)} positive")
    print(f"babble    {len(pool)} clips of material\n")

    print(f"{'condition':>14}  {'误触':>7}  {'fired':>9}  {'peak':>6}  {'召回':>7}  {'hits':>9}")
    for condition in conditions:
        fp = fired = scored = 0
        hits = counted = 0
        peak = 0.0
        for path in chosen:
            speech = pcm16_from_wav(path).astype(np.float32)
            noise, snr_db = noise_for(condition, len(speech))
            samples = speech if noise is None else mix_at(speech, noise, snr_db)
            # The ring holds the room, not just the clip, so the warm-up carries the same mixture.
            # Filling it with clean audio would measure a ring state the orb never has.
            warm_noise, warm_snr = noise_for(condition, warmup_length())
            warm_speech = pool_slice(pool, rng, warmup_length())
            warm = warmup_audio(nprng, warm_speech) if warm_speech is not None \
                else (nprng.standard_normal(warmup_length()) * SILENCE_LEVEL).astype(np.float32)
            if warm_noise is not None:
                warm = mix_at(warm, warm_noise, warm_snr)
            score = scorer.peak(samples, warm, 0)
            if not np.isnan(score):
                scored += 1
                peak = max(peak, score)
                fired += int(score >= args.threshold)
        for path in positives:
            speech = pcm16_from_wav(path).astype(np.float32)
            noise, snr_db = noise_for(condition, len(speech))
            samples = speech if noise is None else mix_at(speech, noise, snr_db)
            warm_noise, warm_snr = noise_for(condition, warmup_length())
            warm_speech = pool_slice(pool, rng, warmup_length())
            warm = warmup_audio(nprng, warm_speech) if warm_speech is not None \
                else (nprng.standard_normal(warmup_length()) * SILENCE_LEVEL).astype(np.float32)
            if warm_noise is not None:
                warm = mix_at(warm, warm_noise, warm_snr)
            score = scorer.peak(samples, warm, POSITIVE_MIN_RING_FRAMES)
            if not np.isnan(score):
                counted += 1
                hits += int(score >= args.threshold)
        fp = fired / max(1, scored)
        recall = hits / max(1, counted)
        results[condition] = {"false_alarm": fp, "fired": fired, "scored": scored,
                              "recall": recall, "hits": hits, "counted": counted, "peak": peak}
        print(f"{condition:>14}  {fp:7.1%}  {fired:4d}/{scored:<4d}  {peak:6.3f}  "
              f"{recall:7.1%}  {hits:4d}/{counted:<4d}")

    OUT.write_text(json.dumps({"threshold": args.threshold, "model": str(args.model),
                               "results": results}, indent=2, ensure_ascii=False) + "\n",
                   encoding="utf-8")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())