@echo off
rem Runs Kiln as administrator so XMRig can apply the MSR tweak and enable huge pages.
net session >nul 2>&1
if errorlevel 1 (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
title Kiln miner dashboard (administrator)
cd /d "%~dp0"
node app\server.js --open
pause
