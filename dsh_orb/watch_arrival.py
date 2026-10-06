"""Watch what the ball wears in the seconds after its page opens.

Why this exists: the arrival is the one cosmetic in the page that is not a reaction to anything, so
there is no event anyone can send to make it happen and no reply that says it did. Its whole
definition is "on the ball, right after the page opens", and the only place that can be observed is
the screen. A unit test can prove the picker resolves the greeting's files and a static check can
prove the branch exists; neither can tell whether the user ever sees them, and for a greeting that is
the whole feature.

So this kills the helper — which is exactly what the host does when the orb is switched off, and
what it undoes by launching a new helper when it is switched back on — waits for the ball window to
be shown, and captures the ball's own square as fast as it can until the window settles. It then
scores every capture against the frames of the candidate GIFs, on the frames' opaque pixels only, so
"which clip is actually on the ball, and how far into it" is answered by the pixels rather than by an
eye. The candidates are read from `memes.json`: every file the `arrive` slot names, the resting loop,
and the shipped avatar — a sequence is only visible if each of its clips is looked for.

Usage: `watch_arrival.py [--seconds 7] [--out DIR]`
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np  # noqa: E402
from PIL import Image, ImageGrab  # noqa: E402

from capture_hover import ball_window  # noqa: E402

PACK = Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\大肥鱼表情包整合\大肥鱼表情包整合")
ASSETS = Path(r"C:\Users\digua\.dsh\profiles\desktop\node_modules\dsh-orb\dist\helper\assets")
CONFIG = Path.home() / ".dsh" / "dsh-orb" / "memes.json"


def configured(slot: str, fallback: list[str]) -> list[str]:
    """The files the live config names for one slot, in order.

    Read from `memes.json` rather than written into this probe, because the probe's whole answer is
    "which file is on the ball": names hardcoded here would keep being right about the wrong files
    the moment the slot is pointed at others — as they were when the greeting was mirrored, and
    again when a second clip was added behind the first.
    """
    try:
        slot_value = json.loads(CONFIG.read_text(encoding="utf8"))[slot]
    except Exception:
        return fallback
    if isinstance(slot_value.get("files"), list):
        names = [name for name in slot_value["files"] if isinstance(name, str) and name]
        return names or fallback
    if isinstance(slot_value.get("file"), str) and slot_value["file"]:
        return [slot_value["file"]]
    return fallback


# The files this probe has to tell apart: every clip of the greeting it is looking for, the resting
# loop that was on the ball before it and comes back after it, and the shipped avatar, which is what
# a page with no frames at all would be wearing. The greeting and the loop are the same character —
# the arrival ends on the pose the loop idles in — so the match is reported with the frame it landed
# on, and the growing part of the animation is what tells the two apart.
GREETING = configured("arrive", ["到达.gif", "打招呼 1.gif"])
CANDIDATES = [
    *[(f"greet{index + 1}", PACK / name) for index, name in enumerate(GREETING)],
    ("idle", PACK / configured("idle", ["PNGTuber 闲置.gif"])[0]),
    ("avatar", ASSETS / "deepseek-avatar-square.gif"),
]
LABELS = [label for label, _path in CANDIDATES]
MARGIN = 24


def find_window(timeout: float):
    """The ball window once it is visible, or `None` if it never turns up."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return ball_window()
        except SystemExit:
            time.sleep(0.05)
    return None


_CACHE: dict[int, dict[str, list[tuple[np.ndarray, np.ndarray]]]] = {}


def candidates_for(side: int) -> dict[str, list[tuple[np.ndarray, np.ndarray]]]:
    """The candidates at one ball size, as arrays.

    Cached per size because the size is not constant across a restart: it is the window's own
    physical/CSS ratio rounded to whole CSS pixels, and the fresh window can report 361 where the
    old one reported 360. Frames scaled for the old size compare against the new capture with a
    one-pixel border mismatch, which scores as though the file were wrong.

    The frames are converted to arrays here rather than in `score` for a reason that is about the
    measurement rather than about speed: converting 150-odd frames inside the capture loop made one
    capture take longer than the interval it was labelled with, so the timeline this probe printed
    was a fiction. Nothing inside the loop may cost more than the sampling period.
    """
    if side not in _CACHE:
        _CACHE[side] = load_candidates(side)
    return _CACHE[side]


def load_candidates(side: int) -> dict[str, list[tuple[np.ndarray, np.ndarray]]]:
    """Every frame of each candidate, at the ball's own size, as (rgb, opaque mask)."""
    loaded: dict[str, list[tuple[np.ndarray, np.ndarray]]] = {}
    for label, path in CANDIDATES:
        if not path.exists():
            continue
        frames: list[tuple[np.ndarray, np.ndarray]] = []
        with Image.open(path) as image:
            for index in range(getattr(image, "n_frames", 1)):
                image.seek(index)
                array = np.asarray(image.convert("RGBA").resize((side, side), Image.LANCZOS),
                                   dtype=np.int16)
                mask = array[:, :, 3] > 128
                if mask.sum() < 64:
                    continue
                frames.append((array[:, :, :3], mask))
        loaded[label] = frames
    return loaded


