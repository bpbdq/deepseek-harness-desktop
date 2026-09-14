@echo off
REM Publish a new release: bump the version, commit, tag, push, and trigger CI.
REM
REM   release.bat             release the next version (1.0.0 -> 1.0.1 -> ... -> 1.1.0)
REM   release.bat 1.1.0       set the version explicitly
REM   release.bat --dry-run    print what would happen, change nothing
REM
REM Keep this file PURE ASCII. cmd.exe reads a .bat byte by byte and splits multi-byte
REM UTF-8 characters into separate "commands" - a Chinese REM comment here once turned
REM into an "'??' is not recognized as an internal or external command" error.
REM All localized output is printed by scripts\release.mjs instead.

setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [release] Node.js not found on PATH.
  exit /b 1
)

node scripts\release.mjs %*
set code=%errorlevel%
endlocal & exit /b %code%
