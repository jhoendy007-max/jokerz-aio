# Overlay a new jokerz-aio zip onto G:\My Drive\jokerzz aio\aio-task-manager
# Uso:
#   1. Baja el zip del chat
#   2. Click derecho -> Run with PowerShell
#   o:  powershell -ExecutionPolicy Bypass -File APPLY-UPDATE.ps1 -Zip "C:\Users\...\Downloads\jokerz-aio-v2026.08.26-harvest-refract.zip"

param(
  [string]$Zip = "",
  [string]$Dest = "G:\My Drive\jokerzz aio\aio-task-manager"
)

$ErrorActionPreference = "Stop"

if (-not $Zip) {
  $dl = Join-Path $env:USERPROFILE "Downloads"
  $Zip = Get-ChildItem -Path $dl, $PWD -Filter "jokerz-aio-*.zip" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}

if (-not $Zip -or -not (Test-Path $Zip)) {
  Write-Host "No encontre el zip. Pasa la ruta:"
  Write-Host '  .\APPLY-UPDATE.ps1 -Zip "C:\Users\...\Downloads\jokerz-aio-v2026.08.26-harvest-refract.zip"'
  exit 1
}

if (-not (Test-Path $Dest)) {
  Write-Host "No existe $Dest"
  exit 1
}

$tmp = Join-Path $env:TEMP ("jokerz-upd-" + [guid]::NewGuid().ToString("n"))
New-Item -ItemType Directory -Path $tmp | Out-Null
Expand-Archive -Path $Zip -DestinationPath $tmp -Force

$root = Get-ChildItem $tmp | Where-Object { $_.PSIsContainer } | Select-Object -First 1
if (-not $root) { $root = Get-Item $tmp }

$fromJokerz = Join-Path $root.FullName "src\jokerz"
$toJokerz = Join-Path $Dest "src\jokerz"
if (Test-Path $fromJokerz) {
  Write-Host "Copiando src\jokerz ..."
  if (Test-Path $toJokerz) { Remove-Item $toJokerz -Recurse -Force }
  Copy-Item $fromJokerz $toJokerz -Recurse -Force
}

$fromScripts = Join-Path $root.FullName "scripts"
if (Test-Path $fromScripts) {
  New-Item -ItemType Directory -Path (Join-Path $Dest "scripts") -Force | Out-Null
  Copy-Item (Join-Path $fromScripts "*") (Join-Path $Dest "scripts") -Recurse -Force
}

Get-ChildItem $root.FullName -Filter "*.bat" | ForEach-Object {
  Copy-Item $_.FullName $Dest -Force
}
Get-ChildItem $root.FullName -Filter "APPLY-UPDATE.ps1" -ErrorAction SilentlyContinue | ForEach-Object {
  Copy-Item $_.FullName $Dest -Force
}

Remove-Item $tmp -Recurse -Force
Write-Host "Update OK -> $Dest"
Write-Host "Corre START-JOKERZ.bat (cierra el AIO antes si estaba abierto)"
