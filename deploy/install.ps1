<#
  Solar View - first-time install on the PROD server (10.10.1.2)

  RUN ON THE SERVER (RDP session), in PowerShell **as Administrator**:
    powershell -ExecutionPolicy Bypass -File \\tsclient\C\Dev\solar-dashboard\deploy\install.ps1

  What it does:
    1. Checks Node.js
    2. Copies the app from your PC (\\tsclient\C\Dev\solar-dashboard) to C:\Apps\solar-dashboard
    3. Installs the packages (npm ci --omit=dev)
    4. Creates .env from env.production.example the first time (then stops so you can fill it in)
    5. Checks the database connection
    6. Installs + starts the Windows service "Solar View" (via NSSM), restarts on failure, starts at boot
    7. Checks http://127.0.0.1:3020/api/health
  Safe to run again.
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
function Warn($t) { Write-Host "  !!  $t" -ForegroundColor Yellow }
function Fail($t) { Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

# --- 0. Administrator? ---
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Open PowerShell with "Run as administrator" and try again.' }

# --- 1. Node ---
Step 'Node.js'
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail 'Node.js is not installed. Install Node 22 LTS from https://nodejs.org and run this again.' }
$ver = (& $node -v)
if ([int]($ver.TrimStart('v').Split('.')[0]) -lt 20) { Fail "Node $ver is too old - install Node 22 LTS or newer." }
Ok "Node $ver at $node"

# --- 2. Copy the app ---
Step "Copy app  $Source  ->  $Target"
if (-not (Test-Path (Join-Path $Source 'index.js'))) { Fail "Can't find the app at $Source. Is the RDP session sharing your C: drive (\\tsclient\C)?" }
New-Item -ItemType Directory -Force -Path $Target, (Join-Path $Target 'logs') | Out-Null
# /MIR keeps the server identical to your PC, except what's excluded:
#   server-only things (.env, node_modules, logs, the uploaded APK) and things that must never go live.
$xd = @('node_modules', '.git', '.vscode', '_to_delete', 'logs', 'downloads', 'build', 'app')
$xf = @('.env', '.test-users.local.json', '.preview-*.html', '*.keystore', '*.jks', '*.log')
robocopy $Source $Target /MIR /NFL /NDL /NJH /NP /R:2 /W:2 /XD $xd /XF $xf | Out-Null
if ($LASTEXITCODE -ge 8) { Fail "Copy failed (robocopy code $LASTEXITCODE)." }
Ok 'Files copied'

# --- 3. Packages ---
Step 'Install packages'
Push-Location $Target
try {
  & npm ci --omit=dev --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
  Ok 'npm packages installed'
} catch {
  Warn "npm couldn't download packages (no internet on the server?). Copying node_modules from your PC instead."
  robocopy (Join-Path $Source 'node_modules') (Join-Path $Target 'node_modules') /MIR /NFL /NDL /NJH /NP /R:2 /W:2 | Out-Null
  if ($LASTEXITCODE -ge 8) { Pop-Location; Fail 'Copying node_modules failed too.' }
  Ok 'node_modules copied from your PC'
}
Pop-Location

# --- 4. .env ---
Step 'Settings (.env)'
$envFile = Join-Path $Target '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $Source 'deploy\env.production.example') $envFile
  Warn "Created $envFile from the template."
  Warn 'Fill in VRM_TOKEN and DB_PASSWORD (Notepad is opening), save, then run this script again.'
  Start-Process notepad.exe $envFile
  exit 0
}
if ((Get-Content $envFile | Where-Object { $_ -notmatch '^\s*#' }) -match '<<') { Start-Process notepad.exe $envFile; Fail '.env still has <<...>> placeholders - fill them in, save, and run again.' }
Ok '.env present'

# --- 5. Database ---
Step 'Database check'
Push-Location $Target
& $node scripts/check-db.js
$dbOk = ($LASTEXITCODE -eq 0)
Pop-Location
if (-not $dbOk) { Fail 'Database check failed - see the message above. (Have you run db/001-005 on this server''s MySQL?)' }

# --- 6. Windows service (NSSM) ---
Step "Windows service '$ServiceName'"
if (-not (Test-Path $Nssm)) {
  Warn "NSSM not found at $Nssm - downloading it."
  try {
    $zip = Join-Path $env:TEMP 'nssm-2.24.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest 'https://nssm.cc/release/nssm-2.24.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath (Join-Path $env:TEMP 'nssm') -Force
    New-Item -ItemType Directory -Force -Path (Split-Path $Nssm) | Out-Null
    Copy-Item (Join-Path $env:TEMP 'nssm\nssm-2.24\win64\nssm.exe') $Nssm -Force
    Ok "NSSM installed at $Nssm"
  } catch {
    Fail "Couldn't download NSSM. On your PC, download https://nssm.cc/release/nssm-2.24.zip, copy win64\nssm.exe to $Nssm on this server, and run again."
  }
}
# Run as the low-privilege LocalService account; it only needs to read the app and write its logs.
icacls $Target /grant 'NT AUTHORITY\LocalService:(OI)(CI)RX' /T /Q | Out-Null
icacls (Join-Path $Target 'logs') /grant 'NT AUTHORITY\LocalService:(OI)(CI)M' /T /Q | Out-Null

$exists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($exists) { & $Nssm stop $ServiceName | Out-Null } else { & $Nssm install $ServiceName $node index.js | Out-Null }
& $Nssm set $ServiceName Application $node | Out-Null
& $Nssm set $ServiceName AppParameters 'index.js' | Out-Null
& $Nssm set $ServiceName AppDirectory $Target | Out-Null
& $Nssm set $ServiceName DisplayName 'Solar View dashboard' | Out-Null
& $Nssm set $ServiceName Description 'Solar View dashboard (Node.js) behind IIS - solar-view.primebridge.co.za' | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
& sc.exe config $ServiceName obj= 'NT AUTHORITY\LocalService' | Out-Null   # built-in account, no password
& $Nssm set $ServiceName AppEnvironmentExtra 'NODE_ENV=production' | Out-Null
& $Nssm set $ServiceName AppStdout (Join-Path $Target 'logs\solar.log') | Out-Null
& $Nssm set $ServiceName AppStderr (Join-Path $Target 'logs\solar-error.log') | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
& $Nssm set $ServiceName AppRotateOnline 1 | Out-Null
& $Nssm set $ServiceName AppRotateBytes 5242880 | Out-Null
& $Nssm set $ServiceName AppExit Default Restart | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000 | Out-Null
& $Nssm start $ServiceName | Out-Null
Ok "Service '$ServiceName' installed and started (starts with Windows, restarts if it stops)"

# --- 7. Health ---
Step 'Health check'
$healthy = $false
foreach ($i in 1..30) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 5
    if ($r.StatusCode -eq 200) { $healthy = $true; break }
  } catch { }
}
if (-not $healthy) {
  Warn 'The app did not answer. Last lines of the error log:'
  Get-Content (Join-Path $Target 'logs\solar-error.log') -Tail 20 -ErrorAction SilentlyContinue
  Fail 'Fix the error above, then run this script again.'
}
Ok "App is running on http://127.0.0.1:$Port"
Write-Host "`nNext: run deploy\iis-setup.ps1 (first time only), then open https://solar-view.primebridge.co.za" -ForegroundColor Cyan
