@echo off
title Jokerz - Tareas programadas
cd /d "%~dp0"
if not exist "START-JOKERZ.bat" (
  if exist "..\..\START-JOKERZ.bat" cd /d "%~dp0\..\.."
)
if not exist "START-JOKERZ.bat" (
  echo Pon este archivo junto a START-JOKERZ.bat
  pause
  exit /b 1
)

set "START=%cd%\START-JOKERZ.bat"
set "STOP=%cd%\STOP-JOKERZ.bat"

echo.
echo  1  Arrancar el AIO cuando inicies Windows
echo  2  Arrancar TODOS LOS DIAS a una hora (harvest listo)
echo  3  Las dos (logon + diario)
echo  4  Quitar las tareas
echo  5  Salir
echo.
choice /C 12345 /N /M "Elige 1-5: "
if errorlevel 5 goto :eof
if errorlevel 4 goto :remove
if errorlevel 3 goto :both
if errorlevel 2 goto :daily
if errorlevel 1 goto :logon

:logon
schtasks /Create /TN "Jokerz AIO Logon" /TR "\"%START%\"" /SC ONLOGON /RL LIMITED /F
echo OK - Jokerz AIO Logon
pause
goto :eof

:daily
set /p HORA=Hora 24h (ejemplo 07:30): 
if "%HORA%"=="" set HORA=07:30
schtasks /Create /TN "Jokerz AIO Daily" /TR "\"%START%\"" /SC DAILY /ST %HORA% /RL LIMITED /F
echo OK - todos los dias a las %HORA%
pause
goto :eof

:both
set /p HORA=Hora diaria 24h (ejemplo 07:30): 
if "%HORA%"=="" set HORA=07:30
schtasks /Create /TN "Jokerz AIO Logon" /TR "\"%START%\"" /SC ONLOGON /RL LIMITED /F
schtasks /Create /TN "Jokerz AIO Daily" /TR "\"%START%\"" /SC DAILY /ST %HORA% /RL LIMITED /F
echo OK - logon + diario %HORA%
pause
goto :eof

:remove
schtasks /Delete /TN "Jokerz AIO Logon" /F >nul 2>&1
schtasks /Delete /TN "Jokerz AIO Daily" /F >nul 2>&1
echo Tareas de Jokerz borradas
pause
