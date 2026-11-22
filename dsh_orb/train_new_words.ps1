# Train the three new wake words, one stage at a time, and stop on the first failure.
#
# Same shape as wake_retrain.sh, and for the same reason: every stage here is long and the synthesis
# stage is destructive (it clears its group before writing a single replacement), so nothing may run
# on the back of a pipeline's exit code. Each stage writes its whole output to the log and its exit
# code alone decides whether the next stage runs.
#
# Every stage is also skipped when its output is already there, so a chain that died in `eval` can be
# run again without spending twenty minutes recomputing features that are correct on disk. Use -Redo
# to force the full sequence (the synthesis stage still refuses to wipe complete clip sets).
#
# Usage:  pwsh -File train_new_words.ps1            # all three words
#         pwsh -File train_new_words.ps1 xiaodi     # one of them
#         pwsh -File train_new_words.ps1 -Redo      # recompute everything

param(
  [string[]]$Phrases = @('xiaodi', 'xiaohui', 'dacheng'),
  [switch]$Redo
)

$ErrorActionPreference = 'Stop'
$here = 'C:\Users\digua\Desktop\dsh-orb-cordis\dsh_orb'
$py = 'D:/tools/py311/python.exe'
$log = Join-Path $here 'new-words-chain.log'
$data = Join-Path $env:USERPROFILE 'wakeword\data'
$features = Join-Path $data 'features'

# The compact grid: 14 voices x 5 carriers x 3 rates for the positives, plus the shared filler that
# no keyword is listening for. Both numbers come from wake_dataset.py's own task lists.
$positiveCount = 210
# Two of the 1722 adversarial clips are allowed to fail: the endpoint drops a few on every run, and
# treating that as "incomplete" would send the stage back through the destructive clear.
$negativeCount = 4680

Set-Location $here
"chain started at $(Get-Date -Format o) (redo: $($Redo.IsPresent))" | Out-File -FilePath $log -Encoding utf8

function Say([string]$line) {
  $line | Tee-Object -FilePath $log -Append | Out-Host
}

function Stage([string]$name, [string]$skipWhen, [string[]]$arguments) {
  # Non-empty, not merely present: a stage that died writing its array leaves a 0-byte `.npy`
  # behind, and `Test-Path` alone would then skip the very stage that has to run. That is how the
  # first big-cheng attempt looked — the skip said the features were there, the trainer read an
  # empty file, and the log blamed neither.
  $ready = $skipWhen -ne '' -and (Test-Path $skipWhen) -and ((Get-Item -LiteralPath $skipWhen).Length -gt 0)
  if (-not $Redo -and $ready) {
    Say "  $name skipped: $skipWhen is already on disk"
    return
  }
  Say "===== $name ====="
  $output = & $py @arguments 2>&1 | Out-String
  $output | Out-File -FilePath $log -Append -Encoding utf8
  $code = $LASTEXITCODE
  Say "  -> $name exit $code"
  if ($code -ne 0) {
    Say "  $name FAILED; stopping. Full output is in $log"
    exit $code
  }
}

foreach ($phrase in $Phrases) {
  $root = Join-Path $data "phrases\$phrase"
  $positives = @(Get-ChildItem -Path (Join-Path $root 'positives') -Filter *.wav -File -ErrorAction SilentlyContinue).Count
  $negatives = @(Get-ChildItem -Path (Join-Path $root 'negatives') -Filter *.wav -File -ErrorAction SilentlyContinue).Count
  Say "===== ${phrase}: $positives positives, $negatives negatives ====="

  if ($positives -ge $positiveCount -and $negatives -ge $negativeCount) {
    Say "  clips complete; synthesis skipped"
  } elseif ($positives -gt 0 -or $negatives -gt 0) {
    # Nothing half-made is reused: the missing clips are the whole reason to run it again, and the
    # stage's own clear is what makes the set come out at the expected size.
    Say "  clips incomplete; synthesis re-runs from empty"
    Stage "$phrase synth" '' @('wake_dataset.py', 'synth', '--phrase', $phrase)
  } else {
    Stage "$phrase synth" '' @('wake_dataset.py', 'synth', '--phrase', $phrase)
  }

  Stage "$phrase features" (Join-Path $features "$phrase-negative.npy") @('wake_dataset.py', 'features', '--phrase', $phrase)
  Stage "$phrase train" (Join-Path $features "$phrase.onnx") @('wake_train.py', '--phrase', $phrase, '--epochs', '60')
  Stage "$phrase eval" (Join-Path $features "$phrase-eval.json") @('wake_eval.py', '--phrase', $phrase)
}

Say "all stages passed at $(Get-Date -Format o); log: $log"
