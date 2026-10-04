"""Turn 16 kHz audio into the features the wake-word classifier is trained on.

There are two feature paths in this file, and they are not interchangeable. `OrbFeatures` reproduces
what the orb's renderer actually runs; `FeatureExtractor` wraps openWakeWord's own Python. They are
both kept because the difference between them is the single most likely reason a trained model would
arrive on the device and do nothing, and the way to know which is right is to ask the pretrained
classifier — see `wake_verify_pipeline.py`.
"""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import types

import numpy as np

# The source tree, for `utils.py`. Its model weights are not in the repository.
SOURCE = pathlib.Path(r"C:\Users\digua\wakeword\openWakeWord-main")

# The models the orb actually ships and runs. Using anything else would train against a different
# version of the pipeline than the one that will execute it.
ASSETS = pathlib.Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\dsh-voice-dialog\assets")
MELSPEC = ASSETS / "melspectrogram.onnx"
EMBEDDING = ASSETS / "embedding_model.onnx"
KEYWORD = ASSETS / "hey_jarvis_v0.1.onnx"       # the shipped classifier, used as a reference point

FRAME_SAMPLES = 1280
WINDOW_FRAMES = 16
EMBEDDING_DIM = 96
MEL_BINS = 32
MEL_WINDOW_FRAMES = 76

# How much audio to run before a clip so the embedding ring is already full when the clip starts.
#
# This is not decoration. The ring holds sixteen embeddings and starts as sixteen zero vectors, so a
# feature run that begins at the clip leaves zeros on the left of every window it produces. The orb
# does not work that way: the engine runs continuously, so by the time anyone says the wake word the
# ring is full of whatever came before — usually silence, sometimes a previous sentence. Only the
# first ~1.3 s after the engine is created has zeros in the ring.
#
# A model trained on the zero-padded version learns *that* pattern, and the cost was measured before
# it was corrected: for phrases it had been fitted to it scored 0.986–1.000, and on ordinary Chinese
# sentences it went from 0.000 with a cold ring to 1.000 — every single one — with a warm one. It
# would have woken on every sentence the user spoke.
#
# 40 frames is 3.2 s, which yields ~25 embeddings before the clip: comfortably more than the sixteen
# the ring needs, with room for the cadence to be uneven.
WARMUP_FRAMES = 40

# The floor of a quiet room, not digital zero. Real silence still carries a noise floor, and the
# melspectrogram model takes a logarithm, so exact zeros are a different regime again.
SILENCE_LEVEL = 0.003


def warmup_length() -> int:
    return WARMUP_FRAMES * FRAME_SAMPLES


def warmup_audio(rng: "np.random.Generator", speech: np.ndarray | None = None) -> np.ndarray:
    """Audio to fill the embedding ring before a clip, as the orb would have it.

    Two cases, both of which happen constantly in front of a wake word: the user was quiet, or the
    user was already talking. Half the time each, because a model fitted only to one of them is wrong
    half the time.

    `speech` is one `warmup_length()`-sample stretch of unrelated talking — spliced from whatever
    corpus is to hand. It must be long enough already; a short clip would silently shift the ring
    cadence rather than fail.
    """
    length = warmup_length()
    if speech is not None:
        if len(speech) < length:
            raise ValueError(f"warm-up speech is {len(speech)} samples, needs {length}")
        if rng.random() < 0.5:
            return np.asarray(speech[:length], dtype=np.float32).copy()
    return (rng.standard_normal(length) * SILENCE_LEVEL).astype(np.float32)


