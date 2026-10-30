<#
  Solar View - deploy a new version to PROD (10.10.1.2)

  1. On your PC: commit and push your changes as usual.
  2. On the server (RDP session), PowerShell as Administrator:
       powershell -ExecutionPolicy Bypass -File \\tsclient\C\Dev\solar-dashboard\deploy\update.ps1

  Keeps the server's .env and logs. Sign-ins survive the restart (sessions are in MySQL).
  Takes the site down for ~10-20 seconds while packages update; IIS shows "502" during that time.
#>
param(
  [string]$Source      = (Split-Path -Parent $PSScriptRoot),
  [string]$Target      = 'C:\Apps\solar-dashboard',
  [string]$ServiceName = 'SolarView',
  [int]   $Port        = 3020,
  [string]$Nssm        = 'C:\Tools\nssm\nssm.exe'
)
$ErrorActionPreference = 'Stop'
function Step($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Fail($t) { Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

if (-not (Test-Path (Join-Path $Target '.env'))) { Fail "No install found at $Target - run install.ps1 first." }
if (-not (Test-Path (Join-Path $Source 'index.js'))) { Fail "Can't see the app at $Source. Is the RDP session sharing your C: drive?" }

Step 'Backup current version'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = "C:\Apps\_backups\solar-$stamp"
New-Item -ItemType Directory -Force -Path $backup | Out-Null
robocopy $Target $backup /E /NFL /NDL /NJH /NP /R:1 /W:1 /XD node_modules logs downloads | Out-Null
Ok "Backup in $backup (to roll back: copy it back over $Target and restart the service)"
# Keep the 5 newest backups
Get-ChildItem 'C:\Apps\_backups' -Directory | Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Recurse -Force

Step 'Stop service'
& $Nssm stop $ServiceName | Out-Null
Ok 'Stopped'

Step 'Copy new version'
$xd = @('node_modules', '.git', '.vscode', '_to_delete', 'logs', 'downloads', 'build', 'app')
$xf = @('.env', '.test-users.local.json', '.preview-*.html', '*.keystore', '*.jks', '*.log')
robocopy $Source $Target /MIR /NFL /NDL /NJH /NP /R:2 /W:2 /XD $xd /XF $xf | Out-Null
if ($LASTEXITCODE -ge 8) { & $Nssm start $ServiceName | Out-Null; Fail "Copy failed (robocopy code $LASTEXITCODE). The old version was restarted." }
Ok 'Files copied'

Step 'Packages'
Push-Location $Target
& npm ci --omit=dev --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
  Write-Host '  npm unavailable - copying node_modules from your PC' -ForegroundColor Yellow
  robocopy (Join-Path $Source 'node_modules') (Join-Path $Target 'node_modules') /MIR /NFL /NDL /NJH /NP /R:2 /W:2 | Out-Null
}
Pop-Location
Ok 'Packages ready'

Step 'Start service'
& $Nssm start $ServiceName | Out-Null
$healthy = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) { $healthy = $true; break } } catch { }
}
if (-not $healthy) {
  Get-Content (Join-Path $Target 'logs\solar-error.log') -Tail 20 -ErrorAction SilentlyContinue
  Fail "The new version isn't answering. Roll back: copy $backup over $Target, then: $Nssm restart $ServiceName"
}
Ok 'Live: https://solar-view.primebridge.co.za'
Write-Host '  If you added a db\00x script in this release, run it in MySQL Workbench on 10.10.1.2 as well.' -ForegroundColor Yellow
