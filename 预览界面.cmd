@echo off
rem ===========================================================================
rem  KEEP THIS FILE PURE ASCII AND CRLF -- see the note in the main launcher.
rem  Chinese text belongs in tools\launch-gui.ps1 (UTF-8 with BOM).
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%ROOT%tools\launch-gui.ps1" -Preview %*
set "CODE=%ERRORLEVEL%"
endlocal & exit /b %CODE%
