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

# ── Launch ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  Starting BC Page Scripting..." -ForegroundColor Cyan
Write-Host "  The app will open in your browser automatically." -ForegroundColor White
Write-Host "  Press Ctrl+C to stop." -ForegroundColor White
Write-Host ""

node (Join-Path $appDir 'server.js')
