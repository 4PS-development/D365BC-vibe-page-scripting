@echo off
title BC Page Scripting

:: ── Check / install Node.js ────────────────────────────────────────────────────────
where node >nul 2>nul
if not errorlevel 1 goto check_pwsh

echo  [INFO] Node.js not found. Attempting to install via winget...
call :ensure_winget
if errorlevel 1 (
    echo [ERROR] Cannot auto-install Node.js. Install it manually: https://nodejs.org
    pause & exit /b 1
)
winget install --id OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo [ERROR] Node.js installation failed. Install it manually: https://nodejs.org
    pause & exit /b 1
)
echo  Node.js installed. Please restart this window and run start.bat again.
pause & exit /b 0

:: ── Check / install PowerShell 7 ───────────────────────────────────────────────────
:check_pwsh
where pwsh >nul 2>nul
if not errorlevel 1 goto install_deps

echo  [INFO] PowerShell 7 (pwsh) not found.
call :ensure_winget
if errorlevel 1 (
    echo [ERROR] Cannot auto-install PowerShell 7. Install it manually: https://aka.ms/powershell
    pause & exit /b 1
)
winget install --id Microsoft.PowerShell --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 (
    echo [ERROR] PowerShell 7 installation failed. Install it manually: https://aka.ms/powershell
    pause & exit /b 1
)
echo  PowerShell 7 installed. Please restart this window and run start.bat again.
pause & exit /b 0

:: ── Install dependencies ────────────────────────────────────────────────────────────
:install_deps
if not exist "%~dp0app\node_modules" (
    echo Installing app dependencies...
    npm install --prefix "%~dp0app" --silent
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

if not exist "%~dp0bc-replay\node_modules" (
    echo Installing bc-replay dependencies...
    npm install --prefix "%~dp0bc-replay" --silent
    if errorlevel 1 (
        echo [ERROR] npm install failed in bc-replay.
        pause
        exit /b 1
    )
)

if not exist "%LOCALAPPDATA%\ms-playwright" (
    echo Installing Playwright Chromium browser...
    cd /d "%~dp0bc-replay"
    npx playwright install chromium
    cd /d "%~dp0"
)

echo.
echo  Starting BC Page Scripting...
echo  The app will open in your browser automatically.
echo  Press Ctrl+C to stop.
echo.

:: ── Kill any existing process on port 3333 ───────────────────────────────────
pwsh -NoProfile -Command "Get-NetTCPConnection -LocalPort 3333 -State Listen -EA SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Write-Host \"  [INFO] Stopping existing server on port 3333 (PID $_)...\"; Stop-Process -Id $_ -Force -EA SilentlyContinue }"

node "%~dp0app\server.js"
if errorlevel 1 (
    echo.
    echo [ERROR] Server failed to start. See error above.
    pause
)
goto :eof

:: ── Subroutine: ensure winget ─────────────────────────────────────────────────────────
:ensure_winget
where winget >nul 2>nul
if not errorlevel 1 exit /b 0
echo  [INFO] winget not found - attempting to install it via PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "try{Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -EA Stop}catch{};" ^
    "if(-not(Get-Command winget -EA SilentlyContinue)){" ^
    "  try{" ^
    "    $r=Invoke-RestMethod 'https://api.github.com/repos/microsoft/winget-cli/releases/latest';" ^
    "    $a=$r.assets|?{$_.name -like '*.msixbundle'}|select -First 1;" ^
    "    $t=Join-Path $env:TEMP 'winget-installer.msixbundle';" ^
    "    Invoke-WebRequest -Uri $a.browser_download_url -OutFile $t -UseBasicParsing;" ^
    "    Add-AppxPackage -Path $t -EA Stop;" ^
    "    Remove-Item $t -Force -EA SilentlyContinue" ^
    "  }catch{Write-Host \"  [WARN] $_\" -ForegroundColor Yellow}" ^
    "}"
where winget >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0
