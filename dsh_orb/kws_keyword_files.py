"""Split the four-word keyword file into one file per wake word, for the ball to pick from.

sherpa-onnx's spotter is started with a single keywords file and fires on any line in it. The menu
lets the user choose one phrase, so the engine has to be given only that phrase's line — otherwise
choosing `xiaodi` would also wake on `dacheng`. Each output is named after the same stem the menu
uses, so the mapping is a filename rather than an index that drifts when the list is reordered.
"""

import pathlib

SOURCE = pathlib.Path(r"C:\Users\digua\wakeword\kws-test\keywords.txt")
TARGET = pathlib.Path(r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets\kws")

# Stem -> the phrase that line was generated from. Same stems as `WAKE_SPOKEN_NAMES` in the helper.
WORDS = {
    "xiaodi": "小弟小弟",
    "xiaohui": "小慧小慧",
    "dacheng": "大成大成",
    "dafeiyu": "大肥鱼大肥鱼",
}


def main() -> None:
    lines = [line.strip() for line in SOURCE.read_text(encoding="utf-8").splitlines() if line.strip()]
    by_phrase = {}
    for line in lines:
        if "@" in line:
            by_phrase[line.rsplit("@", 1)[-1]] = line
    for stem, phrase in WORDS.items():
        line = by_phrase.get(phrase)
        if line is None:
            print(f"missing: {phrase}")
            continue
        target = TARGET / f"keywords-{stem}.txt"
        target.write_text(line + "\n", encoding="utf-8")
        print(f"{stem}: {target.name}")


if __name__ == "__main__":
    main()
