"""Run the whole wake-word pipeline, or any contiguous part of it.

There are six steps and they have to happen in order, each depending on the last one's artefacts:

    1. synth     Edge TTS -> data/positives, data/negatives        (~4 min)
    2. features  audio -> (28, 96) windows in the renderer's format (~13 min)
    3. train     features -> dafeiyu.onnx + dafeiyu.pt             (~3 min)
    4. eval      held-out thresholds, false-alarm rate             (~2 min)
    5. probe     which near-miss phrases fire, by name              (~1 min)
    6. install   copy the model, point orb-wake.json at it, restart DSH

Re-running is expected, not exceptional: the model is fitted to synthetic speech, and the one thing
that would improve it most is the user's own voice. So the steps are selectable, and the two cheap
diagnostics (4 and 5) are separate from the two expensive generators (1 and 2).

Step 6 is the only one that touches the machine outside this directory. It stops DSH, rewrites
`orb-wake.json`, and starts DSH again, because the profile settings are read once at host startup and
rewritten from memory afterwards — editing the file while the app runs loses the edit. `--yes` is
required to let it run; without it the step prints what it would do.

Usage:
    wake_pipeline.py --from features               # retrain on data already on disk
    wake_pipeline.py --from synth --to features     # regenerate audio and features
    wake_pipeline.py --from train                  # train, evaluate, probe
    wake_pipeline.py --from install --yes           # deploy and restart
    wake_pipeline.py --list
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).parent
PYTHON = r"D:\tools\indextts\py311\python.exe"

DATA = pathlib.Path(r"C:\Users\digua\wakeword\data")
FEATURE_DIR = DATA / "features"
MODEL = FEATURE_DIR / "dafeiyu.onnx"

PROFILE = pathlib.Path(r"C:\Users\digua\.dsh\profiles\desktop")
WAKE_CONFIG = PROFILE / "orb-wake.json"

KEYWORD = "dafeiyu"
# Written into orb-wake.json by the `install` stage, so this is the value that gets shipped when the
# pipeline deploys a freshly trained model.
#
# The owner asked for silence over recall on 2026-10-04, so the rule is the same one `wake_eval.py`
# applies when it reports a `chosen` threshold: take the highest threshold whose held-out recall
# stays at or above 97%.
#
# The number below is a default, not the answer. The wake word is now the phrase said twice, and the
# threshold that suits it is a property of the model that comes out of training — so the honest way to
# set it is to read `chosen.threshold` back out of `features/dafeiyu-eval.json`, which `wake_eval.py`
# writes, and pass it to the install stage. Editing this constant by hand is how it goes stale.
THRESHOLD = 0.95

STAGES = ["synth", "features", "train", "eval", "probe", "install"]
COST = {"synth": "~4 min, needs the Edge read-aloud service",
        "features": "~13 min, CPU bound",
        "train": "~3 min on the GPU",
        "eval": "~2 min, held-out folds only",
        "probe": "~1 min, fresh TTS clips"
        }


def run(stage: str, args: argparse.Namespace) -> None:
    """One stage, as the same command a person would type."""
    if stage == "synth":
        command = [PYTHON, str(HERE / "wake_dataset.py"), "synth"]
    elif stage == "features":
        command = [PYTHON, str(HERE / "wake_dataset.py"), "features"]
    elif stage == "train":
        command = [PYTHON, str(HERE / "wake_train.py"), "--epochs", str(args.epochs)]
    elif stage == "eval":
        command = [PYTHON, str(HERE / "wake_eval.py")]
    elif stage == "probe":
        command = [PYTHON, str(HERE / "wake_probe_phrases.py"),
                   "--threshold", str(args.threshold)]
    elif stage == "install":
        install(args)
        return
    else:
        raise SystemExit(f"unknown stage {stage!r}")

    print(f"$ {' '.join(command[1:])}", flush=True)
    result = subprocess.run(command, cwd=str(HERE))
    if result.returncode != 0:
        raise SystemExit(f"stage {stage!r} failed with exit code {result.returncode}")


def install(args: argparse.Namespace) -> None:
    """Put the model where the engine looks, point the profile at it, restart the app."""
    if not MODEL.exists():
        raise SystemExit(f"{MODEL} does not exist; train first")

    config = json.loads(WAKE_CONFIG.read_text(encoding="utf-8"))
    assets = pathlib.Path(config["assetDirectory"])
    target = assets / f"{KEYWORD}.onnx"

    planned = (f"copy {MODEL.name} -> {target}\n"
               f"set keyword  {config['keyword']!r} -> {KEYWORD!r}\n"
               f"set threshold {config['threshold']} -> {args.threshold}\n"
               f"stop DSH, then start it again")
    if not args.yes:
        print("would do:\n  " + planned.replace("\n", "\n  "))
        print("\n(no --yes, so nothing was changed)")
        return

    shutil.copy2(MODEL, target)
    # Copied rather than written from a template: `require_clip_embeddings` is not the only field the
    # host validates, and a file missing one of them is silently reset to defaults on next launch.
    backup = WAKE_CONFIG.with_name(WAKE_CONFIG.name + ".bak-before-install")
    shutil.copy2(WAKE_CONFIG, backup)
    config["keyword"] = KEYWORD
    config["threshold"] = args.threshold
    WAKE_CONFIG.write_text(json.dumps(config, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"installed {target}")
    print(f"backed up the previous settings to {backup.name}")

    # The app has to be down while the file is edited, so the restart script does both halves.
    result = subprocess.run([PYTHON, str(HERE / "restart_dsh.py")], cwd=str(HERE))
    if result.returncode != 0:
        raise SystemExit("restart failed; check for a visible '桌面 agent' window")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="first", choices=STAGES, default="features",
                        help="first stage to run (default: features)")
    parser.add_argument("--to", dest="last", choices=STAGES, default="probe",
                        help="last stage to run (default: probe; 'install' must be asked for)")
    parser.add_argument("--only", choices=STAGES, help="run exactly one stage")
    # 60 rather than 40: the task is now to tell a phrase said twice from the same phrase said once,
    # which is a finer distinction than "is this word present", and the earlier single-word model only
    # settled after 60. The cost is seconds and the difference shows up as recall, so err long.
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--threshold", type=float, default=THRESHOLD)
    parser.add_argument("--yes", action="store_true",
                        help="actually perform the install stage; it stops and restarts DSH")
    parser.add_argument("--list", action="store_true", help="describe the stages and exit")
    args = parser.parse_args()

    if args.list:
        for stage in STAGES:
            print(f"  {stage:9} {COST.get(stage, 'stops and restarts DSH')}")
        return 0

    if args.only:
        selected = [args.only]
    else:
        first, last = STAGES.index(args.first), STAGES.index(args.last)
        if last < first:
            raise SystemExit(f"--to {args.last} comes before --from {args.first}")
        selected = STAGES[first:last + 1]

    for index, stage in enumerate(selected, 1):
        print()
        print(f"===== [{index}/{len(selected)}] {stage} =====")
        run(stage, args)
    print()
    print("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
