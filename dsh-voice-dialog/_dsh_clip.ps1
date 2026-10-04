# Restore clipboard to exact Chinese text and verify by code points (avoids PS5.1 console/encoding pitfalls)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$target = [char]0x6C99 + [char]0x53BF + [char]0x5C0F + [char]0x5403   # 沙县小吃
$expected = ($target.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' '

# retry a few times: the clipboard can be briefly locked by other processes
$set = $false
for ($i = 0; $i -lt 5; $i++) {
  try {
    [System.Windows.Forms.Clipboard]::SetDataObject($target, $true)
    $set = $true
    break
  } catch {
    Start-Sleep -Milliseconds 300
  }
}

Start-Sleep -Milliseconds 400
$back = $null
for ($i = 0; $i -lt 5; $i++) {
  try { $back = [System.Windows.Forms.Clipboard]::GetText(); break } catch { Start-Sleep -Milliseconds 300 }
}

$got = if ($null -eq $back) { '<null>' } else { ($back.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ' }

$lines = @(
  "set_ok=$set",
  "expected_codepoints=$expected",
  "actual_length=$($back.Length)",
  "actual_codepoints=$got",
  "exact_match=$($back -ceq $target)"
)
$lines | Set-Content -Path 'C:\Users\digua\Desktop\_dsh_clip.txt' -Encoding UTF8
$lines
