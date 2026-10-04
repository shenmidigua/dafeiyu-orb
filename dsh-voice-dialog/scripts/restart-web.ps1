# Replace the DSH web server that serves http://127.0.0.1:3080.
#
# Spawned detached (its own console window, hidden), so it outlives the process
# that starts it: killing the old web server also kills the agent turn that asks
# for the restart. Order matters — the port is freed FIRST, then a fresh
# `dsh web` boots on the same port — and every step appends to the log below, so
# the outcome is inspectable after the page reconnects.
#
# Usage: pwsh -NoProfile -File restart-web.ps1 [-Port 3080] [-TimeoutSeconds 180]

param(
  [int]$Port = 3080,
  [int]$TimeoutSeconds = 180
)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
$logDir = Join-Path $here 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $logDir "restart-$stamp.log"
$webOut = Join-Path $logDir "web-$stamp.log"
$webErr = Join-Path $logDir "web-$stamp.err.log"

function Write-Log([string]$line) {
  $text = "[restart] $line"
  Add-Content -Path $log -Value $text
}

function Test-PortListening([int]$p) {
  $line = & "$env:SystemRoot\System32\netstat.exe" -ano 2>$null | Select-String ":$p\s" | Select-String 'LISTENING' | Select-Object -First 1
  return ($null -ne $line)
}

Write-Log "started (port=$Port timeout=${TimeoutSeconds}s)"

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)

# 1. Free the port: stop whatever listens on it.
if (Test-PortListening $Port) {
  $match = & "$env:SystemRoot\System32\netstat.exe" -ano 2>$null | Select-String ":$Port\s" | Select-String 'LISTENING' | Select-Object -First 1
  $listenPid = [int](($match.Line -split '\s+') | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
  Write-Log "stopping pid $listenPid listening on $Port"
  Stop-Process -Id $listenPid -Force -ErrorAction SilentlyContinue
}

# 2. Wait for the socket to be released.
while ((Get-Date) -lt $deadline) {
  if (-not (Test-PortListening $Port)) { break }
  Start-Sleep -Milliseconds 500
}
if (Test-PortListening $Port) {
  Write-Log "port $Port is still listening after ${TimeoutSeconds}s - aborting without starting anything"
  exit 2
}
Write-Log "port $Port is free"

# 3. Boot a fresh server, detached, on the same port.
$node = 'D:\DeepSeekHarness\node\node.exe'
$cli = 'D:\DeepSeekHarness\npm-global\node_modules\@deepseek-ai\dsh\lib\bin.js'
$proc = Start-Process -FilePath $node -ArgumentList @($cli, 'web') -WorkingDirectory $here `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $webOut -RedirectStandardError $webErr
Write-Log "started dsh web pid $($proc.Id); stdout=$webOut stderr=$webErr"

# 4. Wait for readiness. 401 counts as ready: the webserver authenticates every
#    request and this probe has no browser cookie.
$ready = $false
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) {
    Write-Log "the new server exited early with code $($proc.ExitCode); see $webErr"
    exit 3
  }
  if (Test-PortListening $Port) { $ready = $true; break }
  Start-Sleep -Milliseconds 500
}
if (-not $ready) {
  Write-Log "the new server did not listen on $Port within ${TimeoutSeconds}s; see $webErr"
  exit 4
}

$status = 'unknown'
try {
  $status = (& "$env:SystemRoot\System32\curl.exe" -s -o NUL -w '%{http_code}' "http://127.0.0.1:$Port/")
} catch {
  $status = "probe failed: $($_.Exception.Message)"
}
Write-Log "server is listening; GET / answered $status (401 is the expected unauthenticated answer)"
Write-Log "done - refresh http://127.0.0.1:$Port/ in the browser"
exit 0
