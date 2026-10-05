@echo off
title Jokerz AIO
cd /d "%~dp0"
if exist "package.json" goto :ready
cd /d "%~dp0\..\.."
if exist "package.json" goto :ready
echo Put START-JOKERZ.bat in the aio folder (next to package.json)
pause
exit /b 1

:ready
if not exist "node_modules\" (
  echo First run: installing...
  call npm install
)

echo.
echo [1/2] Engine
start "Jokerz SERVER" cmd /k "cd /d "%cd%" && npm run server"

timeout /t 3 /nobreak >nul

echo [2/2] UI
start "Jokerz UI" cmd /k "cd /d "%cd%" && npm run dev"

timeout /t 6 /nobreak >nul
start "" "http://127.0.0.1:8080/"

echo.
echo Leave both windows open. Browser opens the UI.
echo Harvest: Settings - Harvesters - Play
echo Stop: STOP-JOKERZ.bat
pause
