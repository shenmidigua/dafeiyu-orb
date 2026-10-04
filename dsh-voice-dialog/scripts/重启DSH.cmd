@echo off
rem ==========================================================================
rem  DSH one-click restart -- double-click this file.
rem
rem  It hands off to restart-dsh.vbs through wscript, which then runs
rem  restart-dsh.ps1. The extra hop exists because the PowerShell script has to
rem  kill whichever process holds port 3080; if that script were still attached
rem  to a process tree that dies with the old server, it would kill itself
rem  half-way through. A wscript-launched process is not in that tree.
rem
rem  This file is deliberately ASCII-only: cmd.exe mis-decodes UTF-8 batch
rem  files, and a Chinese comment gets executed as a command and breaks the
rem  launch. All Chinese user-facing text lives in restart-dsh.ps1 instead.
rem
rem  The desktop shortcut "DSH restart" points here; either works.
rem ==========================================================================

setlocal
set "VBS=%~dp0restart-dsh.vbs"

if not exist "%VBS%" (
  echo [ERROR] missing launcher: "%VBS%"
  pause
  exit /b 1
)

start "" wscript.exe //nologo "%VBS%"
exit /b 0
