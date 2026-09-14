@echo off
rem ============================================================================
rem  DeepSeek Harness desktop - one-command packaging
rem
rem  Usage:
rem    build.bat            Windows (setup.exe + .msi)
rem    build.bat win        same as above
rem    build.bat linux      Linux (AppImage + .deb)
rem    build.bat all        Windows + Linux
rem    build.bat mac        explain macOS packaging (cannot run on Windows)
rem    build.bat clean      wipe dist/release, then full Windows build
rem    build.bat help       show this help in full
rem
rem  Optional environment variables:
rem    SKIP_STAGE=1         skip runtime staging (saves a few minutes)
rem    SKIP_INSTALL=1       skip npm install
rem
rem  NOTE: keep this file pure ASCII. cmd.exe reads a .bat byte by byte and
rem  splits multi-byte UTF-8 characters, turning Chinese text into bogus
rem  commands. All localized output lives in scripts\build.mjs instead.
rem ============================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [build] ERROR: node not found. The build machine needs Node.js 20+ and npm.
  exit /b 1
)

node "scripts\build.mjs" %*
exit /b %errorlevel%
