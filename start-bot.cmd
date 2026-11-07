@echo off
title OpenCode Remote (Discord)
cd /d "%~dp0"
echo ============================================
echo   OpenCode Remote - Discord bridge
echo   Thu muc: %CD%
echo   De DUNG: bam Ctrl+C hoac dong cua so nay
echo ============================================
echo.
node src/index.js
echo.
echo [Bot da dung] Nhan phim bat ky de dong cua so.
pause >nul
