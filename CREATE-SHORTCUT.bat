@echo off
rem Creates a "Jokerz AIO" shortcut on your Desktop that runs START-JOKERZ.bat
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Jokerz AIO.lnk');" ^
  "$s.TargetPath='%~dp0START-JOKERZ.bat';$s.WorkingDirectory='%~dp0';$s.IconLocation='%SystemRoot%\System32\shell32.dll,137';$s.Save()"
if errorlevel 1 (echo Could not create the shortcut.) else (echo Shortcut "Jokerz AIO" created on your Desktop.)
pause
