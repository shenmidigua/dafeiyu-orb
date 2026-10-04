param(
  [Parameter(Mandatory=$true)][ValidateSet('click','type','typeu','paste','ctrlA','probe','key','shot','focus','info','topmost','untopmost')][string]$Action,
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Text = '',
  [string]$Out = 'C:\Users\digua\Desktop\_dsh_screen.png',
  [int]$WaitMs = 600
)

$sig = @'
using System;
using System.Runtime.InteropServices;
public class DshUi {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  public const uint SWP_NOMOVE = 0x0002, SWP_NOSIZE = 0x0001, SWP_NOACTIVATE = 0x0010;
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit, Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public KEYBDINPUT ki; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, [In] INPUT[] inputs, int cb);
  public const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_UNICODE = 0x0004;
  public static uint TypeUnicodeChar(char c) {
    INPUT[] arr = new INPUT[2];
    arr[0].type = INPUT_KEYBOARD; arr[0].ki.wVk = 0; arr[0].ki.wScan = c; arr[0].ki.dwFlags = KEYEVENTF_UNICODE; arr[0].ki.time = 0; arr[0].ki.dwExtraInfo = IntPtr.Zero;
    arr[1].type = INPUT_KEYBOARD; arr[1].ki.wVk = 0; arr[1].ki.wScan = c; arr[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP; arr[1].ki.time = 0; arr[1].ki.dwExtraInfo = IntPtr.Zero;
    return SendInput(2, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint SendVk(ushort vk, bool up) {
    INPUT[] arr = new INPUT[1];
    arr[0].type = INPUT_KEYBOARD; arr[0].ki.wVk = vk; arr[0].ki.wScan = 0;
    arr[0].ki.dwFlags = up ? KEYEVENTF_KEYUP : 0; arr[0].ki.time = 0; arr[0].ki.dwExtraInfo = IntPtr.Zero;
    return SendInput(1, arr, Marshal.SizeOf(typeof(INPUT)));
  }
  public static void CtrlV() { System.Threading.Thread.Sleep(60); SendVk(0x11, false); System.Threading.Thread.Sleep(40); SendVk(0x56, false); System.Threading.Thread.Sleep(50); SendVk(0x56, true); System.Threading.Thread.Sleep(40); SendVk(0x11, true); }
  public static void CtrlA() { System.Threading.Thread.Sleep(60); SendVk(0x11, false); System.Threading.Thread.Sleep(40); SendVk(0x41, false); System.Threading.Thread.Sleep(50); SendVk(0x41, true); System.Threading.Thread.Sleep(40); SendVk(0x11, true); }
  public static void PressVk(ushort vk) { System.Threading.Thread.Sleep(60); SendVk(vk, false); System.Threading.Thread.Sleep(50); SendVk(vk, true); }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004, RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
}
'@
Add-Type -TypeDefinition $sig -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$WECHAT_HWND = [IntPtr]198142

function Focus-WeChat {
  [void][DshUi]::ShowWindow($WECHAT_HWND, 9)
  $fg = [DshUi]::GetForegroundWindow()
  if ($fg -ne $WECHAT_HWND) {
    $fgT = [DshUi]::GetWindowThreadProcessId($fg, [ref]([uint32]0))
    $me = [DshUi]::GetCurrentThreadId()
    [void][DshUi]::AttachThreadInput($me, $fgT, $true)
    [void][DshUi]::SetForegroundWindow($WECHAT_HWND)
    [void][DshUi]::AttachThreadInput($me, $fgT, $false)
  }
  Start-Sleep -Milliseconds 250
  return ([DshUi]::GetForegroundWindow() -eq $WECHAT_HWND)
}

function Save-Shot([string]$path) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}

$focused = Focus-WeChat
if (-not $focused) { Write-Output "WARN: could not focus WeChat; foreground is not hwnd $WECHAT_HWND" }

switch ($Action) {
  'focus' { Write-Output "focus=$focused" }
  'topmost' {
    [void][DshUi]::SetWindowPos($WECHAT_HWND, [DshUi]::HWND_TOPMOST, 0, 0, 0, 0, [DshUi]::SWP_NOMOVE -bor [DshUi]::SWP_NOSIZE)
    [void](Focus-WeChat)
    Start-Sleep -Milliseconds 300
    Save-Shot $Out
    Write-Output "topmost set; focus=$([DshUi]::GetForegroundWindow() -eq $WECHAT_HWND) shot=$Out"
  }
  'untopmost' {
    [void][DshUi]::SetWindowPos($WECHAT_HWND, [DshUi]::HWND_NOTOPMOST, 0, 0, 0, 0, [DshUi]::SWP_NOMOVE -bor [DshUi]::SWP_NOSIZE)
    Write-Output "topmost removed"
  }
  'info' {
    $p = New-Object DshUi+POINT; $p.X = $X; $p.Y = $Y
    $h = [DshUi]::WindowFromPoint($p)
    $sb = New-Object System.Text.StringBuilder 512; [void][DshUi]::GetWindowTextW($h, $sb, 512)
    $cn = New-Object System.Text.StringBuilder 256; [void][DshUi]::GetClassNameW($h, $cn, 256)
    $pp = 0; [void][DshUi]::GetWindowThreadProcessId($h, [ref]$pp)
    Write-Output "at($X,$Y) hwnd=$h pid=$pp class=$($cn.ToString()) title='$($sb.ToString())'"
  }
  'click' {
    [void][DshUi]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    $fg1 = [DshUi]::GetForegroundWindow()
    [DshUi]::mouse_event([DshUi]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [DshUi]::mouse_event([DshUi]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds $WaitMs
    $fg2 = [DshUi]::GetForegroundWindow()
    $p = New-Object DshUi+POINT; $p.X = $X; $p.Y = $Y
    $hw = [DshUi]::WindowFromPoint($p); $pw = 0; [void][DshUi]::GetWindowThreadProcessId($hw, [ref]$pw)
    Save-Shot $Out
    Write-Output "clicked ($X,$Y) fgBefore=$fg1 fgAfter=$fg2 changed=$($fg1 -ne $fg2) windowAtPoint=$hw(pid=$pw) shot=$Out"
  }
  'type' {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "typed '$Text' shot=$Out"
  }
  'typeu' {
    $sent = 0
    foreach ($ch in $Text.ToCharArray()) {
      $n = [DshUi]::TypeUnicodeChar($ch)
      if ($n -ne 2) { Write-Output "SendInput failed for '$ch' (returned $n, err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
      $sent++
      Start-Sleep -Milliseconds 45
    }
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "typeu sent $sent chars '$Text' shot=$Out"
  }
  'paste' {
    Set-Clipboard -Value $Text
    Start-Sleep -Milliseconds 150
    [void](Focus-WeChat)
    [DshUi]::CtrlV()
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "pasted '$Text' shot=$Out"
  }
  'ctrlA' {
    [void](Focus-WeChat)
    [DshUi]::CtrlA()
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "ctrlA sent shot=$Out"
  }
  'probe' {
    [void](Focus-WeChat)
    $fg = [DshUi]::GetForegroundWindow()
    $r = New-Object DshUi+RECT; [void][DshUi]::GetWindowRect($WECHAT_HWND, [ref]$r)
    Write-Output "foreground=$fg wechat=$WECHAT_HWND match=$($fg -eq $WECHAT_HWND) rect=$($r.L),$($r.T),$($r.R),$($r.B)"
    Set-Clipboard -Value 'zz'
    [DshUi]::TypeUnicodeChar('z'); Start-Sleep -Milliseconds 80; [DshUi]::TypeUnicodeChar('z')
    Start-Sleep -Milliseconds 500
    Save-Shot $Out
    Write-Output "probe typed 'zz' shot=$Out"
  }
  'key' {
    [System.Windows.Forms.SendKeys]::SendWait($Text)
    Start-Sleep -Milliseconds $WaitMs
    Save-Shot $Out
    Write-Output "key '$Text' shot=$Out"
  }
  'shot' { Save-Shot $Out; Write-Output "shot=$Out" }
}
