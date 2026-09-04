@echo off
REM Run from the repo root regardless of where this script is invoked from.
cd /d "%~dp0.."
REM Stop all WebRTC services (Windows)

echo Stopping WebRTC Services...
echo.

docker compose down

echo.
echo All services stopped!
echo.
pause
