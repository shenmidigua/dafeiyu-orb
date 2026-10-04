@echo off
rem ============================================================================
rem  重启 DSH web 服务器，加载 dsh-voice-dialog 的本地唤醒功能。
rem
rem  为什么要用批处理、而不是让 AI 直接重启：
rem  这个会话里的任何子进程都会随 AI 的进程一起被清理（job object kill-on-close），
rem  所以重启器必须从会话之外启动 —— 也就是你双击这个文件。
rem
rem  流程：本脚本启动 restart-web.mjs，它会先等 3080 端口释放，
rem  再以 detached 方式启动全新的 dsh web，最后探测就绪状态（401 = 成功）。
rem  旧服务器由你手动结束（见下方提示），或者等你关闭当前页面后自行退出。
rem ============================================================================

setlocal
set NODE=D:\DeepSeekHarness\node\node.exe
set SCRIPT=%~dp0restart-web.mjs

echo.
echo ============================================================
echo   正在启动 DSH web 重启器...
echo ============================================================
echo.

if not exist "%NODE%" (
  echo [错误] 找不到 node.exe: %NODE%
  pause
  exit /b 1
)
if not exist "%SCRIPT%" (
  echo [错误] 找不到重启脚本: %SCRIPT%
  pause
  exit /b 1
)

echo 重启器将在后台等待 3080 端口释放。
echo.
echo 如果它一直不继续，请手动结束占用 3080 的进程：
echo   1^) 打开任务管理器
echo   2^) 找到占用 3080 端口的 node 进程并结束它
echo.
echo 新服务器启动后，请到下面这个目录找最新的 web-*.log：
echo   %~dp0logs
echo 里面有一行 "dsh web: http://127.0.0.1:3080/?token=..." 
echo 用那个带 token 的完整地址打开浏览器。
echo.

start "dsh-restart" /min "%NODE%" "%SCRIPT%" --port 3080 --timeout-ms 300000

echo 已启动。本窗口可以关闭。
timeout /t 6 >nul
