@echo off
REM Thin wrapper so the launcher can be double-clicked.
REM Pass "restart" to fully restart Codex and reload the router/bridge code.
chcp 65001 >nul
title Codex (multi-model router)

set "LAUNCHER=%~dp0Start-Codex-WithModels.ps1"

if /I "%~1"=="restart" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Restart
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%"
)

if errorlevel 1 (
  echo.
  echo Startup failed. Press any key to close.
  pause >nul
) else (
  timeout /t 2 /nobreak >nul
)