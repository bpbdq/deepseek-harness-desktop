@echo off
rem ============================================================================
rem  Push the CI fix and re-trigger the v1.0.0 release.
rem
rem  The tag moved to the fixed commit, so it needs a force push. Branch main is
rem  a normal fast-forward.
rem
rem  When prompted for a password, paste a Personal Access Token
rem  (classic, scope "repo"): https://github.com/settings/tokens
rem
rem  NOTE: pure ASCII on purpose -- cmd.exe splits multi-byte UTF-8 characters in
rem  .bat files into bogus commands.
rem ============================================================================
setlocal
cd /d "%~dp0"

set "PROXY=http://127.0.0.1:7890"
set "GIT=git -c http.proxy=%PROXY% -c https.proxy=%PROXY%"

echo ============================================================
echo  Pushing main and re-triggering tag v1.0.0
echo ============================================================
echo.

echo [1/2] Pushing branch main ...
%GIT% push origin main
if errorlevel 1 goto :failed

echo.
echo [2/2] Force-moving tag v1.0.0 to the fixed commit ...
%GIT% push --force origin v1.0.0
if errorlevel 1 goto :failed

echo.
echo ============================================================
echo  DONE. A new release run should now start:
echo    https://github.com/pucj0/deepseek-harness-desktop/actions
echo ============================================================
pause
exit /b 0

:failed
echo.
echo ============================================================
echo  PUSH FAILED (see the error above).
echo.
echo  If the token was rejected, create a new one (scope "repo"):
echo    https://github.com/settings/tokens
echo  If the proxy is down, Clash Verge must listen on 7890.
echo ============================================================
pause
exit /b 1
