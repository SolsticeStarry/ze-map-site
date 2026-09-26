@echo off
title ZE terrain bake - START
echo Preparing toolchain + task, then starting bake as SYSTEM...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0core\bootstrap.ps1'"
echo Waiting for engine to come up...
timeout /t 8 /nobreak >nul
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0core\status-bake.ps1"
echo.
pause
