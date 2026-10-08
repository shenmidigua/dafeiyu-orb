/**
 * Rebuild the three local commits with byte-clean messages.
 *
 * `git commit -F <file>` was handed files written by PowerShell's `Set-Content -Encoding utf8`, which
 * prefixes a BOM — so the commit subjects began with an invisible U+FEFF that shows up in `git log` as a
 * stray character. The commits have not been published, so this rewrites them: the tree at `HEAD` is
 * untouched, only the history's shape and its messages are redone, and each message is written here as
 * UTF-8 with no BOM rather than through a shell.
 *
 * Usage: `node dsh_orb/rebuild_commits.mjs`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'b55eccc'
const REPO = 'C:/Users/digua/Desktop/dsh-orb-cordis'

/** Each commit: the message, and the paths it owns — `null` for "whatever is left". */
const COMMITS = [
  {
    message: [
      'Give the docked strip a ball to come out of, and a clip to greet with',
      '',
      'Docking hides the ball behind a 34px strip against a screen edge, and until now the strip had one',
      'job: a drag pulls the ball back out. This adds the other half — a hover brings the ball half way out',
      'of the edge and plays the arrival clip the pack names for the strip — and then fixes what that half',
      'got wrong.',
      '',
      '   * the ball is *shown*, not handed over: the peek is the helper growing the window and one body',
      '     class, and a hover still never unsnaps anything.',
      '   * the hand-off is timed by the clip\'s own measured length, not by a constant on the page. It was',
      '     1280ms, measured once against a file that was later cut from 30 frames to 22; the 400ms left',
      '     over let the entrance start its second pass before the loop replaced it, which reads as "it',
      '     played once and then played the beginning again".',
      '   * a picture with nothing decoded yet is not drawn at all. Docked and peeked, an <img> waiting on a',
      '     source painted Chromium\'s broken-image box — a white rectangle with a glyph in its corner — for',
      '     as long as a decode took. `removeAttribute(\'src\')` is the case that got through: it fires no',
      '     event, so nothing undid `ball-drawn`, and the stylesheet\'s `body.docked:not(.ball-drawn)',
      '     #ball-gif { visibility: hidden }` never applied. Measured in Chromium: 142 lit pixels of broken',
      '     box before, 0 after.',
      '   * the wait before the entrance was 121ms of the 127ms between a hand reaching the strip and the',
      '     entrance appearing, which is most of what the hand feels on a thing it touched on purpose. It is',
      '     zero now; the arm/drop structure is kept so the threshold can be restored by changing one number.',
      '   * the two edges want mirrored pictures, so the pack can name a `left` entrance and `leftLoop`: the',
      '     same clip on both edges unless it says otherwise, and the left edge falls back rather than going',
      '     silent when the file it names is missing.',
      '   * the docked picture\'s shift is a property of how a clip was drawn, so it is a rule per edge: the',
      '     mirrored clips are pulled left (-44px), the unmirrored left-edge pair right (+44px). At -44 the',
      '     left pair had 86 of its 144 visible pixels carrying any picture.',
      '',
      'Covered by `ball-picture.test.ts` (the two ways a picture is taken away), `dock-arrive.test.ts` (the',
      'dwell, the hand-over, the teardown, the edge selection) and `memes.test.ts` (the per-edge slot as the',
      'config reader resolves it).',
    ].join('\n'),
    paths: [
      'packages/helper/assets/shell.js',
      'packages/helper/assets/floating.css',
      'packages/helper/assets/floating.html',
      'packages/helper/preload.cjs',
      'packages/helper/src/geometry.ts',
      'packages/helper/src/main.ts',
      'packages/helper/src/memes.ts',
      'packages/helper/tests/geometry.test.ts',
      'packages/helper/tests/drop-frame.test.ts',
      'packages/helper/tests/speak-frame.test.ts',
      'packages/helper/tests/transcript-model.test.ts',
      'packages/helper/tests/webfetch-frame.test.ts',
      'packages/helper/tests/ask-frame.test.ts',
      'packages/helper/tests/ball-picture.test.ts',
      'packages/helper/tests/dock-arrive.test.ts',
      'packages/helper/tests/dock-tab-drag.test.ts',
      'packages/helper/tests/skit-playback.test.ts',
      'packages/helper/tests/memes.test.ts',
    ],
  },
  {
    message: [
      'Let a failed run end in tears, and a cancelled one end in nothing',
      '',
      'The ball had one finished-task face, so every turn that ended rang the bell — including a stop the',
      'user pressed and a turn a crash left open. `TurnEndReason` is the vocabulary that settles it, and',
      '`readTurnEnding` reads it: `error` (with the `LlmFailure` the request threw) wears the failure face,',
      '`aborted` does nothing at all, and only a turn that ran to its own end is a finished task. The reason',
      'travels with `turn/end` because that is the only moment the ball can act on it.',
    ].join('\n'),
    paths: ['packages/host/src/orb.ts', 'packages/host/src/failure.ts', 'packages/host/tests/failure.test.ts'],
  },
  {
    message: [
      'Keep the pack\'s arrival clips, and the probes that measured them',
      '',
      'The two new clips are the pack\'s own content, alongside the 216 already tracked here, and the rest of',
      'this is what proved the docked-strip fixes rather than asserting them:',
      '',
      '  * `probe_dock_empty` renders the peek\'s own sequence — the real stylesheet, the real',
      '    `armBallPicture`, the real GIF — and counts the pixels: the broken-image box is 142 lit pixels',
      '    before the fix and 0 after, while the frames that were already right are unchanged to the pixel.',
      '  * `walk_dock_hand` walks the page\'s own `beginDockArrive`/`openDockPeek` over real timers, which is',
      '    how "the wait is 121ms of the 127ms" was measured.',
      '  * `walk_dock_shift_rect` reads the drawn box back from the page itself, which is what the block of',
      '    screenshot-based probes could not do: the ball\'s window is transparent and frameless, and a',
      '    capture of it comes back with the composited content missing.',
      '  * `restart_helper.py` respawns the helper so a just-installed asset is actually loaded, and proves',
      '    it came back — the page is read once, at startup, so a copied file changes nothing on its own. It',
      '    reads process command lines out of the target\'s own PEB, since `powershell` is not on the PATH in',
      '    this session.',
    ].join('\n'),
    paths: null,
  },
]

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })

