@echo off
title Stop Jokerz
echo Cerrando Node del AIO...
taskkill /FI "WINDOWTITLE eq Jokerz SERVER*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Jokerz UI*" /T /F >nul 2>&1
for /f "tokens=2" %%a in ('tasklist /FI "IMAGENAME eq node.exe" /FO LIST ^| find "PID"') do (
  echo node PID %%a
)
echo Si el AIO sigue vivo, cierra las ventanas negras a mano.
pause
