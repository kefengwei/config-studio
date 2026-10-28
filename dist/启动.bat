@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo.
echo   Config Studio - starting local server ...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server\server.ps1" %*
set RC=%ERRORLEVEL%
if not "%RC%"=="0" (
  echo.
  echo   Startup failed with error code %RC%
  echo   Please send the message above to the developer.
  echo.
  pause
)
