@echo off
title OwO Minewatch

echo.
echo  =============================================
echo   OwO Minewatch - Bot Launcher
echo  =============================================
echo.

set /p DASHBOARD="  Launch dashboard too? (Y/N): "

if /i "%DASHBOARD%"=="Y" (
    echo.
    echo  Starting dashboard on http://localhost:3000 ...
    echo  Both processes run independently - closing one won't affect the other.
    start "OwO Dashboard" cmd /k "node dashboard.js"
    timeout /t 1 /nobreak >nul
)

echo.
echo  Starting bot...
echo.
node index.js
