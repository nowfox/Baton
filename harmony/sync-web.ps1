# Build the Baton web frontend and copy it into the HarmonyOS rawfile bundle.
# Windows PowerShell equivalent of sync-web.sh. Run from anywhere:
#   powershell -ExecutionPolicy Bypass -File harmony\sync-web.ps1
$ErrorActionPreference = 'Stop'

$Here      = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $Here
$Rawfile   = Join-Path $Here 'entry\src\main\resources\rawfile'

Write-Host '==> vite build (repo root)'
Push-Location $RepoRoot
try { npm run build } finally { Pop-Location }

Write-Host "==> clearing $Rawfile"
Get-ChildItem -Path $Rawfile -Force | Where-Object { $_.Name -ne '.gitkeep' } | Remove-Item -Recurse -Force

Write-Host '==> copying dist\ -> rawfile\'
Copy-Item -Path (Join-Path $RepoRoot 'dist\*') -Destination $Rawfile -Recurse -Force

Write-Host '==> done. Entry page: rawfile\landing.html'
