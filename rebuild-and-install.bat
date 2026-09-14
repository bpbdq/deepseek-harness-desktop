@echo off
rem ============================================================================
rem  Rebuild the Windows installer and install it (with the module self-heal fix).
rem
rem  Runs in its own window: the DSH sandbox manages child process trees with a
rem  Windows Job object, and closing that Job mid-build kills electron-builder.
rem
rem  NOTE: pure ASCII on purpose -- cmd.exe splits multi-byte UTF-8 characters in
rem  .bat files into bogus commands. All localized output comes from Node.
rem ============================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_BUILDER_BINARIES_MIRROR=https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
set "ELECTRON_MIRROR=https://registry.npmmirror.com/-/binary/electron/"
set "SKIP_STAGE=1"

echo ============================================================
echo  Build setup.exe only (MSI is a separate, slow target)
echo ============================================================
call node scripts\build.mjs win
if errorlevel 1 goto :failed

set "INSTALLER="
for %%f in ("release\*\DeepSeek Harness-x64.exe") do set "INSTALLER=%%~ff"
if not defined INSTALLER goto :noinstaller

echo.
echo ============================================================
echo  Install: %INSTALLER%
echo ============================================================
taskkill /IM "DeepSeek Harness.exe" /F >nul 2>nul
timeout /t 3 /nobreak >nul

rem A half-removed previous install makes NSIS abort (exit 2). Clear it first.
if exist "D:\Program Files\DeepSeek Harness" rmdir /s /q "D:\Program Files\DeepSeek Harness"
if exist "%LOCALAPPDATA%\Programs\DeepSeek Harness" rmdir /s /q "%LOCALAPPDATA%\Programs\DeepSeek Harness"

"%INSTALLER%" /S
echo  installer exit code: %errorlevel%

echo.
echo ============================================================
echo  DONE. Artifacts: release\<version>\
echo ============================================================
pause
exit /b 0

:noinstaller
echo ERROR: no installer found under release\<version>\.
pause
exit /b 1

:failed
echo ERROR: the build failed. Scroll up for the reason.
pause
exit /b 1
