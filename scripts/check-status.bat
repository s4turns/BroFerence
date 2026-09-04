@echo off
REM Run from the repo root regardless of where this script is invoked from.
cd /d "%~dp0.."
REM Check WebRTC services status

echo.
echo ================================================
echo   WebRTC Services Status Check
echo ================================================
echo.

REM Check if Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo [X] Docker Desktop is NOT running
    echo.
    echo Please start Docker Desktop first.
    echo.
    pause
    exit /b 1
)

echo [OK] Docker Desktop is running
echo.

REM Check service status
echo Checking container status...
echo.

docker compose ps

echo.
echo ================================================
echo   Service URLs
echo ================================================
echo   Web Client:      http://localhost:8080
echo   Signaling:       ws://localhost:8765
echo   TURN Server:     turn:localhost:3478
echo.
echo ================================================
echo.

REM Check if containers are running
docker compose ps | findstr "Up" >nul
if %errorlevel% equ 0 (
    echo [OK] All services are running!
) else (
    echo [!] Some services may not be running
    echo Run 'scripts\start.bat' to start services
)

echo.
echo Useful commands:
echo   View logs:       docker compose logs -f
echo   Restart:         docker compose restart
echo   Stop:            docker compose down
echo   Start:           scripts\start.bat
echo.

pause
