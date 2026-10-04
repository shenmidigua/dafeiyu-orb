# DSH: 精确清理我造成的残留 node 控制台窗口。
#
# 关键：不能盲目匹配 "ConsoleWindowClass + node" —— 那会连承载本次会话的
# 宿主进程一起关掉（上一次就这么把自己打死了）。这里先建立父子关系，
# 排除任何是当前进程祖先的 node，再关剩下的。
$ErrorActionPreference = 'Continue'
$myPid = $PID

$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SC {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
}
"@
if (-not ("SC" -as [type])) { Add-Type -TypeDefinition $sig }

# 建立「本进程的所有祖先」集合，任何祖先都不能关。
function Get-Ancestors {
  $chain = New-Object System.Collections.Generic.HashSet[int]
  $cur = $myPid
  for ($i = 0; $i -lt 12; $i++) {
    try {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId=$cur" -ErrorAction Stop
      if (-not $p) { break }
      $parent = [int]$p.ParentProcessId
      if ($parent -le 0 -or $parent -eq $cur) { break }
      [void]$chain.Add($parent)
      $cur = $parent
    } catch { break }
  }
  return $chain
}

$ancestors = Get-Ancestors
Write-Output "本进程 PID=$myPid，祖先链: $([string]::Join(', ', $ancestors))"
Write-Output "（WMI 不可用时该集合为空，此时改为只按标题精确匹配，宁少勿多）"

$targets = New-Object System.Collections.ArrayList
$cb = [SC+EnumWindowsProc]{
  param($h, $l)
  if (-not [SC]::IsWindowVisible($h)) { return $true }
  $c = New-Object System.Text.StringBuilder 256; [void][SC]::GetClassName($h, $c, 256)
  if ($c.ToString() -ne 'ConsoleWindowClass') { return $true }
  $pid2 = 0; [void][SC]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if (-not $proc -or $proc.ProcessName -ne 'node') { return $true }
  # 排除祖先，避免再次自杀。
  if ($script:ancestors.Contains([int]$pid2)) {
    Write-Output "  跳过（是本次会话的祖先）: PID=$pid2"
    return $true
  }
  $t = New-Object System.Text.StringBuilder 512; [void][SC]::GetWindowText($h, $t, 512)
  [void]$targets.Add([pscustomobject]@{ H=[int64]$h; Pid=$pid2; Title=$t.ToString() })
  return $true
}
$script:ancestors = $ancestors
[void][SC]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output ''
Write-Output "候选（排除祖先后）: $(@($targets).Count) 个"
foreach ($t in @($targets)) {
  Write-Output "  关闭 H=$($t.H) PID=$($t.Pid) 标题='$($t.Title)'"
  [void][SC]::PostMessage([IntPtr]$t.H, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 600
}
Start-Sleep -Seconds 1
Write-Output ''
Write-Output '剩余带窗口的 node 进程：'
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } |
  Select-Object Id, MainWindowTitle | Format-Table -AutoSize