// The tree is captured first and re-applied at the end: the rewrite moves branches, and the working tree
// is what the commits are supposed to describe.
const status = git('status', '--porcelain')
// The only things that may be uncommitted are this script (it lands in the last commit) and the test file
// that belongs to the first: `git reset --soft` is about to make those the index again.
const allowed = [/^\s*M\s+packages\/helper\/tests\/memes\.test\.ts$/, /^\?\?\s+dsh_orb\/rebuild_commits\.mjs$/]
const unexpected = status.trim().split('\n').filter((line) => line !== '' && !allowed.some((pattern) => pattern.test(line)))
if (unexpected.length > 0) {
  console.error('FAIL  the working tree has changes this script does not expect:')
  console.error(unexpected.join('\n'))
  process.exit(1)
}

for (const [index, commit] of COMMITS.entries()) {
  const messageFile = join(tmpdir(), `dsh-orb-commit-${index + 1}.txt`)
  writeFileSync(messageFile, commit.message + '\n', { encoding: 'utf8' })
  // A BOM would land in the subject, which is the whole reason this exists: check before committing.
  const bytes = readFileSync(messageFile)
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    console.error('FAIL  the message file still starts with a BOM')
    process.exit(1)
  }
  commit.messageFile = messageFile
}

git('reset', '--soft', BASE)
console.log(`reset to ${BASE}; the index now holds every change as staged`)

// Start from nothing staged, so each commit is exactly its own paths.
git('reset')
for (const [index, commit] of COMMITS.entries()) {
  if (commit.paths === null) git('add', '--all')
  else git('add', '--', ...commit.paths)
  const staged = git('diff', '--cached', '--name-only').trim().split('\n').filter(Boolean)
  if (staged.length === 0) {
    console.error(`FAIL  commit ${index + 1} would be empty`)
    process.exit(1)
  }
  git('commit', '-F', commit.messageFile)
  const subject = git('log', '-1', '--format=%s')
  const first = Buffer.from(subject, 'utf8').subarray(0, 3)
  if (first[0] === 0xef && first[1] === 0xbb && first[2] === 0xbf) {
    console.error(`FAIL  commit ${index + 1} kept a BOM in its subject`)
    process.exit(1)
  }
  console.log(`committed ${staged.length} path(s): ${subject}`)
}

console.log('\n--- history ---')
console.log(git('log', '--oneline', '-4').trim())
console.log('\n--- working tree ---')
const after = git('status', '--porcelain')
console.log(after.trim() === '' ? 'clean' : after.trim())
