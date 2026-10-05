@echo off
title Stop Jokerz
echo Cerrando Node del AIO...
taskkill /FI "WINDOWTITLE eq Jokerz SERVER*" /T /F >nul 2>&1
taskkill /FI "WINDOWTITLE eq Jokerz UI*" /T /F >nul 2>&1
echo Listo. Si sigue vivo, cierra las ventanas negras a mano.
pause
