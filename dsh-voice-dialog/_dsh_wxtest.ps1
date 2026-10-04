param(
  [Parameter(Mandatory=$true)][ValidateSet('click','pasteInChat','screenClean','shot')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = '',
  [string]$Out = 'C:\Users\digua\Desktop\_dsh_test.png',
  [int]$WaitMs = 900
)

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WxT {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, [In] INPUT[] inputs, int cb);
  public const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static uint SendVk(ushort vk, bool up) {
    INPUT[] a = new INPUT[1];
    a[0].type = INPUT_KEYBOARD; a[0].ki.wVk = vk; a[0].ki.wScan = 0; a[0].ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void Chord(ushort mod, ushort key) {
    System.Threading.Thread.Sleep(80);
    SendVk(mod, false); System.Threading.Thread.Sleep(50);
    SendVk(key, false); System.Threading.Thread.Sleep(60);
    SendVk(key, true);  System.Threading.Thread.Sleep(50);
    SendVk(mod, true);
  }
  public static void PressVk(ushort key) { System.Threading.Thread.Sleep(80); SendVk(key, false); System.Threading.Thread.Sleep(60); SendVk(key, true); }
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$H = [IntPtr]198142

function Focus-Wx {
  [void][WxT]::ShowWindow($H, 9)
  $fg = [WxT]::GetForegroundWindow()
  if ($fg -ne $H) {
    $ft = [WxT]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
    $me = [WxT]::GetCurrentThreadId()
    [void][WxT]::AttachThreadInput($me, $ft, $true)
    [void][WxT]::SetForegroundWindow($H)
    [void][WxT]::AttachThreadInput($me, $ft, $false)
  }
  Start-Sleep -Milliseconds 300
  return ([WxT]::GetForegroundWindow() -eq $H)
}

function Save-Shot([string]$p) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($p, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

function Click([int]$x, [int]$y) {
  [void][WxT]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 150
  [WxT]::mouse_event([WxT]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 70
  [WxT]::mouse_event([WxT]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 400
}

function Set-Clip([string]$t) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\clip.exe"
  $psi.RedirectStandardInput = $true
  $psi.UseShellExecute = $false
  $p = [System.Diagnostics.Process]::Start($psi)
  $enc = [System.Text.Encoding]::GetEncoding(936)
  $bytes = $enc.GetBytes($t)
  $p.StandardInput.BaseStream.Write($bytes, 0, $bytes.Length)
  $p.StandardInput.Close()
  $p.WaitForExit()
}

function Ptr([int]$x, [int]$y) {
  $p = New-Object WxT+POINT; $p.X = $x; $p.Y = $y
  $h = [WxT]::WindowFromPoint($p); $pid2 = 0; [void][WxT]::GetWindowThreadProcessId($h, [ref]$pid2)
  return "$h(pid=$pid2)"
}

$focused = Focus-Wx
Write-Output "focus=$focused"

switch ($Action) {
  'click' {
    Click $X $Y
    Save-Shot $Out
    Write-Output "clicked($X,$Y) windowAtPoint=$(Ptr $X $Y) fg=$([WxT]::GetForegroundWindow()) shot=$Out"
  }
  'pasteInChat' {
    Set-Clip $Text
    Write-Output "clipboard set to: '$Text'"
    [void](Focus-Wx)
    [WxT]::Chord(0x11, 0x56)   # Ctrl+V
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "ctrl+v sent, shot=$Out"
  }
  'screenClean' {
    [void](Focus-Wx)
    [WxT]::Chord(0x11, 0x41)   # Ctrl+A
    Start-Sleep -Milliseconds 250
    [WxT]::PressVk(0x2E)       # Delete
    Start-Sleep -Milliseconds 250
    Save-Shot $Out
    Write-Output "cleared input area, shot=$Out"
  }
  'shot' { Save-Shot $Out; Write-Output "shot=$Out" }
}
