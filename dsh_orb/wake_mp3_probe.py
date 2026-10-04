"""Find a working MP3 decode path for in-memory audio.

`sf.read(io.BytesIO(...), format='MP3')` raises `TypeError: Not allowed for existing files`, so the
obvious call is out. Decoding thousands of clips through a temporary file per clip would be slow and
would put the generator's throughput at the mercy of the filesystem, so the options are measured
here rather than guessed.
"""

from __future__ import annotations

import io
import pathlib
import traceback

import numpy as np
import soundfile as sf

SAMPLE = pathlib.Path(r"C:\Users\digua\WorkBuddy\2026-10-03-03-52-24\aivoice\edge-小女孩.mp3")


def report(name: str, fn) -> None:
    try:
        result = fn()
        print(f"  {name:28} OK   {result}")
        return True
    except Exception as error:  # noqa: BLE001
        detail = f"{type(error).__name__}: {str(error)[:70]}"
        print(f"  {name:28} FAIL {detail}")
        return False


def main() -> int:
    if not SAMPLE.exists():
        print(f"  sample missing: {SAMPLE}")
        return 1
    raw = SAMPLE.read_bytes()
    print(f"  sample: {len(raw)} bytes, head {raw[:4].hex()}")
    print()

    report("sf.read(BytesIO) no format",
           lambda: sf.read(io.BytesIO(raw), dtype="float32")[0].shape)

    def with_format():
        return sf.SoundFile(io.BytesIO(raw), mode="r", format="MP3").samplerate

    report("SoundFile(BytesIO,format=MP3)", with_format)

    def with_format_signature():
        # The documented signature for a file-like object: format is required, samplerate/channels
        # are what the error message complained about, so they are left off.
        with sf.SoundFile(io.BytesIO(raw)) as handle:
            return f"{handle.samplerate} Hz, {len(handle)} frames"

    report("SoundFile(BytesIO) sniff", with_format_signature)

    def via_name_attr():
        class Named(io.BytesIO):
            name = "clip.mp3"

        return sf.read(Named(raw), dtype="float32")[0].shape

    report("sf.read(BytesIO with .name)", via_name_attr)

    def via_tempfile():
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as handle:
            handle.write(raw)
            path = handle.name
        try:
            data, rate = sf.read(path, dtype="float32")
            return f"{data.shape} @ {rate} Hz"
        finally:
            pathlib.Path(path).unlink(missing_ok=True)

    report("sf.read(tempfile .mp3)", via_tempfile)

    def via_torchaudio():
        import torchaudio
        data, rate = torchaudio.load(io.BytesIO(raw))
        return f"{tuple(data.shape)} @ {rate} Hz"

    report("torchaudio.load(BytesIO)", via_torchaudio)

    print()
    try:
        import torchaudio
        print("  torchaudio backends:", torchaudio.list_audio_backends())
    except Exception as error:  # noqa: BLE001
        print("  torchaudio backend listing failed:", type(error).__name__, str(error)[:80])
    print("  soundfile libsndfile:", sf.__libsndfile_version__)
    print("  MP3 listed as a format:", "MP3" in sf.available_formats())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
