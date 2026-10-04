# DSH 一键重启 —— 桌面快捷方式的目标。
#
# 为什么不直接双击 restart-web.mjs：那个脚本只会「等端口释放」，不会主动结束旧服务。
# 而这个脚本先找到占用 3080 的进程并结束它，再交给 restart-web.mjs 拉起新服务，
# 最后把带 token 的登录地址复制到剪贴板（token 每次启动都变，找不到就打不开界面）。
#
# 由 重启DSH.cmd 通过 wscript.exe 启动，所以不会有黑窗口残留。

$ErrorActionPreference = 'Continue'

$root    = Split-Path -Parent $PSScriptRoot      # dsh-voice-dialog
$scriptDir = Join-Path $root 'scripts'
$node    = 'D:\DeepSeekHarness\node\node.exe'
$restart = Join-Path $scriptDir 'restart-web.mjs'
$logDir  = Join-Path $scriptDir 'logs'

# 固定值，不走参数：中文字符串经命令行传参会损坏，端口号也会被一并弄坏。
$port = 3080
$url  = "http://127.0.0.1:$port/"

# 干跑开关：只验证探测逻辑，不结束任何进程。用于在动真格之前确认整条启动链完好。
$dryRun = $env:DSH_RESTART_DRY -eq '1'

function Write-Line([string]$text) {
  Write-Host $text
}

Write-Line '========================================'
Write-Line '  DSH 一键重启'
Write-Line '========================================'
Write-Line ''

# ── 1. 结束当前占用端口的服务 ────────────────────────────────────────────────
$netstat = Join-Path $env:SystemRoot 'System32\netstat.exe'
$listening = & $netstat -ano 2>$null | Select-String ":$port\s" | Select-String 'LISTENING' | Select-Object -First 1

if ($listening) {
  $ownerPid = [int](($listening.Line -split '\s+') | Where-Object { $_ -match '^\d+$' } | Select-Object -Last 1)
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  if ($proc) {
    if ($dryRun) {
      Write-Line "[1/3] 干跑：将结束 PID $ownerPid ($($proc.ProcessName))，实际未执行"
      Write-Line ''
      Write-Line '干跑结束。这条链（快捷方式 -> cmd -> wscript/vbs -> powershell -> 端口探测）已确认可用。'
      Write-Line '去掉 DSH_RESTART_DRY=1 即为真实重启。'
      Start-Sleep -Seconds 6
      exit 0
    }
    Write-Line "[1/3] 结束旧服务 (PID $ownerPid, $($proc.ProcessName))..."
    Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
    # 等端口真正释放，否则新服务会绑定失败
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 400
      $still = & $netstat -ano 2>$null | Select-String ":$port\s" | Select-String 'LISTENING' | Select-Object -First 1
      if (-not $still) { break }
    }
    if ($still) { Write-Line '      警告：端口仍被占用，新服务可能启动失败' }
    else { Write-Line '      端口已释放' }
  } else {
    Write-Line "[1/3] 端口被 PID $ownerPid 占用，但该进程已不存在"
  }
} else {
  Write-Line '[1/3] 没有正在运行的服务，直接启动'
}

# ── 2. 拉起新服务 ────────────────────────────────────────────────────────────
if (-not (Test-Path $node))   { Write-Line "找不到 node: $node"; Read-Host '按回车退出'; exit 1 }
if (-not (Test-Path $restart)) { Write-Line "找不到重启脚本: $restart"; Read-Host '按回车退出'; exit 1 }

Write-Line ''
Write-Line '[2/3] 启动新服务（首次加载约 10-20 秒）...'
& $node $restart --port $port --timeout-ms 300000
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Line ''
  Write-Line "启动失败（退出码 $code）。请把下面目录里最新的 .err.log 发给 AI："
  Write-Line "  $logDir"
  Read-Host '按回车退出'
  exit $code
}

# ── 3. 把登录地址给用户 ──────────────────────────────────────────────────────
Write-Line ''
Write-Line '[3/3] 服务已就绪'

$latest = Get-ChildItem $logDir -Filter 'web-*.log' -ErrorAction SilentlyContinue |
  Where-Object { $_.Length -gt 0 } | Sort-Object LastWriteTime -Descending | Select-Object -First 1

$loginUrl = $null
if ($latest) {
  $match = Select-String -Path $latest.FullName -Pattern 'https?://\S*\?token=\S+' -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($match) { $loginUrl = $match.Matches[0].Value }
}

if ($loginUrl) {
  # 剪贴板是给「浏览器没自动打开」兜底的：token 每次都变，手输基本不可能。
  try {
    Set-Clipboard -Value $loginUrl
    Write-Line '      登录地址已复制到剪贴板'
  } catch {
    Write-Line '      （复制剪贴板失败，用下面的地址）'
  }
  Write-Line ''
  Write-Line '  浏览器应该已经自动打开。若没有，粘贴这个地址：'
  Write-Line "  $loginUrl"
} else {
  Write-Line '      没读到带 token 的地址，请到 logs 目录看最新的 web-*.log'
}

Write-Line ''
Write-Line '完成。本窗口 10 秒后自动关闭。'
Start-Sleep -Seconds 10