class OrbFeatures:
    """The feature pipeline exactly as the orb's renderer runs it.

    This exists because `AudioFeatures` below, faithful as it is to openWakeWord's Python, is *not*
    the thing that will score the finished model. `assets/wake.js` reimplements the chain in
    JavaScript, and the two disagree in ways that would stay invisible until the model was deployed
    and silent:

      * **Input scale.** `wake.js` hands the mel model float samples in [-1, 1], straight off the
        AudioWorklet. openWakeWord's Python hands it raw int16 in [-32768, 32767]. The melspectrogram
        model is the same file in both cases, so at most one of those can be what it was trained for.
      * **Frame cadence.** Each 80 ms frame yields five mel frames. `wake.js` consumes them eight at a
        time, so an embedding appears roughly every 1.6 frames of audio; the Python path emits one per
        call. Sixteen consecutive embeddings therefore span different amounts of time on the two
        sides, and the classifier sees a differently-stretched window.

    Neither is a bug to be fixed here — `wake.js` is what runs. The point is that training features
    have to come from this path, or the model is fitted to a distribution it will never see.

    Verified against the shipped `hey_jarvis` classifier in `wake_verify_pipeline.py`, which pushes
    real speech through both this class and `FeatureExtractor` and reports which one the pretrained
    model actually responds to.
    """

    MEL_FRAMES_PER_CALL = 5          # what one 1280-sample frame produces, and what wake.js pushes
    MEL_STEP = 8                     # what wake.js splices off after each embedding

    def __init__(self, ncpu: int = 4, scale: float = 1.0) -> None:
        """`scale` multiplies the audio before the mel model.

        1.0 is what `wake.js` does today and is the default so the default reproduces the device.
        32767.0 is what openWakeWord's own Python does. The two are not equivalent: measured on the
        shipped mel model, the outputs are perfectly correlated but separated by a constant 90.3
        (= 10*log10(32767**2)), i.e. exactly the factor you get when the input is scaled by int16 and
        the model takes a plain log of energy. After the `/10 + 2` transform that is an offset of
        9.03, against a signal that only spans about four units — so the shipped path hands the
        embedding model something well outside the range it was fitted to. See `wake_scale_compare.py`
        for what that costs, and whether it is worth changing wake.js over.
        """
        import onnxruntime as ort

        self.scale = float(scale)
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = ncpu
        self._mel = ort.InferenceSession(str(MELSPEC), sess_options=options,
                                         providers=["CPUExecutionProvider"])
        self._emb = ort.InferenceSession(str(EMBEDDING), sess_options=options,
                                         providers=["CPUExecutionProvider"])

    def windows(self, samples: np.ndarray, warmup: np.ndarray | None = None,
                require_clip_embeddings: int = 0) -> np.ndarray:
        """`(n, 16, 96)` windows from float32 audio in [-1, 1].

        `warmup` is audio that came *before* `samples`; it fills the embedding ring so the returned
        windows contain no zeros, which is the state the ring is in whenever the orb is actually
        running. See `warmup_audio` for why that matters, and `WARMUP_FRAMES` for what happens when
        it is left out.

        Without a warm-up the ring starts as zeros and the first window does not appear until sixteen
        embeddings have accumulated — 1.3 s of audio — so a short clip yields only a handful of
        windows, all hugging its end.

        `require_clip_embeddings` bounds how much of the ring may still be warm-up. It defaults to 0,
        which is right for negatives — a window is negative whenever it holds no wake word, however
        the ring is mixed — and wrong for positives: the first window after the phrase starts holds
        fifteen warm-up embeddings and one from the phrase, and labelling *that* positive teaches the
        model to fire before the phrase has been said. Positives pass half the ring.
        """
        if warmup is not None and len(warmup):
            signal = np.concatenate([np.asarray(warmup, dtype=np.float32),
                                     np.asarray(samples, dtype=np.float32)])
            clip_start_frame = len(warmup) // FRAME_SAMPLES
        else:
            signal = np.asarray(samples, dtype=np.float32)
            clip_start_frame = 0

        mel_buffer: list[np.ndarray] = []
        history = [np.zeros(EMBEDDING_DIM, dtype=np.float32) for _ in range(WINDOW_FRAMES)]
        out: list[np.ndarray] = []
        embeddings_before_clip = 0
        embeddings_from_clip = 0
        frame_index = -1

        for start in range(0, len(signal) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
            frame_index += 1
            frame = np.ascontiguousarray(signal[start:start + FRAME_SAMPLES], dtype=np.float32)
            if self.scale != 1.0:
                frame = frame * self.scale
            mel = self._mel.run(None, {self._mel.get_inputs()[0].name: frame[None, :]})[0]
            mel = np.asarray(mel, dtype=np.float32).ravel()
            # Measured on the shipped model: 1280 samples -> (1, 1, 5, 32). Stated here rather than
            # assumed, because the whole cadence below depends on it and a changed model would
            # otherwise be read as a short frame rather than as an error.
            if mel.size != self.MEL_FRAMES_PER_CALL * MEL_BINS:
                raise RuntimeError(f"melspectrogram returned {mel.size} values for {FRAME_SAMPLES} "
                                   f"samples, expected {self.MEL_FRAMES_PER_CALL * MEL_BINS}")
            # The same normalisation wake.js applies, and the same one AudioFeatures defaults to.
            mel = mel / 10.0 + 2.0
            for index in range(self.MEL_FRAMES_PER_CALL):
                mel_buffer.append(mel[index * MEL_BINS:(index + 1) * MEL_BINS].copy())

            while len(mel_buffer) >= MEL_WINDOW_FRAMES:
                # Reshaped, not just concatenated: the buffer holds 32-wide rows, and the embedding
                # model wants (76, 32) with a singleton channel axis on each side.
                flat = (np.concatenate(mel_buffer[:MEL_WINDOW_FRAMES])
                        .reshape(MEL_WINDOW_FRAMES, MEL_BINS).astype(np.float32)[None, :, :, None])
                embedding = self._emb.run(
                    None, {self._emb.get_inputs()[0].name: flat})[0].ravel().astype(np.float32)
                history.pop(0)
                history.append(embedding)
                if frame_index < clip_start_frame:
                    embeddings_before_clip += 1
                else:
                    embeddings_from_clip += 1
                    if embeddings_from_clip >= require_clip_embeddings:
                        # Copied, because the classifier's window is a ring that keeps being
                        # overwritten and a trainer holding views into it would silently train on one
                        # frame repeated.
                        out.append(np.stack(history))
                del mel_buffer[:self.MEL_STEP]

        if warmup is not None and len(warmup) and embeddings_before_clip < WINDOW_FRAMES:
            raise RuntimeError(
                f"warm-up of {len(warmup)} samples produced only {embeddings_before_clip} embeddings "
                f"before the clip; the ring needs {WINDOW_FRAMES}, so the windows still contain zeros. "
                f"Raise WARMUP_FRAMES.")

        if not out:
            return np.zeros((0, WINDOW_FRAMES, EMBEDDING_DIM), dtype=np.float32)
        return np.stack(out).astype(np.float32)

    def score(self, samples: np.ndarray, model_path: pathlib.Path = KEYWORD,
              warmup: np.ndarray | None = None,
              require_clip_embeddings: int = 0) -> np.ndarray:
        """Run a keyword classifier over the audio, returning one score per window."""
        import onnxruntime as ort

        session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
        name = session.get_inputs()[0].name
        windows = self.windows(samples, warmup, require_clip_embeddings)
        if windows.shape[0] == 0:
            return np.zeros(0, dtype=np.float32)
        # One call per window rather than one batched call: a batch would need the model to declare a
        # dynamic leading dimension, which the shipped classifiers do not.
        return np.array([session.run(None, {name: window[None, :, :]})[0].ravel()[0]
                         for window in windows], dtype=np.float32)


def audio_features_class():
    """Load `AudioFeatures` out of the source tree without importing the package around it.

    `openwakeword/__init__.py` pulls in `custom_verifier_model`, which wants scikit-learn, and `Model`,
    which wants a tflite runtime that does not exist here — none of which the extractor needs. So the
    package name is stubbed in `sys.modules` and `utils.py` is executed directly; it references
    `openwakeword` only for its own package path.
    """
    if "openwakeword" not in sys.modules:
        stub = types.ModuleType("openwakeword")
        stub.__path__ = [str(SOURCE / "openwakeword")]
        sys.modules["openwakeword"] = stub
    spec = importlib.util.spec_from_file_location("oww_utils", SOURCE / "openwakeword" / "utils.py")
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {SOURCE / 'openwakeword' / 'utils.py'}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.AudioFeatures


class FeatureExtractor:
    """openWakeWord's own feature path, for comparison only.

    Stateful by nature — the mel and embedding buffers carry across frames — so it resets per clip.
    Takes int16 and emits one embedding per 80 ms frame, which is *not* what `wake.js` does; see
    `OrbFeatures`.
    """

    def __init__(self, ncpu: int = 1, device: str = "cpu") -> None:
        cls = audio_features_class()
        self._features = cls(melspec_model_path=str(MELSPEC),
                             embedding_model_path=str(EMBEDDING),
                             device=device, ncpu=ncpu)

    def windows(self, samples: np.ndarray) -> np.ndarray:
        """`(n, 16, 96)` windows from float32 audio in [-1, 1]."""
        pcm = to_pcm16(samples)
        self._features.reset()
        rows = []
        for start in range(0, len(pcm) - FRAME_SAMPLES + 1, FRAME_SAMPLES):
            self._features(pcm[start:start + FRAME_SAMPLES])
            rows.append(self._features.get_features(WINDOW_FRAMES)[0])
        if not rows:
            return np.zeros((0, WINDOW_FRAMES, EMBEDDING_DIM), dtype=np.float32)
        return np.stack(rows).astype(np.float32)


def to_pcm16(samples: np.ndarray) -> np.ndarray:
    """float32 in [-1, 1] to the int16 openWakeWord's Python expects."""
    return (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)


def pcm16_from_wav(path: pathlib.Path) -> np.ndarray:
    """Read a 16 kHz mono PCM16 WAV back as float32, via the standard library."""
    import wave

    with wave.open(str(path), "rb") as handle:
        if handle.getframerate() != 16000 or handle.getnchannels() != 1:
            raise RuntimeError(f"{path.name}: expected 16 kHz mono, got "
                               f"{handle.getframerate()} Hz / {handle.getnchannels()} ch")
        raw = handle.readframes(handle.getnframes())
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32767.0
