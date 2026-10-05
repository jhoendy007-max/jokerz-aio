@echo off
setlocal EnableExtensions
title Jokerz AIO — Install
color 0A
cd /d "%~dp0"

echo.
echo  ========================================
echo   JOKERZ AIO  —  instalacion Windows
echo  ========================================
echo.

if exist "package.json" goto :found
if exist "%~dp0package.json" (
  cd /d "%~dp0"
  goto :found
)
if exist "%~dp0..\..\package.json" (
  cd /d "%~dp0..\.."
  goto :found
)
echo [FAIL] No encuentro package.json
echo Pon este .bat en la carpeta aio-task-manager (junto a package.json)
pause
exit /b 1

:found
echo [ok] Carpeta: %CD%
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [FAIL] Node.js no esta instalado.
  echo Baja LTS: https://nodejs.org
  echo Marca "Add to PATH" en el installer.
  start https://nodejs.org/en/download
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do set NODEVER=%%v
echo [ok] Node %NODEVER%

where npm >nul 2>&1
if errorlevel 1 (
  echo [FAIL] npm no esta en PATH. Reinstala Node LTS y marca Add to PATH.
  pause
  exit /b 1
)
for /f "tokens=*" %%v in ('npm -v') do echo [ok] npm %%v
echo.

set "CHROME="
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined CHROME (
  echo [ok] Google Chrome encontrado
) else (
  echo [WARN] Google Chrome no esta instalado.
  echo Harvest / login / ATC van mejor con Chrome real.
  echo https://www.google.com/chrome/
  echo Sigo con Chromium de Playwright...
)
echo.

echo [1/4] npm install  (puede tardar)
call npm.cmd install --no-fund --no-audit
if errorlevel 1 (
  echo [FAIL] npm install fallo. Cierra antivirus un minuto y corre este .bat otra vez.
  pause
  exit /b 1
)
echo [ok] dependencias
echo.

echo [2/4] Patchright  (stealth Target / Shape)
call npm.cmd install patchright --save --no-fund --no-audit
call npx.cmd --yes patchright install chromium
if errorlevel 1 (
  echo [WARN] Patchright chromium fallo — el bot usara Playwright.
)
echo.

echo [3/4] Playwright Chromium  (fallback)
call npx.cmd --yes playwright install chromium
if errorlevel 1 (
  echo [WARN] playwright install chromium fallo
)
echo.

echo [4/4] Check scripts
if not exist "node_modules\" (
  echo [FAIL] node_modules vacio
  pause
  exit /b 1
)
echo [ok] node_modules listo
echo.

echo  ========================================
echo   LISTO
echo  ========================================
echo.
echo  Siguiente: doble click START-JOKERZ.bat
echo  Harvest: Settings - Harvesters - Play
echo.
pause
exit /b 0
