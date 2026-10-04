// DSH: 写「搜美团」启动器并修正编码。
//  - search-meituan.ps1  需要 UTF-8 BOM（PS 5.1 否则按 GBK 解码中文）
//  - 搜美团.cmd          必须纯 ASCII（cmd.exe 会执行乱码注释）
//  - run-search.vbs      必须无 BOM 且纯 ASCII（WSH 把 BOM 当脚本正文）
import { readFileSync, writeFileSync } from 'node:fs'

const DIR = 'C:\\Users\\digua\\Desktop\\dsh-voice-dialog\\scripts\\'
const BOM = '\uFEFF'

// ── 1. ps1 加 BOM ────────────────────────────────────────────────────────────
const ps1Path = DIR + 'search-meituan.ps1'
let ps1 = readFileSync(ps1Path, 'utf8')
if (!ps1.startsWith(BOM)) {
  writeFileSync(ps1Path, BOM + ps1, 'utf8')
  console.log('已加 UTF-8 BOM: search-meituan.ps1')
} else {
  console.log('已有 BOM: search-meituan.ps1')
}

// ── 2. VBS：无 BOM + 纯 ASCII ────────────────────────────────────────────────
const vbs = [
  "' Launch the Meituan mini-program search.",
  "'",
  "' Invoked by the .cmd. The wscript hop keeps this off the caller's process",
  "' tree, so closing the launcher cannot interrupt the UI automation half-way.",
  "'",
  "' Encoding rules: NO UTF-8 BOM (Windows Script Host parses the BOM bytes as",
  "' script text and fails at line 1), and ASCII only (WSH reads .vbs as ANSI).",
  "' All Chinese text lives in search-meituan.ps1, which is UTF-8 with a BOM.",
  '',
  'Option Explicit',
  '',
  'Dim shell, fso, here, ps1, cmd',
  'Set shell = CreateObject("WScript.Shell")',
  'Set fso = CreateObject("Scripting.FileSystemObject")',
  '',
  'here = fso.GetParentFolderName(WScript.ScriptFullName)',
  'ps1 = fso.BuildPath(here, "search-meituan.ps1")',
  '',
  'If Not fso.FileExists(ps1) Then',
  '  MsgBox "Script not found:" & vbCrLf & ps1, 16, "Meituan search"',
  '  WScript.Quit 1',
  'End If',
  '',
  "' Visible window: the script prints progress and prompts for the keyword.",
  'cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1 & """"',
  '',
  'On Error Resume Next',
  'shell.Run cmd, 1, False',
  'If Err.Number <> 0 Then',
  '  MsgBox "Could not start PowerShell: " & Err.Description, 16, "Meituan search"',
  '  WScript.Quit 1',
  'End If',
  'On Error GoTo 0',
  '',
  'WScript.Quit 0',
  ''
].join('\r\n')
writeFileSync(DIR + 'run-search.vbs', vbs, 'ascii')
console.log('已写入（ASCII 无 BOM）: run-search.vbs')

// ── 3. cmd：纯 ASCII ────────────────────────────────────────────────────────
const cmd = [
  '@echo off',
  'rem ==========================================================================',
  'rem  Search the Meituan mini-program -- double-click the "Meituan search"',
  'rem  shortcut, or this file directly.',
  'rem',
  'rem  It prompts for a keyword, then drives WeChat and the mini-program to run',
  'rem  the search locally. That skips the round trip through the AI, which had to',
  'rem  click a dozen times per search.',
  'rem',
  'rem  ASCII only: cmd.exe executes mis-decoded UTF-8 comments as commands.',
  'rem  The visible PowerShell window is intentional -- it prompts for the keyword.',
  'rem ==========================================================================',
  '',
  'setlocal',
  'set "VBS=%~dp0run-search.vbs"',
  '',
  'if not exist "%VBS%" (',
  '  echo [ERROR] missing launcher: "%VBS%"',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'start "" wscript.exe //nologo "%VBS%"',
  'exit /b 0',
  ''
].join('\r\n')
writeFileSync(DIR + '\u641c\u7f8e\u56e2.cmd', cmd, 'ascii')
console.log('已写入（ASCII 无 BOM）: 搜美团.cmd')
