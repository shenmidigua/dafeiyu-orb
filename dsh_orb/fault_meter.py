"""Break one thing about the live wake meter, run the tests, put it back.

`wake-meter.test.ts` passes on correct code, which proves nothing until it has been seen to fail on
each way the meter can go wrong. Nineteen faults, one per way, split across the two halves:

    engine half — the score the meter is fed
    1  the score is only reported when a window fires        (nothing to watch until the ball wakes)
    2  the report also crosses IPC                           (helper on the hot path, 8x a second)
    3  `reset()` does not clear it                           (a live-looking score for a dead ring)
    4  the page's `onScore` is not isolated from the engine  (a broken meter stops the microphone)

    page half — what the meter draws
    5  the bar is not clamped                                (a stray score paints outside the track)
    6  the threshold line is drawn at a fixed place          (it explains a rule nobody is running)
    7  the dots are not built from the rule                  (the picture disagrees with the rule)
    8  `hot` is never set                                    (over the line looks the same as under)
    9  a report is trusted without checking it is a number   (NaN overwrites the last real reading)

    page half — when it is on screen
    10 the meter is never hidden                             (a live-looking score over a dead mic)
    11 the meter is not redrawn when it comes up             (it opens on the last stream's reading)
    12 a detection is not enough to keep it up               (the bar drops exactly when it is read)
    13 the wait for a transcript is treated as unscored      (a wake in it chimes with no reading)
    14 a recording is treated as scored                      (a frozen reading shown as a live one)

    page half — the reading that fired
    15 the fired reading is never held                       (nothing left to read when the chime lands)
    16 it is held after the chime, not with it               (the bar explains the wake a beat late)
    17 the hold never ends                                   (a stale reading outlives its reason)
    18 the hold is not drawn in preference to the live one   (the next window wipes the record)
    19 a rising reading is animated too                      (the fill is still climbing at the chime)

    page half — the hold's own edges
    20 the expiry does not ask the page to re-decide the screen  (the bar stays up over nothing)
    21 an expired hold's late timer cancels the newer one        (a fresh reading is cut short)
    22 taking a hold draws it without re-deciding the screen     (hidden on the frame it chimed in)

Fault 13 is the one the user reported: the bar was hidden for the whole post-recording wait while
the engine was scoring it, so a wake that landed in that stretch chimed with the meter off screen.

Faults 17, 20 and 21 are the three separate things the hold's ending needs, and each was blind on the
first run of this sweep. `heldWake()`'s `expiresAt` comparison and the timer's own clear are two
guards on the same condition, so removing either alone changes nothing observable: 17 therefore
removes the *expiry* itself (`Infinity`) rather than one of the guards that test it. 20 and 21 are
what the guards are each individually for.

Usage:  python fault_meter.py <1..22|restore>

Line endings are read as bytes and matched on a normalised copy, because a plain `str.replace` on a
`\\n` needle silently finds nothing in a CRLF file - which looks exactly like "the fault was never
applied" and quietly invalidates the whole check.
"""

import os
import shutil
import sys

ROOT = r"C:\Users\digua\Desktop\dsh-orb-cordis\packages\helper\assets"
WAKE = os.path.join(ROOT, "wake.js")
SHELL = os.path.join(ROOT, "shell.js")
BACKUP_DIR = r"C:\Users\digua\AppData\Local\Temp"

REPORT = """      this.emitScore(score, score > this.config.threshold, this.hotStreak)
      if (this.hotStreak >= CONSECUTIVE_WINDOWS) {
"""

RESET_CLEAR = """    // The meter has nothing left to show: the ring it would have been scoring is gone. Without this
    // the bar keeps the last reading of the stream that just ended, which reads as a live score for
    // audio nobody is speaking.
    this.emitScore(0, false, 0)
"""

EMIT = """    try {
      this.onScore({ score, above, streak, threshold: this.config.threshold })
    } catch {
      /* the ball's cosmetics must never break the engine */
    }
"""

