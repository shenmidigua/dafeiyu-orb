#!/usr/bin/env bash
# Regenerate the wake model from the phrase lists, one stage at a time.
#
# This exists as a script rather than as a chain on the command line because of how the chain failed.
# Every stage here is long and one of them is destructive (the synthesis stage clears its group before
# writing a single replacement), and the first run hid its failure behind a pipe:
#
#     python wake_dataset.py synth --only adversarial 2>&1 | tail -6 && python wake_dataset.py features
#
# A pipeline exits with the status of its *last* command, so `tail` returned 0 for a synthesis stage
# that had died on its tenth clip behind a 503. The `&&` therefore let the next stage run on a cleared
# dataset, and the only symptom was a line of traceback among the output that had already scrolled by.
#
# So: each stage writes its whole output to a log and its exit code is what decides whether the next
# one runs. Nothing here trusts a pipe.
#
# Usage:  bash wake_retrain.sh          # the log is dsh_orb/wake_retrain.log

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE" || exit 1

PY="D:/tools/indextts/py311/python.exe"
LOG="$HERE/wake_retrain.log"

: > "$LOG"

stage() {
  local name="$1"; shift
  echo "===== $name =====" | tee -a "$LOG"
  "$PY" "$@" >> "$LOG" 2>&1
  local rc=$?
  echo "  -> $name exit $rc" | tee -a "$LOG"
  if [ "$rc" -ne 0 ]; then
    echo "  $name FAILED — stopping. The full output is $LOG" | tee -a "$LOG"
    exit "$rc"
  fi
}

# Back up the model that is about to be overwritten. This was added the hard way: running the pipeline
# twice in a row replaced a model that had taken fifty minutes to train and measured 0.0 false alarms
# per hour, leaving nothing to compare against and nothing to go back to. A model is not reproducible
# by re-running this script — the training is stochastic, and the same configuration has produced 0.0
# and 3.1 false alarms/hour in two different runs — so a replaced model is a lost model.
MODEL="$HOME/wakeword/data/features/dafeiyu.onnx"
if [ -f "$MODEL" ]; then
  BACKUP="$MODEL.$(date +%Y%m%d-%H%M%S).bak"
  cp "$MODEL" "$BACKUP"
  echo "  previous model backed up as $(basename "$BACKUP")"
fi

stage synth    wake_dataset.py synth --only adversarial
stage features wake_dataset.py features
stage train    wake_train.py --epochs 60
stage eval     wake_eval.py

echo "all stages passed; log: $LOG"
