# DSH: 列出所有可见窗口，定位拦截焦点的对话框。
$ErrorActionPreference = 'Continue'

$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AV {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
if (-not ("AV" -as [type])) { Add-Type -TypeDefinition $sig }

$list = New-Object System.Collections.ArrayList
$cb = [AV+EnumWindowsProc]{
  param($h, $l)
  if (-not [AV]::IsWindowVisible($h)) { return $true }
  if ([AV]::IsIconic($h)) { return $true }
  $pid2 = 0; [void][AV]::GetWindowThreadProcessId($h, [ref]$pid2)
  $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
  $t = New-Object System.Text.StringBuilder 512; [void][AV]::GetWindowText($h, $t, 512)
  $c = New-Object System.Text.StringBuilder 256; [void][AV]::GetClassName($h, $c, 256)
  $r = New-Object AV+RECT; [void][AV]::GetWindowRect($h, [ref]$r)
  [void]$list.Add([pscustomobject]@{
    Handle=[int64]$h
    Proc=$(if($proc){$proc.ProcessName}else{'?'})
    Pid=$pid2
    Class=$c.ToString()
    Title=$t.ToString()
    Rect="$($r.L),$($r.T) $($r.R-$r.L)x$($r.B-$r.T)"
  })
  return $true
}
[void][AV]::EnumWindows($cb, [IntPtr]::Zero)

Write-Output "=== 当前可见且未最小化的窗口 ==="
$list | Format-Table -AutoSize

Write-Output "=== 疑似文件对话框 ==="
$dlg = $list | Where-Object { $_.Class -match '#32770' -or $_.Title -match '选择|打开|Select|Open' }
if ($dlg) { $dlg | Format-Table -AutoSize } else { Write-Output "  未发现（可能已关闭）" }