# (file, needle, replacement) - the replacement is inert text where the point is that something
# stops happening.
FAULTS = {
    1: (WAKE, REPORT, """      if (this.hotStreak >= CONSECUTIVE_WINDOWS) {
        this.emitScore(score, true, this.hotStreak)
"""),
    2: (WAKE, """      this.onScore({ score, above, streak, threshold: this.config.threshold })
""", """      this.onScore({ score, above, streak, threshold: this.config.threshold })
      void this.api.wakeReport(this.status())
"""),
    3: (WAKE, RESET_CLEAR, ""),
    4: (WAKE, EMIT, """    this.onScore({ score, above, streak, threshold: this.config.threshold })
"""),
    5: (SHELL, """    wakeMeter.style.setProperty('--wake-score', String(Math.min(1, Math.max(0, score))))
""", """    wakeMeter.style.setProperty('--wake-score', String(score))
"""),
    6: (SHELL, """    wakeMeter.style.setProperty('--wake-threshold', String(Math.min(1, Math.max(0, wakeThreshold))))
""", """    wakeMeter.style.setProperty('--wake-threshold', '0.95')
"""),
    7: (SHELL, """    for (let i = 0; i < CONSECUTIVE_WINDOWS; i += 1) {
""", """    for (let i = 0; i < 4; i += 1) {
"""),
    8: (SHELL, """    wakeMeter.classList.toggle('hot', above)
""", """    wakeMeter.classList.toggle('hot', false)
"""),
    9: (SHELL, """    if (typeof update.score === 'number' && Number.isFinite(update.score)) wakeScore = update.score
""", """    if (typeof update.score === 'number') wakeScore = update.score
"""),
    10: (SHELL, """      wakeMeter.hidden = !meterVisible
""", """      wakeMeter.hidden = false
"""),
    11: (SHELL, """      if (meterVisible) paintWakeMeter()
""", ""),
    12: (SHELL, """    const scoring = !recording && (listening || wakeState === 'detected' || transcribing)
""", """    const scoring = !recording && listening
"""),
    # The reported bug. `runModels` goes back to scoring the moment the recorder lets go of the
    # microphone, so the whole transcript wait is scored audio; hiding the bar for it hides a live
    # reading, and a wake that lands in it is a chime with nothing beside it.
    13: (SHELL, """    const scoring = !recording && (listening || wakeState === 'detected' || transcribing)
""", """    const scoring = !recording && (listening || wakeState === 'detected')
"""),
    # The mirror image, and the reason the rule is not simply "listening or detected": while the
    # recorder has the microphone nothing is scored, so the bar is frozen at the last reading of a
    # finished stream and reads as a live one.
    14: (SHELL, """    const scoring = !recording && (listening || wakeState === 'detected' || transcribing)
""", """    const scoring = listening || wakeState === 'detected' || transcribing
"""),
    15: (SHELL, """    holdWake(wakeScoreIn(status.detail))
""", ""),
    16: (SHELL, """    holdWake(wakeScoreIn(status.detail))
    // The acknowledgement comes first: it has to be on screen before the panel opens and
    // before the recorder takes over, because it is the only sign that the ball heard its
    // name rather than merely the sound of someone talking to it.
    playWakeFrame()
""", """    // The acknowledgement comes first: it has to be on screen before the panel opens and
    // before the recorder takes over, because it is the only sign that the ball heard its
    // name rather than merely the sound of someone talking to it.
    playWakeFrame()
    // The reading is kept, but only once the sound is already on its way out.
    holdWake(wakeScoreIn(status.detail))
"""),
    # Not "drop one of the two guards" - either of them alone still ends the hold, because they test
    # the same condition. This removes the condition: the hold has no expiry at all, so `heldWake()`
    # keeps handing back a reading that fired minutes ago and the meter never goes down.
    17: (SHELL, """    const expiresAt = Date.now() + WAKE_HOLD_MS
""", """    const expiresAt = Infinity
"""),
    18: (SHELL, """    const held = heldWake()
    const score = held === undefined ? wakeScore : held.score
    const above = held === undefined ? wakeAbove : true
    const streak = held === undefined ? wakeStreak : CONSECUTIVE_WINDOWS
""", """    const held = undefined
    const score = wakeScore
    const above = wakeAbove
    const streak = wakeStreak
"""),
    19: (SHELL, """    if (wakeMeterFill !== null) wakeMeterFill.classList.toggle('falling', score <= wakeDrawn)
""", """    if (wakeMeterFill !== null) wakeMeterFill.classList.toggle('falling', true)
"""),
    # The two guards on the hold's ending each do a job the other cannot. This one drops the guard's
    # *work*: the reading is still let go on time, but nothing asks the page whether the meter still
    # belongs on screen, so a hold that was the only thing keeping the bar up leaves it up.
    20: (SHELL, """      wakeHeld = undefined
      // The hold is also what can be keeping the meter on screen, and it is the only state that
      // ends by itself: without this the bar would stay up over a microphone nothing is scoring.
      syncWake()
""", """      wakeHeld = undefined
"""),
    # And this one drops the guard itself. It only shows up when two holds overlap: `clearTimeout`
    # cannot be relied on to have silenced the first one's timer, so the check is what stops an
    # expired hold from cancelling a newer reading that is still live.
    21: (SHELL, """      if (wakeHeld === undefined || wakeHeld.expiresAt > Date.now()) return
      wakeHeld = undefined
""", """      wakeHeld = undefined
"""),
    # The hold is one of the two things that can keep the bar on screen, so taking one has to
    # re-decide the screen. Drawing alone only touches the half that cannot bring the bar back: the
    # reading is there and not shown.
    22: (SHELL, """    syncWake()
  }

  /**
   * The held reading while its hold lasts, or undefined.
""", """    paintWakeMeter()
  }

  /**
   * The held reading while its hold lasts, or undefined.
"""),
}

