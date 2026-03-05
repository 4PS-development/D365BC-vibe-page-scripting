#Requires -Version 5
<#
.SYNOPSIS
    Starts the BC Page Scripting local web application.
.DESCRIPTION
    Checks for Node.js, installs npm dependencies if needed, then launches
    the Express server. The app opens automatically in your default browser.
#>

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$appDir = Join-Path $root 'app'

# ── Helper: refresh PATH from registry (avoids needing to restart terminal) ──
function Refresh-EnvPath {
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
                [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

# ── Helper: install winget ───────────────────────────────────────────────────
function Install-Winget {
    Write-Host "  Attempting to install winget (Windows Package Manager)..." -ForegroundColor Cyan
    try {
        Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "  winget installed successfully." -ForegroundColor Green
            return $true
        }
    } catch { }
    try {
        Write-Host "  Downloading winget from GitHub releases..." -ForegroundColor Cyan
        $rel   = Invoke-RestMethod 'https://api.github.com/repos/microsoft/winget-cli/releases/latest'
        $asset = $rel.assets | Where-Object { $_.name -like '*.msixbundle' } | Select-Object -First 1
        if (-not $asset) { throw 'No .msixbundle found in latest winget release.' }
        $tmp = Join-Path $env:TEMP 'winget-installer.msixbundle'
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
        Add-AppxPackage -Path $tmp -ErrorAction Stop
        Remove-Item $tmp -Force -ErrorAction SilentlyContinue
        if (Get-Command winget -ErrorAction SilentlyContinue) {
            Write-Host "  winget installed successfully." -ForegroundColor Green
            return $true
        }
    } catch {
        Write-Host "  [WARN] $($_.Exception.Message)" -ForegroundColor Yellow
    }
    return $false
}

# ── Helper: ensure winget is available ───────────────────────────────────────
function Ensure-Winget {
    if (Get-Command winget -ErrorAction SilentlyContinue) { return $true }
    Write-Host ""
    Write-Host "  [INFO] winget not found - attempting to install it..." -ForegroundColor Yellow
    return Install-Winget
}

# ── Check / install Node.js ───────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  [INFO] Node.js not found. Attempting to install via winget..." -ForegroundColor Yellow
    if (-not (Ensure-Winget)) {
        Write-Host "  [ERROR] Cannot auto-install Node.js. Install it manually: https://nodejs.org" -ForegroundColor Red
        Read-Host "Press Enter to exit"; exit 1
    }
    winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Node.js installation failed. Install it manually: https://nodejs.org" -ForegroundColor Red
        Read-Host "Press Enter to exit"; exit 1
    }
    Refresh-EnvPath
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Host "  Node.js installed. Please restart this terminal and run start.ps1 again." -ForegroundColor Green
        Read-Host "Press Enter to exit"; exit 0
    }
    Write-Host "  Node.js installed successfully." -ForegroundColor Green
}

$nodeVersion = (node --version 2>$null) -replace 'v', ''
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Host ""
    Write-Host "  [INFO] Node.js 18+ required (found v$nodeVersion). Upgrading via winget..." -ForegroundColor Yellow
    if (-not (Ensure-Winget)) {
        Write-Host "  [ERROR] Cannot auto-upgrade Node.js. Install v18+ manually: https://nodejs.org" -ForegroundColor Red
        Read-Host "Press Enter to exit"; exit 1
    }
    winget upgrade --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Node.js upgrade failed. Install v18+ manually: https://nodejs.org" -ForegroundColor Red
        Read-Host "Press Enter to exit"; exit 1
    }
    Refresh-EnvPath
    $nodeVersion = (node --version 2>$null) -replace 'v', ''
    $nodeMajor   = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 18) {
        Write-Host "  Node.js upgraded. Please restart this terminal and run start.ps1 again." -ForegroundColor Green
        Read-Host "Press Enter to exit"; exit 0
    }
    Write-Host "  Node.js upgraded to v$nodeVersion." -ForegroundColor Green
}

# ── Check / install PowerShell 7 (pwsh) ─────────────────────────────────────
if (-not (Get-Command pwsh -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  [INFO] PowerShell 7 (pwsh) not found." -ForegroundColor Yellow
    if (-not (Ensure-Winget)) {
        Write-Host "  [ERROR] Could not install winget automatically." -ForegroundColor Red
        Write-Host "          Install PowerShell 7 manually: https://aka.ms/powershell" -ForegroundColor Yellow
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  Installing PowerShell 7 via winget..." -ForegroundColor Cyan
    winget install --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [ERROR] Installation failed. Install PowerShell 7 manually: https://aka.ms/powershell" -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    Write-Host "  PowerShell 7 installed. Please restart this terminal and run start.ps1 again." -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit 0
}
# ── Install app dependencies if needed ───────────────────────────────────────
$nodeModules = Join-Path $appDir 'node_modules'
if (-not (Test-Path $nodeModules)) {
    Write-Host ""
    Write-Host "  Installing app dependencies (first run only)..." -ForegroundColor Cyan
    Push-Location $appDir
    try {
        npm install --silent
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    } finally {
        Pop-Location
    }
    Write-Host "  Done." -ForegroundColor Green
}

# ── Install bc-replay dependencies if needed ─────────────────────────────────
$bcReplayDir  = Join-Path $root 'bc-replay'
$bcReplayMods = Join-Path $bcReplayDir 'node_modules'
if (-not (Test-Path $bcReplayMods)) {
    Write-Host ""
    Write-Host "  Installing bc-replay dependencies..." -ForegroundColor Cyan
    Push-Location $bcReplayDir
    try {
        npm install --silent
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in bc-replay" }
    } finally {
        Pop-Location
    }
    Write-Host "  Done." -ForegroundColor Green
}

# ── Install Playwright Chromium if needed ─────────────────────────────────────
$chromiumPaths = @(
    "$env:USERPROFILE\AppData\Local\ms-playwright",
    "$env:LOCALAPPDATA\ms-playwright"
)
$chromiumFound = $chromiumPaths | Where-Object { Test-Path $_ } |
    ForEach-Object { Get-ChildItem "$_\chromium*" -ErrorAction SilentlyContinue } |
    Select-Object -First 1

if (-not $chromiumFound) {
    Write-Host ""
    Write-Host "  Installing Playwright Chromium browser..." -ForegroundColor Cyan
    Push-Location $bcReplayDir
    try {
        npx playwright install chromium 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Playwright install failed" }
    } finally {
        Pop-Location
    }
    Write-Host "  Done." -ForegroundColor Green
}

# ── Launch ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Starting BC Page Scripting..." -ForegroundColor Cyan
Write-Host "  The app will open in your browser automatically." -ForegroundColor White
Write-Host "  Press Ctrl+C to stop." -ForegroundColor White
Write-Host ""

node (Join-Path $appDir 'server.js')
