"""Which clip files the ball has read since a baseline, by access time.

The page reads every configured frame once at load, so a file access time alone says nothing. What does say
something is a file read *after* that sweep, which is what this records: a baseline, then a comparison.

Usage:
    python dsh_orb/watch_clip_reads.py snapshot <baseline.json>
    python dsh_orb/watch_clip_reads.py compare  <baseline.json>
"""

import json
import os
import sys

PACK = os.path.join(os.path.expanduser('~'), 'Desktop', 'dsh-orb-cordis', '大肥鱼表情包整合', '大肥鱼表情包整合')


def clips():
    found = {}
    for root, _dirs, files in os.walk(PACK):
        for name in files:
            if name.lower().endswith('.gif'):
                path = os.path.join(root, name)
                found[path] = os.stat(path).st_atime
    return found


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 1
    action, path = sys.argv[1], sys.argv[2]
    now = clips()
    if action == 'snapshot':
        with open(path, 'w', encoding='utf-8') as handle:
            json.dump(now, handle)
        print(f'baseline: {len(now)} clips recorded at {max(now.values()):.0f}')
        return 0
    with open(path, encoding='utf-8') as handle:
        before = json.load(handle)
    later = sorted(
        ((at, os.path.basename(name)) for name, at in now.items() if at > before.get(name, 0) + 1),
        reverse=True,
    )
    if not later:
        print('no clip has been read since the baseline')
        return 0
    print(f'{len(later)} clip(s) read since the baseline, newest first:')
    for at, name in later:
        import datetime
        when = datetime.datetime.fromtimestamp(at).strftime('%H:%M:%S')
        print(f'  {when}  {name}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
