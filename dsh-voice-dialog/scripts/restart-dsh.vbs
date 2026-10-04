' DSH one-click restart -- windowless launcher.
'
' Why this layer exists: restart-dsh.ps1 has to kill whichever process holds
' port 3080. If that script were still attached to a process tree that dies with
' the old server, it would kill itself half-way through. A wscript-launched
' process is not in that tree, so it can finish the job.
'
' Two encoding rules this file must keep:
'   1. NO UTF-8 BOM. Windows Script Host treats the BOM bytes as script text
'      and fails with "invalid character" at line 1, character 1.
'   2. ASCII only. WSH reads .vbs as ANSI, so UTF-8 bytes would be mojibake.
' All Chinese user-facing text lives in restart-dsh.ps1, which is UTF-8 *with*
' a BOM because PowerShell 5.1 would otherwise decode it as ANSI.
'
' Invoked by the restart .cmd; the user does not run this file directly.

Option Explicit

Dim shell, fso, here, ps1, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' Resolve this script's own folder, then the PowerShell script beside it.
here = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = fso.BuildPath(here, "restart-dsh.ps1")

If Not fso.FileExists(ps1) Then
  MsgBox "Launcher not found:" & vbCrLf & ps1, 16, "DSH restart"
  WScript.Quit 1
End If

' -ExecutionPolicy Bypass applies to this one process only; the system policy
' is untouched. The window stays visible (1) because the PowerShell script
' prints progress and, on failure, the log path the user needs.
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"

On Error Resume Next
shell.Run cmd, 1, False
If Err.Number <> 0 Then
  MsgBox "Could not start PowerShell: " & Err.Description, 16, "DSH restart"
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit 0