def central_square(shot: Image.Image, side: int) -> Image.Image:
    """The ball's own square out of a capture that was taken with a margin around it."""
    return shot.crop((MARGIN, MARGIN, MARGIN + side, MARGIN + side))


def score(shot: np.ndarray, frames: list[tuple[np.ndarray, np.ndarray]]) -> tuple[float, int]:
    """How far a capture is from the closest frame of one candidate, and which frame that was.

    Only the candidate's own pixels are compared, because the rest of the ball's square is whatever
    the desktop happens to show through the transparent overlay — a comparison over the whole square
    would be measuring the user's wallpaper. The frame that fits best is the candidate's score, so a
    file whose animation passes through the captured pose is not penalised for its other frames, and
    the index is what says *where in the animation* the capture was taken: for the arrival that is
    the difference between "the greeting is playing" and "the greeting has already finished and left
    the character in the pose the resting loop idles in".
    """
    best = (float("inf"), -1)
    for index, (rgb, mask) in enumerate(frames):
        difference = np.abs(shot - rgb).mean(axis=2)
        value = float(difference[mask].mean())
        if value < best[0]:
            best = (value, index)
    return best


def report(shot: np.ndarray, candidates: dict[str, list[tuple[np.ndarray, np.ndarray]]]) -> None:
    """One line: every candidate's score and matched frame, then the best of them."""
    scored = {label: score(shot, frames) for label, frames in candidates.items()}
    winner = min(scored, key=lambda label: scored[label][0])
    fields = "".join(f"{scored[label][0]:8.1f}@{scored[label][1]:<4d}"
                     for label in ("arrive", "idle", "avatar") if label in scored)
    print(f"  {fields}   {winner}#{scored[winner][1]}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=7.0)
    parser.add_argument("--out", default=r"C:\Users\digua\AppData\Local\Temp\orb-arrival")
    options = parser.parse_args()
    out = Path(options.out)
    out.mkdir(parents=True, exist_ok=True)

    window = ball_window()
    x, y, side = window.ball
    print(f"helper pid {window.pid}, ball square {x},{y} {side}px")
    before = ImageGrab.grab(bbox=(x - MARGIN, y - MARGIN, x + side + MARGIN, y + side + MARGIN),
                            all_screens=True).convert("RGB")
    before.save(out / "00-before.png")
    candidates = candidates_for(side)
    for label, frames in candidates.items():
        value, index = score(central_square(before, side), frames)
        print(f"  candidate {label}: {len(frames)} frames, score {value:.1f}@{index:02d}")
    print("  (the baseline: what the ball was wearing before the restart)")

    # Killing the helper is the same thing the host does when the orb is switched off, and its
    # launcher answers an exit with a fresh helper 500 ms later — so this is the orb being turned
    # back on, which is the moment the greeting is due.
    print(f"\nkilling helper {window.pid} — the host relaunches it, which is the orb being re-enabled")
    subprocess.run(["taskkill", "/F", "/PID", str(window.pid)], capture_output=True)

    started = time.time()
    fresh = find_window(25)
    if fresh is None:
        print("FAIL: no ball window came back within 25s; the host did not relaunch the helper")
        return 1
    shown = time.time()
    print(f"ball window back after {shown - started:.1f}s (pid {fresh.pid}) — capturing now\n")

    # The captures come first and the comparison second, and that split is the whole design of this
    # loop: scoring one shot against 140-odd frames costs more than the greeting lasts, so a loop
    # that scored as it went reported two or three points of a 1.7 s animation — it skipped the part
    # it exists to watch. Grabbing is cheap; the pixels are matched afterwards, from the files.
    print(f"  grabbing for {options.seconds:.1f}s; the table comes after\n")
    end = time.time() + options.seconds
    shots: list[tuple[float, int, Path]] = []
    index = 1
    while time.time() < end:
        try:
            current = ball_window()
        except SystemExit:
            break
        px, py, pside = current.ball
        shot = ImageGrab.grab(bbox=(px - MARGIN, py - MARGIN, px + pside + MARGIN, py + pside + MARGIN),
                              all_screens=True).convert("RGB")
        at = time.time() - shown
        path = out / f"{index:02d}-s{at:.2f}.png"
        shot.save(path)
        shots.append((at, pside, path))
        index += 1

    header = f"  {'at':>6} " + "".join(f"{label:>13}" for label in LABELS) + "   best (frame time in the file)"
    print(header)
    for at, pside, path in shots:
        with Image.open(path) as shot:
            square = np.asarray(central_square(shot.convert("RGB"), pside), dtype=np.int16)
        candidates = candidates_for(pside)
        scored = {label: score(square, frames) for label, frames in candidates.items()}
        winner = min(scored, key=lambda label: scored[label][0])
        fields = "".join(f"{scored[label][0]:8.1f}@{scored[label][1]:<4d}"
                         for label in LABELS if label in scored)
        print(f"  {at:5.2f}s{fields}   {winner}#{scored[winner][1]}"
              f" ({scored[winner][1] * 40} ms in)")

    print(f"\n{len(shots)} captures in {out}")
    if len(shots) < 4:
        print("too few captures to say anything about the greeting; the machine was busy")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
