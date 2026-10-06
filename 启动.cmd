@echo off
rem ===========================================================================
rem  KEEP THIS FILE PURE ASCII AND CRLF. Do not add Chinese text here.
rem
rem  Why (this actually broke the first double-click launch):
rem    cmd.exe decodes a .cmd file using the console code page. On a Chinese
rem    Windows that is GBK/936, so UTF-8 Chinese comments are decoded as
rem    garbage -- and the garbage eats the line break, merging the "rem" line
rem    with the command below it. Result: every Chinese comment turned into
rem    "'xxx' is not recognized as an internal or external command", and the
rem    window never opened. LF-only line endings make it worse.
rem
rem  So: all Chinese messages live in tools\launch-gui.ps1 (UTF-8 WITH BOM).
rem  tools\check-launchers.mjs enforces both rules and runs in the test suite.
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\launch-gui.ps1" %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
