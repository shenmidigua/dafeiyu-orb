"""Mirror a GIF horizontally into a new file, frame for frame — exactly.

Why a script rather than a one-liner: the arrival is an animated, transparent 51-frame GIF, and the
things that are easy to lose on the way out are exactly the ones that matter on the ball —

*   **Transparency.** Every frame of this file is a full 500x500 canvas with its own local colour
    table, `disposal = 2` (restore to background) and transparent index 255. A copy that loses any of
    that paints a coloured square where the ball should show the desktop.
*   **Delay and loop.** 40 ms per frame, for ever, or the arrival plays once and stops.
*   **The colours.** Each frame is already a palette image, so it has at most 255 distinct opaque
    colours and a palette built from them is lossless. Handing RGBA frames to Pillow's GIF writer
    instead lets it quantise *with dithering* — measured on this very file, a 2.6/255 average error
    and a speckle over the flat areas — and letting it trim the palettes moves the transparent index
    out from under the pixels. Both are avoided by doing the palette here, without dithering, and
    writing palette frames with the transparent index pinned at 255.

The output is checked against the input rather than trusted, on the animation and on the file: every
tick of the timeline has to be the exact mirror of the source frame at that tick, and the raw GIF
records have to carry the same disposal and transparency flag. The frame *count* is allowed to differ
and does: Pillow folds a run of identical frames into one with the summed delay, and this file ends
with the settled pose held for eleven frames — 51 frames and 440 ms become 1 frame and 440 ms, with
nothing different on screen. Checking the timeline rather than the frame list keeps that from being
reported as a broken copy.

Usage: `flip_gif.py [source] [destination] [--force]`
"""

from __future__ import annotations

import argparse
import struct
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ImageSequence

PACK = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\大肥鱼表情包整合\大肥鱼表情包整合")
DEFAULT_SOURCE = PACK / "到达.gif"
DEFAULT_DESTINATION = PACK / "到达 水平翻转.gif"
# The animation is compared on a 40 ms grid: the delay every frame of this pack uses, and the
# resolution a viewer would have to be shown to see any difference at all.
TICK_MS = 40
# The index reserved for "show the desktop through here". 255 is the index the source declares, and
# keeping it fixed is what lets the written frames be compared with the read ones.
TRANSPARENT = 255


def records(path: Path) -> tuple[list[tuple[int, int, int, int, int, int, bool, int]], int]:
    """The GIF's own frame records, read from the bytes.

    Pillow reports a frame's disposal and transparent index only when they change, so asking it is
    not the same question as asking the file. This is the file. Each record is
    `(left, top, width, height, disposal, delay, transparent, transparent index)`, and the second
    value is the loop count from the Netscape extension (`0` is "for ever").
    """
    data = path.read_bytes()
    if data[:3] != b"GIF":
        raise ValueError(f"{path} is not a GIF")
    pos = 13
    if data[10] & 0x80:
        pos += 3 * 2 ** ((data[10] & 0x07) + 1)
    found: list[tuple[int, int, int, int, int, int, bool, int]] = []
    loop: int | None = None
    pending: tuple[int, int, bool, int] | None = None
    while pos < len(data):
        block = data[pos]
        if block == 0x3B:
            break
        if block == 0x21:
            label = data[pos + 1]
            if label == 0xF9 and data[pos + 2] == 4:
                packed = data[pos + 3]
                delay = struct.unpack("<H", data[pos + 4:pos + 6])[0]
                pending = ((packed & 0x1C) >> 2, delay, bool(packed & 0x01), data[pos + 6])
                pos += 8
                continue
            if label == 0xFF and data[pos + 2] == 11 and data[pos + 3:pos + 14] == b"NETSCAPE2.0":
                loop = struct.unpack("<H", data[pos + 16:pos + 18])[0]
            pos += 2
            while data[pos] != 0:
                pos += 1 + data[pos]
            pos += 1
            continue
        if block == 0x2C:
            left, top, width, height = struct.unpack("<HHHH", data[pos + 1:pos + 9])
            local = data[pos + 9]
            disposal, delay, transparent, index = pending or (0, 0, False, 0)
            found.append((left, top, width, height, disposal, delay, transparent, index))
            pos += 10
            if local & 0x80:
                pos += 3 * 2 ** ((local & 0x07) + 1)
            pos += 1
            while data[pos] != 0:
                pos += 1 + data[pos]
            pos += 1
            pending = None
            continue
        raise ValueError(f"unknown GIF block {block:#x} at {pos} in {path}")
    return found, (loop if loop is not None else 0)


def frames_rgba(path: Path) -> tuple[list[np.ndarray], list[int]]:
    """Every frame as the user sees it, plus each frame's delay."""
    frames: list[np.ndarray] = []
    delays: list[int] = []
    with Image.open(path) as image:
        for frame in ImageSequence.Iterator(image):
            frames.append(np.asarray(frame.convert("RGBA"), dtype=np.uint8))
            delays.append(int(frame.info.get("duration") or TICK_MS))
    return frames, delays


