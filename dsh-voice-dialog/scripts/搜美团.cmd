@echo off
rem ==========================================================================
rem  Search the Meituan mini-program -- double-click the "Meituan search"
rem  shortcut, or this file directly.
rem
rem  It prompts for a keyword, then drives WeChat and the mini-program to run
rem  the search locally. That skips the round trip through the AI, which had to
rem  click a dozen times per search.
rem
rem  ASCII only: cmd.exe executes mis-decoded UTF-8 comments as commands.
rem  The visible PowerShell window is intentional -- it prompts for the keyword.
rem ==========================================================================

setlocal
set "VBS=%~dp0run-search.vbs"

if not exist "%VBS%" (
  echo [ERROR] missing launcher: "%VBS%"
  pause
  exit /b 1
)

start "" wscript.exe //nologo "%VBS%"
exit /b 0
