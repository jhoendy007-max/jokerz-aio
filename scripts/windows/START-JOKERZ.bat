@echo off
setlocal EnableExtensions
title Jokerz AIO
cd /d "%~dp0"
if not exist "package.json" if exist "%~dp0..\..\package.json" cd /d "%~dp0..\.."
if exist "package.json" goto :ready
echo Put START-JOKERZ.bat next to package.json
pause
exit /b 1

:ready
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed or not on PATH.
  echo Install Node 20 LTS from https://nodejs.org then run INSTALL-JOKERZ.bat
  pause
  exit /b 1
)

rem One window: checks, installs what is missing, starts engine + UI, restarts on crash, opens the browser.
node scripts\launcher.mjs
echo.
echo Jokerz AIO stopped.
pause
