# DSH: 验证 search-meituan.ps1 的窗口探测与坐标计算（不点击任何东西）。
$ErrorActionPreference = 'Continue'

$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MV {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
if (-not ("MV" -as [type])) { Add-Type -TypeDefinition $sig }

$list = New-Object System.Collections.ArrayList
$cb = [MV+EnumWindowsProc]{
  param($h, $l)
  $pid2 = 0; [void][MV]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'Weixin|WeChatAppEx') {
    $t = New-Object System.Text.StringBuilder 512; [void][MV]::GetWindowText($h, $t, 512)
    $r = New-Object MV+RECT; [void][MV]::GetWindowRect($h, [ref]$r)
    [void]$list.Add([pscustomobject]@{
      Handle=[int64]$h; Proc=$proc.ProcessName; Title=$t.ToString()
      Visible=[MV]::IsWindowVisible($h)
      L=$r.L; T=$r.T; W=($r.R-$r.L); H=($r.B-$r.T)
    })
  }
  return $true
}
[void][MV]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output '=== 探测到的微信相关窗口 ==='
$list | Where-Object { $_.W -gt 200 -and $_.H -gt 200 } | Format-Table -AutoSize

$appex = $list | Where-Object { $_.Proc -eq 'WeChatAppEx' -and $_.Title -match '美团' } | Select-Object -First 1
if ($appex) {
  Write-Output "=== 美团小程序窗口 ==="
  Write-Output "  矩形: L=$($appex.L) T=$($appex.T) W=$($appex.W) H=$($appex.H)"
  $boxX = $appex.L + [int]($appex.W * 0.39)
  $boxY = $appex.T + 113
  $btnX = $appex.L + [int]($appex.W * 0.887)
  $btnY = $appex.T + 113
  Write-Output "  脚本算出的搜索框位置: ($boxX, $boxY)   相对窗口: ($($boxX-$appex.L), $($boxY-$appex.T))"
  Write-Output "  脚本算出的搜索按钮位置: ($btnX, $btnY)   相对窗口: ($($btnX-$appex.L), $($btnY-$appex.T))"
  Write-Output ''
  Write-Output '  参照：实测截图里搜索框约在窗口内 (85,113)，搜索按钮约在 (474,110)'
  Write-Output "  搜索框误差: x=$([Math]::Abs($boxX-$appex.L-85)) y=$([Math]::Abs($boxY-$appex.T-113))"
  Write-Output "  按钮误差  : x=$([Math]::Abs($btnX-$appex.L-474)) y=$([Math]::Abs($btnY-$appex.T-110))"
} else {
  Write-Output '美团小程序窗口未打开（脚本会走「先打开小程序」分支）'
}
