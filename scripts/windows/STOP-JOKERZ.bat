@echo off
title Stop Jokerz
echo Cerrando Jokerz AIO...
rem 1) launcher window (START-JOKERZ.bat) and old 2-window setup
taskkill /FI "WINDOWTITLE eq Jokerz AIO*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Jokerz SERVER*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Jokerz UI*" /T /F >nul 2>&1
rem 2) any AIO node process left (launcher, engine server, UI) + whatever still holds ports 8080 / 8787
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'launcher\.mjs|aio-api\.mjs|with-app-env\.mjs|vite' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue };" ^
  "Get-NetTCPConnection -LocalPort 8080,8787 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"
echo Listo.
if /i not "%~1"=="/nopause" pause
