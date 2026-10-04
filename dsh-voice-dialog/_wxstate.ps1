# DSH: 实时列出微信相关窗口（带 BOM，避免中文乱码）。
$ErrorActionPreference = 'Continue'

$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MW {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
if (-not ("MW" -as [type])) { Add-Type -TypeDefinition $sig }

$list = New-Object System.Collections.ArrayList
$cb = [MW+EnumWindowsProc]{
  param($h, $l)
  $pid2 = 0; [void][MW]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -match 'Weixin|WeChatAppEx') {
    $t = New-Object System.Text.StringBuilder 512; [void][MW]::GetWindowText($h, $t, 512)
    $r = New-Object MW+RECT; [void][MW]::GetWindowRect($h, [ref]$r)
    [void]$list.Add([pscustomobject]@{
      Handle=[int64]$h; Proc=$proc.ProcessName; Title=$t.ToString()
      Visible=[MW]::IsWindowVisible($h); Min=[MW]::IsIconic($h)
      L=$r.L; T=$r.T; W=($r.R-$r.L); H=($r.B-$r.T)
    })
  }
  return $true
}
[void][MW]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output "微信相关窗口共 $($list.Count) 个："
$list | Sort-Object Visible,W -Descending | Format-Table -AutoSize

$main = $list | Where-Object { $_.Proc -eq 'Weixin' -and $_.Title -ne '' -and $_.W -gt 300 }
Write-Output "微信主窗口: $(if($main){"$($main.L),$($main.T) $($main.W)x$($main.H) visible=$($main.Visible)"}else{'未找到'})"
$mt = $list | Where-Object { $_.Proc -eq 'WeChatAppEx' -and $_.Title -match '美团' }
Write-Output "美团小程序: $(if($mt){"$($mt.L),$($mt.T) $($mt.W)x$($mt.H) visible=$($mt.Visible)"}else{'未打开'})"
