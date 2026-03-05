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

# ── Check Node.js ─────────────────────────────────────────────────────────────
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  [ERROR] Node.js is not installed or not on PATH." -ForegroundColor Red
    Write-Host "          Download it from https://nodejs.org  (LTS, version 18 or later)" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

$nodeVersion = (node --version 2>$null) -replace 'v', ''
$nodeMajor   = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 18) {
    Write-Host ""
    Write-Host "  [ERROR] Node.js 18 or later is required. Found: v$nodeVersion" -ForegroundColor Red
    Write-Host "          Download it from https://nodejs.org" -ForegroundColor Yellow
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
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
