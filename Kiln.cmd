@echo off
title Kiln miner dashboard
cd /d "%~dp0"
node app\server.js --open
pause
