<#
  Start the MongoDB Windows service and keep it from dying again.

  Why: on this 8 GB machine mongod crashed with "out of memory" (it reserves
  ~50% of RAM for its cache by default) and the service stayed stopped, so
  every login failed with ServerSelectionTimeoutError.

  This script (asks for administrator rights once):
    1. caps the WiredTiger cache at 0.5 GB in mongod.cfg (backup kept)
    2. tells Windows to restart the service automatically if it crashes
    3. starts the service and waits until port 27017 answers

  Usage:  right-click > Run with PowerShell, or
          powershell -ExecutionPolicy Bypass -File scripts\start-mongodb.ps1
#>

$ErrorActionPreference = "Stop"
$ServiceName = "MongoDB"
$CacheGB = "0.5"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Asking for administrator rights to manage the MongoDB service..."
    Start-Process powershell.exe -Verb RunAs -Wait -ArgumentList @(
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"")
    exit
}

$service = Get-CimInstance Win32_Service -Filter "Name='$ServiceName'"
if (-not $service) {
    Write-Host "MongoDB service not found. Install MongoDB Community Server first." -ForegroundColor Red
    Read-Host "Press Enter to close"
    exit 1
}

# 1. Cap the cache so mongod cannot run the machine out of memory.
if ($service.PathName -match '--config\s+"([^"]+)"') {
    $cfg = $Matches[1]
    $text = Get-Content $cfg -Raw
    if ($text -notmatch "cacheSizeGB") {
        Copy-Item $cfg "$cfg.bak" -Force
        $text = $text -replace "(?m)^(\s*dbPath:.*)$", "`$1`r`n  wiredTiger:`r`n    engineConfig:`r`n      cacheSizeGB: $CacheGB"
        Set-Content -Path $cfg -Value $text -Encoding ascii
        Write-Host "Capped MongoDB cache at $CacheGB GB in $cfg (backup: mongod.cfg.bak)"
    } else {
        Write-Host "Cache size already configured in $cfg"
    }
}

# 2. Restart automatically after a crash (5 s, 10 s, 30 s).
sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/10000/restart/30000 | Out-Null
sc.exe config $ServiceName start= auto | Out-Null
Write-Host "Service set to start with Windows and restart after a crash"

# 3. Start and wait for the port.
if ((Get-Service $ServiceName).Status -ne "Running") {
    Start-Service $ServiceName
}
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if ((Test-NetConnection 127.0.0.1 -Port 27017 -InformationLevel Quiet -WarningAction SilentlyContinue)) {
        Write-Host "MongoDB is running on 127.0.0.1:27017" -ForegroundColor Green
        Start-Sleep -Seconds 2
        exit 0
    }
    Start-Sleep -Seconds 1
}
Write-Host "MongoDB did not come up. See C:\Program Files\MongoDB\Server\*\log\mongod.log" -ForegroundColor Red
Read-Host "Press Enter to close"
exit 1
