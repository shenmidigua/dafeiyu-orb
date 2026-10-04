# DSH：在美团外卖小程序里搜索一个关键词。
#
# 为什么需要它：语音唤醒只能把话变成发给 AI 的文字，AI 再手动点十几下才能在小程序里
# 搜出一个词。这个脚本跳过那一圈，直接在本机把搜索结果摆到屏幕上。
#
# 用法（由 搜美团.cmd 调用，也可手动跑）：
#   powershell -File search-meituan.ps1 "咖啡"
#
# 坐标全部由窗口句柄 + 窗口矩形实时算出，不写死屏幕坐标。之前写死坐标时，微信左侧栏
# 一展开就会点到「小程序」按钮而不是搜索框。

param(
  [Parameter(Position = 0)][string]$Keyword = ''
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

# ── Win32 ────────────────────────────────────────────────────────────────────
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MT {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
}
"@
if (-not ("MT" -as [type])) { Add-Type -TypeDefinition $sig }

function Get-Windows {
  $list = New-Object System.Collections.ArrayList
  $cb = [MT+EnumWindowsProc]{
    param($h, $l)
    $pid2 = 0; [void][MT]::GetWindowThreadProcessId($h, [ref]$pid2)
    $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -match 'Weixin|WeChatAppEx') {
      $t = New-Object System.Text.StringBuilder 512; [void][MT]::GetWindowText($h, $t, 512)
      $r = New-Object MT+RECT; [void][MT]::GetWindowRect($h, [ref]$r)
      [void]$list.Add([pscustomobject]@{
        Handle = [int64]$h
        Proc   = $proc.ProcessName
        Title  = $t.ToString()
        Visible = [MT]::IsWindowVisible($h)
        Min    = [MT]::IsIconic($h)
        L = $r.L; T = $r.T; W = ($r.R - $r.L); H = ($r.B - $r.T)
      })
    }
    return $true
  }
  [void][MT]::EnumWindows($cb, [IntPtr]::Zero)
  return $list
}

function Focus-Window([int64]$handle) {
  $h = [IntPtr][int64]$handle
  # Unlock the foreground lock with a synthetic ALT tap, then raise the window.
  [MT]::keybd_event(0x12, 0, 0, [IntPtr]::Zero)
  [MT]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  [void][MT]::ShowWindow($h, 9)
  [void][MT]::BringWindowToTop($h)
  [void][MT]::SetForegroundWindow($h)
  Start-Sleep -Milliseconds 600
  return ([MT]::GetForegroundWindow() -eq $h)
}

function Click-At([int]$x, [int]$y) {
  [void][MT]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 120
  [MT]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [MT]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}

function Send-Keys([string]$keys) {
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Milliseconds 300
}

function Paste-Text([string]$text) {
  # Clipboard, never SendKeys: Chinese characters do not survive being sent as
  # keystrokes, and this script takes arbitrary user input.
  try { Set-Clipboard -Value $text } catch {
    Write-Host "  [!] 无法写入剪贴板" -ForegroundColor Yellow
    return $false
  }
  Start-Sleep -Milliseconds 200
  Send-Keys '^v'
  Start-Sleep -Milliseconds 700
  return $true
}

# ── 1. 关键词 ────────────────────────────────────────────────────────────────
if ([string]::IsNullOrWhiteSpace($Keyword)) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $Keyword = [Microsoft.VisualBasic.Interaction]::InputBox(
    '要搜索什么？例如：咖啡、沙县小吃、奶茶', '美团外卖搜索', '')
}
if ([string]::IsNullOrWhiteSpace($Keyword)) {
  Write-Host '未输入关键词，已取消。'
  Start-Sleep -Seconds 2
  exit 0
}
$Keyword = $Keyword.Trim()
Write-Host "关键词：$Keyword"
Write-Host ''

# ── 2. 找到（或打开）美团小程序 ───────────────────────────────────────────────
# 选择规则必须排掉两种干扰窗口：托盘辅助窗口（1920x759 的
# `WxTrayIconMessageWindow`）和最小化时落在 (-32000,-32000) 的窗口。
# 只按标题匹配会选中托盘窗口，算出的坐标自然点在别处。
function Get-MainWeixin {
  $cands = @((Get-Windows) | Where-Object {
    $_.Proc -eq 'Weixin' -and $_.Title -eq '微信' -and $_.L -gt -10000 -and $_.W -gt 300
  })
  if ($cands.Count -eq 0) { return $null }
  $ready = $cands | Where-Object { $_.Visible -and -not $_.Min } | Select-Object -First 1
  if ($ready) { return $ready }
  return $cands[0]
}

function Get-MeituanAppex {
  return (Get-Windows) | Where-Object {
    $_.Proc -eq 'WeChatAppEx' -and $_.Title -match '美团' -and $_.W -gt 300
  } | Select-Object -First 1
}

$appex = Get-MeituanAppex

if (-not $appex) {
  Write-Host '[1/3] 美团小程序未打开，先从微信进去…'
  $wx = Get-MainWeixin
  if (-not $wx) {
    Write-Host '  [!] 找不到微信主窗口，请先启动并登录微信。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
  }
  [void](Focus-Window $wx.Handle)

  # 重新读一次矩形：刚恢复的窗口，之前枚举到的是 (-32000,-32000)。
  Start-Sleep -Milliseconds 400
  $wx = Get-MainWeixin
  Write-Host "  微信窗口：$($wx.W) x $($wx.H) @ ($($wx.L),$($wx.T))"

  # 点搜索框：位置按窗口矩形算 —— 左侧栏宽度固定，搜索框在其右侧。
  $searchX = $wx.L + 190
  $searchY = $wx.T + 55
  Click-At $searchX $searchY
  [void](Paste-Text '美团外卖')
  Start-Sleep -Milliseconds 1200

  # 第一条“最近使用过的小程序”就在搜索面板顶部。
  Click-At ($wx.L + 250) ($wx.T + 215)
  Write-Host '  已点击搜索结果，等待小程序加载…'
  Start-Sleep -Seconds 9

  $appex = Get-MeituanAppex
  if (-not $appex) {
    Write-Host '  [!] 小程序没打开。可能微信布局与预期不同，请手动点开一次再重试。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 2
  }
} else {
  Write-Host '[1/3] 美团小程序已在运行'
}

Write-Host "  小程序窗口：$($appex.W) x $($appex.H) @ ($($appex.L),$($appex.T))"
[void](Focus-Window $appex.Handle)

# ── 3. 搜索 ──────────────────────────────────────────────────────────────────
# 小程序顶部的搜索框：距窗口顶部约 100px，横向偏左约 200px 处。
# 坐标全部相对当前窗口矩形，所以窗口移动或换尺寸都不受影响。
$boxX = $appex.L + [int]($appex.W * 0.39)
$boxY = $appex.T + 113

Write-Host '[2/3] 填入关键词…'
Click-At $boxX $boxY
Send-Keys '^a'          # 清掉上次留下的词
if (-not (Paste-Text $Keyword)) { Read-Host '按回车退出'; exit 3 }
Start-Sleep -Milliseconds 800

# 提交：搜索框右侧的「搜索」按钮。
$btnX = $appex.L + [int]($appex.W * 0.887)
$btnY = $appex.T + 113
Click-At $btnX $btnY

Write-Host '[3/3] 已提交，等待结果…'
Start-Sleep -Seconds 5
Write-Host ''
Write-Host '完成。结果应该已经显示在小程序里了。' -ForegroundColor Green
Write-Host '提示：如果搜到的不是你要的，改用更具体的关键词（如“瑞幸”而不是“咖啡”）。'
Start-Sleep -Seconds 6
