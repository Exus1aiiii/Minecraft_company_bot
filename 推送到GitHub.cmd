@echo off
rem ===========================================================================
rem  KEEP THIS FILE PURE ASCII AND CRLF. Do not add Chinese text here.
rem
rem  Why: cmd.exe decodes a .cmd file using the console code page. On a Chinese
rem    Windows that is GBK/936, so UTF-8 Chinese comments are decoded as
rem    garbage -- and the garbage eats the line break, merging the "rem" line
rem    with the command below it. LF-only line endings make it worse.
rem
rem  So: all Chinese messages live in tools\push-github.ps1 (UTF-8 WITH BOM).
rem  tools\check-launchers.mjs enforces both rules and runs in the test suite.
rem
rem  Double-clicking this file pushes local commits to GitHub. The git proxy
rem  settings for this repo are set up by the script itself (see its header):
rem  a "Failed to connect to github.com:443 ... Could not connect to server"
rem  push means git was not going through the local proxy at all.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\push-github.ps1" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
