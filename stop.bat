@echo off
REM Stop all WebRTC services (Windows)

echo Stopping WebRTC Services...
echo.

docker compose down

echo.
echo All services stopped!
echo.
pause
