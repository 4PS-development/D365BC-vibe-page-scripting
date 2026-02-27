@echo off
title BC Page Scripting

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Node.js is not installed or not on PATH.
    echo         Download it from https://nodejs.org  (LTS, version 18 or later^)
    echo.
    pause
    exit /b 1
)

:: Install app dependencies if needed
if not exist "%~dp0app\node_modules" (
    echo Installing app dependencies...
    npm install --prefix "%~dp0app" --silent
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
)

echo.
echo  Starting BC Page Scripting...
echo  The app will open in your browser automatically.
echo  Press Ctrl+C to stop.
echo.

node "%~dp0app\server.js"
