@echo off
chcp 65001 >nul
title ZE terrain bake - STATUS
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\status-bake.ps1"
echo.
pause
