<#
  One command to run the whole project:
    powershell -ExecutionPolicy Bypass -File start.ps1

  1. makes sure MongoDB is up (starts the service; asks for admin only if needed)
  2. starts the FastAPI backend   -> http://127.0.0.1:8000
  3. starts the Next.js frontend  -> http://localhost:3000
  4. opens the browser once the frontend answers
#>

$ErrorActionPreference = "Stop"
$Root = $PSScriptRoot

function Test-Port($port) {
    Test-NetConnection 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue
}

# ---- MongoDB
if (-not (Test-Port 27017)) {
    Write-Host "MongoDB is not running; starting it..."
    try { Start-Service MongoDB -ErrorAction Stop } catch {
        & (Join-Path $Root "scripts\start-mongodb.ps1")
    }
    $deadline = (Get-Date).AddSeconds(20)
    while (-not (Test-Port 27017) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
}
if (Test-Port 27017) {
    Write-Host "MongoDB  ok   127.0.0.1:27017" -ForegroundColor Green
} else {
    Write-Host "MongoDB is still down. Run scripts\start-mongodb.ps1 and check its output." -ForegroundColor Red
    exit 1
}

# ---- Backend
$python = Join-Path $Root ".venv\Scripts\python.exe"
if (-not (Test-Path $python)) { $python = "python" }
if (Test-Port 8000) {
    Write-Host "Backend  ok   already running on :8000" -ForegroundColor Green
} else {
    Start-Process powershell.exe -WorkingDirectory $Root -ArgumentList @(
        "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Queryable backend'; & '$python' -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000")
    Write-Host "Backend  starting on http://127.0.0.1:8000"
}

# ---- Frontend
$web = Join-Path $Root "openui_test"
if (Test-Port 3000) {
    Write-Host "Frontend ok   already running on :3000" -ForegroundColor Green
} else {
    if (-not (Test-Path (Join-Path $web "node_modules"))) {
        Write-Host "Installing frontend packages (first run only)..."
        Push-Location $web; npm install; Pop-Location
    }
    Start-Process powershell.exe -WorkingDirectory $web -ArgumentList @(
        "-NoExit", "-Command", "`$host.UI.RawUI.WindowTitle='Queryable frontend'; npm run dev")
    Write-Host "Frontend starting on http://localhost:3000"
}

$deadline = (Get-Date).AddSeconds(90)
while (-not ((Test-Port 3000) -and (Test-Port 8000)) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
Start-Process "http://localhost:3000"
