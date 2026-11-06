@echo off
rem Kiln in the terminal. For the MSR tweak and huge pages, right-click > Run as administrator.
title Kiln miner
cd /d "%~dp0"
node app\tui.js %*
if errorlevel 1 pause
