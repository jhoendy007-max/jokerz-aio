@echo off
setlocal EnableExtensions
title Jokerz AIO
cd /d "%~dp0"
if exist "package.json" goto :ready
if exist "%~dp0scripts\windows\START-JOKERZ.bat" (
  call "%~dp0scripts\windows\START-JOKERZ.bat"
  exit /b %ERRORLEVEL%
)
echo Put START-JOKERZ.bat next to package.json
pause
exit /b 1

:ready
where node >nul 2>&1
if errorlevel 1 (
  echo Node is not on PATH. Run INSTALL-JOKERZ.bat first.
  pause
  exit /b 1
)
if not exist "node_modules\" (
  echo First run: npm install...
  call npm.cmd install --no-fund --no-audit
)

echo.
echo [1/2] Engine (harvest, monitor, checkout)
start "Jokerz SERVER" cmd /k "cd /d "%CD%" && npm.cmd run server"

timeout /t 3 /nobreak >nul

echo [2/2] UI
start "Jokerz UI" cmd /k "cd /d "%CD%" && npm.cmd run dev"

timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:8080/"

echo.
echo Both windows must stay open.
echo Browser should open the UI.
echo Harvest: Settings - Harvesters - Play
echo Stop: STOP-JOKERZ.bat
pause
