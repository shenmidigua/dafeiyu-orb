param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$Text = "",
  [string]$Path = "",
  [int]$X = -1,
  [int]$Y = -1,
  [string]$Match = "Weixin"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Nat {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
}
"@
if (-not ("Nat" -as [type])) { Add-Type -TypeDefinition $sig }

function Get-Wins {
  $res = New-Object System.Collections.ArrayList
  $cb = [Nat+EnumWindowsProc]{
    param($h,$l)
    $t = New-Object System.Text.StringBuilder 512; [void][Nat]::GetWindowText($h,$t,512)
    $c = New-Object System.Text.StringBuilder 256; [void][Nat]::GetClassName($h,$c,256)
    $pid2 = 0; [void][Nat]::GetWindowThreadProcessId($h,[ref]$pid2)
    if ([Nat]::IsWindowVisible($h)) {
      $r = New-Object Nat+RECT; [void][Nat]::GetWindowRect($h,[ref]$r)
      $pn = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName
      [void]$res.Add([pscustomobject]@{
        Handle=$h; Proc=$pn; PID=$pid2; Class=$c.ToString(); Title=$t.ToString()
        X=$r.L; Y=$r.T; W=($r.R-$r.L); H=($r.B-$r.T); Min=[Nat]::IsIconic($h)
      })
    }
    return $true
  }
  [void][Nat]::EnumWindows($cb,[IntPtr]::Zero)
  return $res
}

function Focus-Win([IntPtr]$h) {
  if ([Nat]::IsIconic($h)) { [void][Nat]::ShowWindow($h, 9) }   # SW_RESTORE
  [void][Nat]::ShowWindow($h, 5)                                 # SW_SHOW
  # ALT 轻敲解除前台锁定
  [Nat]::keybd_event(0x12,0,0,[IntPtr]::Zero)
  [Nat]::keybd_event(0x12,0,2,[IntPtr]::Zero)
  [void][Nat]::BringWindowToTop($h)
  [void][Nat]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 450
  return ([Nat]::GetForegroundWindow() -eq $h)
}

function Send-Click([int]$x,[int]$y) {
  [void][Nat]::SetCursorPos($x,$y); Start-Sleep -Milliseconds 150
  [Nat]::mouse_event(0x0002,0,0,0,[IntPtr]::Zero)   # LEFTDOWN
  Start-Sleep -Milliseconds 60
  [Nat]::mouse_event(0x0004,0,0,0,[IntPtr]::Zero)   # LEFTUP
  Start-Sleep -Milliseconds 250
}

function Send-Paste([string]$s) {
  [System.Windows.Forms.Clipboard]::SetText($s)
  Start-Sleep -Milliseconds 200
  [System.Windows.Forms.SendKeys]::SendWait("^v")
  Start-Sleep -Milliseconds 600
}

switch ($Action) {

  "list" {
    Get-Wins | Where-Object { $_.Proc -match $Match } |
      Select-Object Handle,Proc,PID,Class,Title,X,Y,W,H,Min | Format-Table -AutoSize
  }

  "listall" {
    Get-Wins | Select-Object Handle,Proc,PID,Class,Title,X,Y,W,H |
      Format-Table -AutoSize -Wrap
  }

  "shot" {
    $out = if ($Path) { $Path } else { Join-Path $env:TEMP "shot_$(Get-Date -f 'HHmmss').png" }
    if ($X -ge 0 -and $Y -ge 0) {
      # 指定窗口 handle 截图
      $r = New-Object Nat+RECT; [void][Nat]::GetWindowRect([IntPtr]$X,[ref]$r)
      $w = $r.R - $r.L; $hh = $r.B - $r.T
      $b = New-Object System.Drawing.Bitmap($w,$hh)
      $g = [System.Drawing.Graphics]::FromImage($b)
      $g.CopyFromScreen($r.L,$r.T,0,0,(New-Object System.Drawing.Size($w,$hh)))
    } else {
      $b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width,[System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)
      $g = [System.Drawing.Graphics]::FromImage($b)
      $g.CopyFromScreen(0,0,0,0,$b.Size)
    }
    $g.Dispose(); $b.Save($out,[System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
    Write-Output $out
  }

  "shotrect" {
    $out = if ($Path) { $Path } else { Join-Path $env:TEMP "rect_$(Get-Date -f 'HHmmss').png" }
    $w = $X; $hh = $Y
    $px = [int]$Text.Split(',')[0]; $py = [int]$Text.Split(',')[1]
    $b = New-Object System.Drawing.Bitmap($w,$hh)
    $g = [System.Drawing.Graphics]::FromImage($b)
    $g.CopyFromScreen($px,$py,0,0,(New-Object System.Drawing.Size($w,$hh)))
    $g.Dispose(); $b.Save($out,[System.Drawing.Imaging.ImageFormat]::Png); $b.Dispose()
    Write-Output $out
  }

  "focushwnd" {
    $ok = Focus-Win ([IntPtr][int]$X)
    $tt = New-Object System.Text.StringBuilder 512; [void][Nat]::GetWindowText([IntPtr][int]$X,$tt,512)
    Write-Output "hwnd=$X focused=$ok title=$($tt.ToString())"
  }

  "focus" {
    # Text 支持用逗号分隔多个关键词，全部命中才算匹配（避免中文字符串在传参中被破坏）
    $keys = $Text.Split(',') | Where-Object { $_ -ne "" }
    $t = Get-Wins | Where-Object {
      if ($_.Proc -notmatch $Match) { return $false }
      foreach ($k in $keys) { if ($_.Title -notlike "*$k*") { return $false } }
      return $true
    } | Select-Object -First 1
    if (-not $t) { Write-Output "NOTFOUND"; exit 1 }
    $ok = Focus-Win $t.Handle
    Write-Output "handle=$($t.Handle) focused=$ok title=$($t.Title) rect=$($t.X),$($t.Y),$($t.W),$($t.H)"
  }

  "click" {
    Send-Click $X $Y
    $p = $X, $Y
    $wp = New-Object Nat+POINT; $wp.X = $X; $wp.Y = $Y
    $h = [Nat]::WindowFromPoint($wp)
    $tt = New-Object System.Text.StringBuilder 512; [void][Nat]::GetWindowText($h,$tt,512)
    $pid3 = 0; [void][Nat]::GetWindowThreadProcessId($h,[ref]$pid3)
    Write-Output "clicked $X,$Y -> hwnd=$h proc=$((Get-Process -Id $pid3 -ErrorAction SilentlyContinue).ProcessName) title=$($tt.ToString())"
  }

  "paste" {
    Send-Paste $Text
    Write-Output "pasted: $Text"
  }

  "key" {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Start-Sleep -Milliseconds 400
    Write-Output "key: $Text"
  }
}
