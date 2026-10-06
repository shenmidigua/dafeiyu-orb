"""Add the `webfetch` slot to the live memes.json, right after `tool`.

Rewrites the file as UTF-8 with LF endings and 2-space indent, which is what the rest of the
config already uses, so the diff stays one added block instead of a whole-file reformat.
"""

import collections
import json
import os

PATH = os.path.join(os.path.expanduser("~"), ".dsh", "dsh-orb", "memes.json")
SLOT = {"enabled": True, "file": "打字(恼怒).gif"}

with open(PATH, encoding="utf8") as handle:
    config = json.load(handle, object_pairs_hook=collections.OrderedDict)

if config.get("webfetch") == SLOT:
    print("already set")
else:
    out = collections.OrderedDict()
    for key, value in config.items():
        out[key] = value
        if key == "tool":
            out["webfetch"] = collections.OrderedDict(SLOT)
    if "webfetch" not in out:
        out["webfetch"] = collections.OrderedDict(SLOT)
    with open(PATH, "w", encoding="utf8", newline="\n") as handle:
        json.dump(out, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    print("wrote webfetch")

# Read it back through the same parser the helper uses, so this reports what the orb will see.
with open(PATH, encoding="utf8") as handle:
    back = json.load(handle)
print("webfetch =", back.get("webfetch"))
print("tool     =", back.get("tool"))
print("dir      =", back.get("dir"))
print("bytes    =", os.path.getsize(PATH))
