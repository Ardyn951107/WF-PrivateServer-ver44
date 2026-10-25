@echo off
cd /d "%~dp0"
title SpaceNinjaServer (held)
node serve-held.mjs
echo.
echo Stopped.
pause
