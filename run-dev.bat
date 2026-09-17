@echo off
rem ============================================================================
rem  Run the app in development mode with console output visible.
rem
rem  Used to diagnose features that only fail when actually opened (the Project
rem  Info panel). Runs in its own window so the DSH sandbox Job cannot reap it.
rem
rem  Usage: run-dev.bat [workspace-path]
rem
rem  NOTE: pure ASCII on purpose -- cmd.exe splits multi-byte UTF-8 characters in
rem  .bat files into bogus commands.
rem ============================================================================
setlocal
cd /d "%~dp0"

set "WS=%~1"
if "%WS%"=="" set "WS=%CD%"

rem Isolate this run's harness home so it cannot disturb the installed app.
set "DSH_DESKTOP_HOME=%CD%\.dev-home"

echo ============================================================
echo  Development run
echo    workspace : %WS%
echo    data dir  : %DSH_DESKTOP_HOME%
echo.
echo  Watch this window for errors. To test the Project Info panel:
echo    1. wait for the window to appear
echo    2. press Ctrl+I
echo    3. report anything printed below
echo ============================================================
echo.

rem The single-instance lock is scoped to app.getPath('userData'), which
rem DSH_DESKTOP_HOME does NOT change. An installed build still running would make
rem this dev run exit instantly with code 0 and no output.
echo  Stopping any running instance (the single-instance lock is shared) ...
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>nul
taskkill /IM "electron.exe" /F >nul 2>nul
timeout /t 2 /nobreak >nul

rem --remote-debugging-port lets scripts/probe-ui.mjs inspect and drive the live
rem DOM over CDP. Estimating screen coordinates for UI checks proved unreliable,
rem so DOM queries are the primary verification path.
echo  DevTools protocol on http://127.0.0.1:9222
echo.

rem Use the same sync/build/start flow as command-line development.
call npm.cmd run dev -- "%WS%" --remote-debugging-port=9222
echo.
echo ============================================================
echo  Electron exited with code %errorlevel%
echo  (code 0 with no window means the single-instance lock was taken again)
echo ============================================================
pause
