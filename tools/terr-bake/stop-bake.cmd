@echo off
title ZE terrain bake - STOP
echo Stopping bake pipeline...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0core\stop-bake.ps1'"
echo.
pause
