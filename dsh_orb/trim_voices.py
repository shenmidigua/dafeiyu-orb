"""Trim the lead-in and tail silence from the wake acknowledgement clips.

The clips are plain 16-bit PCM, so this is a sample-level copy: no resampling, no
re-encoding, the voice is bit-identical and only the quiet ends go away. The
threshold is a fraction of each clip's own loudest 20 ms window, so a clip
recorded quieter is trimmed by the same rule rather than by an absolute level.
"""

import struct
import sys
import wave
from pathlib import Path

WINDOW_MS = 20
# A window counts as speech at a twentieth of the loudest one: breath and room
# tone sit well under that, the first consonant is well over it.
SPEECH_RATIO = 0.05
LEAD_MS = 20
TAIL_MS = 60


def windows(samples, size):
    for start in range(0, len(samples) - size + 1, size):
        chunk = samples[start:start + size]
        yield start, (sum(sample * sample for sample in chunk) / size) ** 0.5


def trim(path):
    with wave.open(str(path), 'rb') as source:
        params = source.getparams()
        raw = source.readframes(params.nframes)

    samples = list(struct.unpack('<%dh' % (len(raw) // 2), raw))
    if params.nchannels == 2:
        samples = samples[::2]

    size = max(1, int(params.framerate * WINDOW_MS / 1000))
    levels = list(windows(samples, size))
    if not levels:
        return None
    peak = max(level for _, level in levels)
    if peak <= 0:
        return None
    gate = peak * SPEECH_RATIO

    first = next((start for start, level in levels if level >= gate), 0)
    last = next(
        (start + size for start, level in reversed(levels) if level >= gate),
        len(samples),
    )

    lead = int(params.framerate * LEAD_MS / 1000)
    tail = int(params.framerate * TAIL_MS / 1000)
    begin = max(0, first - lead)
    end = min(len(samples), last + tail)

    with wave.open(str(path), 'wb') as sink:
        sink.setnchannels(1)
        sink.setsampwidth(params.sampwidth)
        sink.setframerate(params.framerate)
        sink.writeframes(struct.pack('<%dh' % (end - begin), *samples[begin:end]))

    return {
        'was': params.nframes / params.framerate,
        'now': (end - begin) / params.framerate,
        'lead': begin / params.framerate,
        'tail': (params.nframes - end) / params.framerate,
    }


def main(directory):
    for path in sorted(Path(directory).glob('*.wav')):
        if path.name.endswith('.bak-orig'):
            continue
        if path.name.startswith('_'):
            continue
        result = trim(path)
        if result is None:
            print('%s: no speech found, left alone' % path.name)
            continue
        print('%-8s %5.2fs -> %5.2fs  (cut %.0f ms lead, %.0f ms tail)' % (
            path.name, result['was'], result['now'],
            result['lead'] * 1000, result['tail'] * 1000,
        ))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else '.')
