' Launch the Meituan mini-program search.
'
' Invoked by the .cmd. The wscript hop keeps this off the caller's process
' tree, so closing the launcher cannot interrupt the UI automation half-way.
'
' Encoding rules: NO UTF-8 BOM (Windows Script Host parses the BOM bytes as
' script text and fails at line 1), and ASCII only (WSH reads .vbs as ANSI).
' All Chinese text lives in search-meituan.ps1, which is UTF-8 with a BOM.

Option Explicit

Dim shell, fso, here, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "search-meituan.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "Script not found:" & vbCrLf & ps1, 16, "Meituan search"
  WScript.Quit 1
End If

' Visible window: the script prints progress and prompts for the keyword.
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"

On Error Resume Next
shell.Run cmd, 1, False
If Err.Number <> 0 Then
  MsgBox "Could not start PowerShell: " & Err.Description, 16, "Meituan search"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit 0
