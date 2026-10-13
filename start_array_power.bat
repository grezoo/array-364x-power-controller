@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
title Array 364X / 3645A Programmable DC Power Supply Controller (Node-RED)

echo ====================================================================
echo   ARRAY 364X / 3645A Programmable DC Power Supply Controller
echo   Engineered by @grezoo
echo ====================================================================

for %%I in ("%~dp0.") do set "SANDBOX_DIR=%%~fI"

set "PORTABLE_DIR=D:\programok_kiírni\IO-LINK\NODERED"
set "NODE_EXE=%PORTABLE_DIR%\node.exe"
set "NODE_RED_JS=%PORTABLE_DIR%\node_modules\node-red\red.js"

if not exist "%NODE_EXE%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set "NODE_EXE=%%i"
)

echo [1/3] Checking and releasing port 1880 if occupied...
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 1880 -State Listen -ErrorAction SilentlyContinue; if ($conns) { foreach ($c in $conns) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } }"

if not exist "%SANDBOX_DIR%\logs" mkdir "%SANDBOX_DIR%\logs"

echo [2/3] Launching default web browser (http://localhost:1880/ui)...
start "" /b cmd /c "ping 127.0.0.1 -n 4 >nul & start """" ""http://localhost:1880/ui"""

echo [3/3] Starting Node-RED Instrument Server...
echo       Working Directory (userDir): %SANDBOX_DIR%
echo       Instrument Dashboard:        http://localhost:1880/ui
echo       Node-RED Flow Editor:        http://localhost:1880
echo.

"%NODE_EXE%" "%NODE_RED_JS%" --userDir "%SANDBOX_DIR%" --settings "%SANDBOX_DIR%\settings.js" --port 1880

pause
