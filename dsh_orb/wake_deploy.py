"""Move a freshly trained keyword model into the directory the orb actually loads.

Why this is a script and not a `cp`: the two files live in different places on purpose — training
writes to its own output directory and the orb reads from the asset directory named in its settings —
so the deployment is the one step that connects them, and nothing else notices when it does not
happen. That is not hypothetical. The model left behind by the previous round of phrase work sat in
the training directory while `orb-wake.json` went on pointing at an older file, and a round of
acceptance probes passed against a model nobody was running. Every number was correct and every
number was about the wrong file.

So the questions this asks are the ones that were missing: is the source newer than what is deployed,
are they actually different, and did the same bytes arrive.

The backup is named after the model being replaced, never overwritten, and refused if the name is
already taken — a backup that silently replaces an older backup is how the thing you wanted to go
back to disappears.

A deploy does **not** take effect until DSH is restarted; the helper loads the model once, when its
engine starts. This prints that rather than doing it, because the restart is the user's call.

Usage:  python wake_deploy.py [--from PATH] [--tag NAME] [--dry-run]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import sys
import time

HERE = pathlib.Path(__file__).parent
DEFAULT_SOURCE = pathlib.Path(r"C:\Users\digua\wakeword\data\features\dafeiyu.onnx")
SETTINGS = pathlib.Path.home() / ".dsh" / "profiles" / "desktop" / "orb-wake.json"


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def deployed_model() -> pathlib.Path:
    """The file the orb loads, from the orb's own settings rather than from a retyped path."""
    settings = json.loads(SETTINGS.read_text(encoding="utf8"))
    directory = pathlib.Path(settings["assetDirectory"])
    keyword = settings["keyword"]
    return directory / f"{keyword}.onnx"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--from", dest="source", type=pathlib.Path, default=DEFAULT_SOURCE)
    parser.add_argument("--tag", default=time.strftime("%Y-%m-%d"),
                        help="what the model being replaced is backed up as")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source: pathlib.Path = args.source
    if not source.exists():
        print(f"  nothing to deploy: {source} does not exist")
        return 1

    try:
        target = deployed_model()
    except Exception as error:  # noqa: BLE001
        print(f"  cannot read the orb's settings ({type(error).__name__}: {error})")
        print(f"  looked in {SETTINGS}")
        return 1

    print(f"  from: {source}")
    print(f"  to:   {target}")

    source_digest = digest(source)
    if target.exists() and digest(target) == source_digest:
        print()
        print("  the deployed model is already these exact bytes — nothing to do.")
        print("  (If the orb is still behaving like the old one, it is the restart that is missing,")
        print("   not the copy: the helper loads the model once, when its engine starts.)")
        return 0

    if target.exists():
        before = digest(target)
        print(f"  replacing {before[:16]}  ({target.stat().st_size} bytes, "
              f"{time.strftime('%Y-%m-%d %H:%M', time.localtime(target.stat().st_mtime))})")
    else:
        print("  no model is deployed yet")

    if args.dry_run:
        print()
        print("  --dry-run: nothing was written.")
        return 0

    if target.exists():
        backup = target.with_name(f"{target.name}.{args.tag}.bak")
        if backup.exists():
            print()
            print(f"  refusing to overwrite {backup.name} — it already holds a backup.")
            print("  Pass a different --tag if this is a genuinely different deployment; a backup")
            print("  that eats the previous backup is not a backup.")
            return 1
        shutil.copy2(target, backup)
        print(f"  backed up to {backup.name} ({digest(backup)[:16]})")

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, target)

    after = digest(target)
    if after != source_digest:
        print()
        print(f"  *** the copy does not match the source ({after[:16]} against {source_digest[:16]}) ***")
        return 1
    print(f"  deployed {after[:16]}  ({target.stat().st_size} bytes), verified byte for byte")

    print()
    print("  The orb is still running the previous model: the helper loads it once, when its engine")
    print("  starts. Restart DSH for this to take effect.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