TARGETS = {1: WAKE, 2: WAKE, 3: WAKE, 4: WAKE, 5: SHELL, 6: SHELL, 7: SHELL, 8: SHELL, 9: SHELL,
           10: SHELL, 11: SHELL, 12: SHELL, 13: SHELL, 14: SHELL, 15: SHELL, 16: SHELL, 17: SHELL,
           18: SHELL, 19: SHELL, 20: SHELL, 21: SHELL, 22: SHELL}


def backup_path(path: str) -> str:
    return os.path.join(BACKUP_DIR, "wake.meter.good." + os.path.basename(path))


def read(path: str) -> str:
    with open(path, "rb") as handle:
        return handle.read().decode("utf8")


def write(path: str, text: str) -> None:
    with open(path, "wb") as handle:
        handle.write(text.encode("utf8"))


def main() -> int:
    if len(sys.argv) != 2 or (sys.argv[1] != "restore" and sys.argv[1] not in {str(k) for k in FAULTS}):
        print(__doc__)
        return 2

    # Every file this script can touch gets a good copy taken once. Re-copying on each call makes a
    # loop of inject/restore walk the source towards the last fault injected, and the final "restore"
    # then restores that instead of the good version.
    for path in (WAKE, SHELL):
        good = backup_path(path)
        if not os.path.exists(good):
            shutil.copyfile(path, good)
            print(f"backed up {os.path.basename(path)} to {good}")

    if sys.argv[1] == "restore":
        for path in (WAKE, SHELL):
            shutil.copyfile(backup_path(path), path)
        print("restored both files")
        return 0

    number = int(sys.argv[1])
    path, needle, replacement = FAULTS[number]
    source = read(path)
    crlf = "\r\n" in source
    text = source.replace(needle.replace("\n", "\r\n"), replacement.replace("\n", "\r\n"))
    if text == source:
        text = source.replace(needle, replacement)
    if text == source:
        print(f"FAULT {number} NOT APPLIED - the needle is not in {os.path.basename(path)}")
        return 1
    write(path, text)
    print(f"fault {number} applied to {os.path.basename(path)} (crlf={crlf})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
