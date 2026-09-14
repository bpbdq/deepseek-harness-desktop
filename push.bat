@echo off
rem ============================================================================
rem  Push this repository to GitHub.
rem
rem  Keeps the window open so you can read any error, and authenticates through
rem  git's own credential prompt. GitHub no longer accepts an account password
rem  over HTTPS: when prompted for a password, paste a Personal Access Token
rem  (classic, scope "repo"). Create one at:
rem    https://github.com/settings/tokens
rem
rem  NOTE: pure ASCII on purpose -- cmd.exe splits multi-byte UTF-8 characters in
rem  .bat files into bogus commands.
rem ============================================================================
setlocal
cd /d "%~dp0"

set "PROXY=http://127.0.0.1:7890"
set "REPO=https://github.com/pucj0/deepseek-harness-desktop.git"

echo ============================================================
echo  Pushing to %REPO%
echo  Proxy: %PROXY%
echo.
echo  If asked for a password, paste a Personal Access Token
echo  (classic, scope "repo"): https://github.com/settings/tokens
echo ============================================================
echo.

echo [1/2] Pushing branch main ...
git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push -u origin main
if errorlevel 1 goto :failed

echo.
echo [2/2] Pushing tag v1.0.0 ...
git -c http.proxy=%PROXY% -c https.proxy=%PROXY% push origin v1.0.0
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  DONE. Pushing the v1.0.0 tag starts the release workflow:
echo    https://github.com/pucj0/deepseek-harness-desktop/actions
echo ============================================================
pause
exit /b 0

:failed
echo.
echo ============================================================
echo  PUSH FAILED (see the error above).
echo.
echo  Common causes:
echo    * Wrong or expired token -> recreate it at the URL above
echo    * Proxy not running     -> Clash Verge must listen on 7890
echo    * No network to GitHub  -> check the proxy is actually on
echo ============================================================
pause
exit /b 1
