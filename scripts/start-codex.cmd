@echo off
REM Double-clickable wrapper around Start-Codex-WithModels.ps1.
REM Pass "restart" to restart Codex (and its backends) instead of just
REM checking the router and launching.
chcp 65001 >nul
title Codex (multi-model router)

set "LAUNCHER=%~dp0Start-Codex-WithModels.ps1"

REM Use the absolute interpreter path, and pick Windows PowerShell 5.1
REM deliberately: it is always present and its module set is complete. Some
REM bundled runtimes (the one Codex ships is one) expose a PowerShell 7
REM directory, so the bare name can resolve to the wrong build.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

REM If this is started from a shell that has such a runtime on PSModulePath,
REM 5.1 loads that runtime's Microsoft.PowerShell.Utility and core cmdlets
REM (Get-FileHash, Invoke-RestMethod) vanish. Reset to the system defaults;
REM everything the launcher calls lives there.
set "PSModulePath=%ProgramFiles%\WindowsPowerShell\Modules;%SystemRoot%\System32\WindowsPowerShell\v1.0\Modules"

if /I "%~1"=="restart" (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Restart
) else (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
)

if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close.
  pause >nul
  exit /b 1
)

REM Hold the window briefly so the result is readable, then report success
REM regardless of what that hold command returns.
timeout /t 2 /nobreak >nul 2>nul
exit /b 0