def mirrored_palette_frames(path: Path) -> list[Image.Image]:
    """Each frame mirrored, as a palette image with `TRANSPARENT` pinned as the clear index.

    The palette is built from the frame's own opaque colours, which is lossless because a GIF frame
    is a palette image to begin with. `dither=NONE` is the point rather than a detail: with the
    default, Pillow spreads the quantisation error of every flat area into a speckle.
    """
    frames: list[Image.Image] = []
    with Image.open(path) as image:
        for frame in ImageSequence.Iterator(image):
            rgba = frame.convert("RGBA")
            alpha = rgba.getchannel("A")
            paletted = rgba.convert("RGB").quantize(
                colors=TRANSPARENT, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
            palette = list(paletted.getpalette() or [])[:TRANSPARENT * 3]
            palette += [0, 0, 0] * (256 - len(palette) // 3)
            paletted.putpalette(palette)
            paletted.paste(TRANSPARENT, mask=alpha.point(lambda value: 255 if value < 128 else 0))
            frames.append(ImageOps.mirror(paletted))
    return frames


def timeline(delays: list[int]) -> list[int]:
    """Which frame is on screen at each tick: one entry per TICK_MS of the animation."""
    steps: list[int] = []
    for index, delay in enumerate(delays):
        steps.extend([index] * max(1, round(delay / TICK_MS)))
    return steps


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", nargs="?", default=str(DEFAULT_SOURCE))
    parser.add_argument("destination", nargs="?", default=str(DEFAULT_DESTINATION))
    parser.add_argument("--force", action="store_true", help="overwrite an existing destination")
    options = parser.parse_args()

    source = Path(options.source)
    destination = Path(options.destination)
    if not source.is_file():
        print(f"FAIL: {source} is not a file")
        return 1
    if destination.exists() and not options.force:
        print(f"FAIL: {destination} already exists (pass --force to overwrite it)")
        return 1

    source_records, loop = records(source)
    source_rgba, source_delays = frames_rgba(source)
    height, width = source_rgba[0].shape[:2]
    print(f"{source.name}: {len(source_records)} frames, {width}x{height}, "
          f"delay {sorted(set(record[5] * 10 for record in source_records))} ms, loop {loop}, "
          f"{sum(source_delays)} ms, "
          f"disposal {sorted(set(record[4] for record in source_records))}, "
          f"transparent index {sorted(set(record[7] for record in source_records))}")

    frames = mirrored_palette_frames(source)
    # `optimize=False` keeps Pillow from trimming each frame's palette and dragging the transparent
    # index along with it; `disposal=2` and the pinned index are what the source declares.
    frames[0].save(
        destination,
        save_all=True,
        append_images=frames[1:],
        duration=[record[5] * 10 for record in source_records],
        loop=loop,
        disposal=2,
        transparency=TRANSPARENT,
        optimize=False,
    )

    target_records, target_loop = records(destination)
    target_rgba, target_delays = frames_rgba(destination)
    problems: list[str] = []
    if (target_rgba[0].shape[1], target_rgba[0].shape[0]) != (width, height):
        problems.append(f"size {target_rgba[0].shape[1]}x{target_rgba[0].shape[0]} != {width}x{height}")
    if target_loop != loop:
        problems.append(f"loop {target_loop} != {loop}")
    if sum(target_delays) != sum(source_delays):
        problems.append(f"{sum(target_delays)} ms != {sum(source_delays)} ms")
    for index, record in enumerate(target_records):
        # The transparency *flag* is the requirement — a frame without it is an opaque canvas on the
        # ball. The index is required to be the pinned one, because that is what makes the pixels
        # below comparable with the source's.
        if record[4] != 2 or not record[6] or record[7] != TRANSPARENT:
            problems.append(f"frame {index} is written as disposal {record[4]}, "
                            f"transparent {record[6]} index {record[7]}")
            break
        # Not "the full canvas": Pillow writes a frame as the rectangle it has to paint, which is
        # correct for `disposal=2` as long as that rectangle is where the pixels are. What it may
        # not do is hang off the edge of the canvas.
        left, top, frame_width, frame_height = record[0:4]
        if left + frame_width > width or top + frame_height > height:
            problems.append(f"frame {index} is {frame_width}x{frame_height} at {left},{top}, "
                            f"outside the {width}x{height} canvas")
            break

    ticks = timeline(source_delays)
    steps = timeline(target_delays)
    if len(ticks) != len(steps):
        problems.append(f"{len(steps)} ticks != {len(ticks)}")
    elif not problems:
        for tick, (want_index, got_index) in enumerate(zip(ticks, steps)):
            want = source_rgba[want_index][:, ::-1]
            got = target_rgba[got_index]
            if not np.array_equal(want, got):
                difference = np.abs(want.astype(np.int16) - got.astype(np.int16))
                problems.append(f"tick {tick} ({tick * TICK_MS} ms): worst channel difference "
                                f"{int(difference.max())}, "
                                f"{int((difference.max(axis=2) > 0).sum())} pixels differ")
                break

    clear = sum(1 for frame in target_rgba if frame[:, :, 3].min() < 128)
    print(f"{destination.name}: {len(target_records)} frames, "
          f"delay {sorted(set(target_delays))} ms, loop {target_loop}, "
          f"disposal {sorted(set(record[4] for record in target_records))}, "
          f"transparent index {sorted(set(record[7] for record in target_records))}, "
          f"{clear}/{len(target_rgba)} frames show the desktop, "
          f"{destination.stat().st_size:,} bytes, {len(steps)} ticks at {TICK_MS} ms")

    if problems:
        for problem in problems:
            print(f"FAIL  {problem}")
        print("\nTHE MIRRORED FILE IS NOT RIGHT — it has been left on disk to look at")
        return 1
    print(f"\nOK: all {len(ticks)} ticks are the exact mirror of the source, pixel for pixel, with "
          f"the same transparency, delay, disposal and loop")
    return 0


if __name__ == "__main__":
    sys.exit(main())
