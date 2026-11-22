"""Point `orb-wake.json` at the decoder engine, without fighting the running DSH.

Written to a temporary file and moved into place with `os.replace`, which is the only way this file
survives a reader that has it open: the host re-reads it at launch, and a half-written JSON would
leave the ball with no wake word at all.
"""

import json
import os
import pathlib
import tempfile

PATH = pathlib.Path(r"C:\Users\digua\.dsh\profiles\desktop\orb-wake.json")


def main() -> None:
    settings = json.loads(PATH.read_text(encoding="utf-8"))
    settings["engine"] = "sherpa"
    settings["keyword"] = "xiaodi"
    settings["enabled"] = True
    handle, temporary = tempfile.mkstemp(dir=str(PATH.parent), prefix="orb-wake-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(settings, out, ensure_ascii=False, indent=2)
            out.write("\n")
        os.replace(temporary, PATH)
    except BaseException:
        pathlib.Path(temporary).unlink(missing_ok=True)
        raise
    print(PATH.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
