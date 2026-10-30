<#
  Solar View - point the IIS site for solar-view.primebridge.co.za at the Node app (first time only)

  RUN ON THE SERVER, PowerShell as Administrator, AFTER install.ps1:
    powershell -ExecutionPolicy Bypass -File \\tsclient\C\Dev\solar-dashboard\deploy\iis-setup.ps1
  Optional: -SiteName "Exact IIS site name"   (otherwise it finds the site bound to the host name)

  Needs these free IIS add-ons (the script checks):
    * URL Rewrite 2.1                    https://www.iis.net/downloads/microsoft/url-rewrite
    * Application Request Routing 3.0    https://www.iis.net/downloads/microsoft/application-request-routing
#>
param(
  [string]$HostName = 'solar-view.primebridge.co.za',
  [string]$SiteName = '',
  [string]$Source   = (Split-Path -Parent $PSScriptRoot),
  [string]$IisRoot  = 'C:\Apps\Solar-View'
)
$ErrorActionPreference = 'Stop'
function Step($t) { Write-Host "`n=== $t" -ForegroundColor Cyan }
function Ok($t)   { Write-Host "  OK  $t" -ForegroundColor Green }
function Fail($t) { Write-Host "  XX  $t" -ForegroundColor Red; exit 1 }

Import-Module WebAdministration

Step 'IIS add-ons'
$mods = (Get-WebGlobalModule).Name
if ($mods -notcontains 'RewriteModule') { Fail 'URL Rewrite is not installed: https://www.iis.net/downloads/microsoft/url-rewrite - install it and run again.' }
if ($mods -notcontains 'ApplicationRequestRouting') { Fail 'Application Request Routing is not installed: https://www.iis.net/downloads/microsoft/application-request-routing - install it and run again.' }
Ok 'URL Rewrite + ARR present'

Step 'Turn on the ARR proxy (server level)'
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'enabled' -Value 'True'
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'preserveHostHeader' -Value 'True'
Set-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Filter 'system.webServer/proxy' -Name 'reverseRewriteHostInResponseHeaders' -Value 'False'
Ok 'Proxy enabled; the app sees the real host name'

Step "Find the IIS site for $HostName"
if (-not $SiteName) {
  $site = Get-Website | Where-Object { $_.bindings.Collection.bindingInformation -match [regex]::Escape($HostName) } | Select-Object -First 1
  if (-not $site) { Fail "No IIS site has a binding for $HostName. Run again with -SiteName ""<your site name>""." }
  $SiteName = $site.Name
}
Ok "Site: $SiteName"

Step 'Allow the X-Forwarded-Proto header (so the app knows the visitor used HTTPS)'
try {
  Add-WebConfigurationProperty -PSPath 'MACHINE/WEBROOT/APPHOST' -Location $SiteName -Filter 'system.webServer/rewrite/allowedServerVariables' -Name '.' -Value @{ name = 'HTTP_X_FORWARDED_PROTO' }
} catch {
  # Already allowed (duplicate entry) is fine - anything else is a real error.
  if ($_.Exception.Message -notmatch 'duplicate collection entry') { throw }
}
Ok 'Allowed'

Step "Site folder -> $IisRoot (only web.config lives here; the app itself is never served as files)"
New-Item -ItemType Directory -Force -Path $IisRoot | Out-Null
Copy-Item (Join-Path $Source 'deploy\web.config') (Join-Path $IisRoot 'web.config') -Force
Set-ItemProperty "IIS:\Sites\$SiteName" -Name physicalPath -Value $IisRoot
Ok 'web.config in place'

Step 'Test through IIS'
Start-Sleep -Seconds 2
try {
  $r = Invoke-WebRequest "https://$HostName/api/health" -UseBasicParsing -TimeoutSec 15
  Ok "https://$HostName/api/health -> $($r.StatusCode) $($r.Content)"
} catch {
  Write-Host "  !!  https://$HostName/api/health didn't answer from the server itself: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host '      (This can be normal if the server can''t resolve its own public name - try the address in your browser.)' -ForegroundColor Yellow
}
Write-Host "`nOpen https://$HostName in your browser." -ForegroundColor Cyan
