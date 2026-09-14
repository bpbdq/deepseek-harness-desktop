@echo off
rem ============================================================================
rem  Version management - thin wrapper; logic lives in scripts\version.mjs
rem
rem  Usage:
rem    version.bat            show current and next version
rem    version.bat next       bump (1.0.0 -> 1.0.1 -> ... -> 1.0.9 -> 1.1.0)
rem    version.bat list       list the release sequence
rem    version.bat 1.0.3      set an explicit version
rem
rem  NOTE: keep this file pure ASCII. cmd.exe reads a .bat byte by byte and
rem  splits multi-byte UTF-8 characters, turning Chinese text into bogus
rem  commands. All localized output lives in scripts\version.mjs instead.
rem ============================================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [version] ERROR: node not found. Install Node.js 20+ first.
  exit /b 1
)

node "scripts\version.mjs" %*
exit /b %errorlevel%
