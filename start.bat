@echo off
REM Start all WebRTC services with one command (Windows)

echo Starting WebRTC Services...
echo.

REM Check if Docker is installed
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker not found. Please install Docker Desktop for Windows.
    echo Download from: https://docs.docker.com/desktop/install/windows-install/
    pause
    exit /b 1
)

echo Docker found. Starting services with Docker Compose...
echo.

REM Start services
docker compose up -d

if %errorlevel% equ 0 (
    echo.
    echo All services started successfully!
    echo.
    echo Service URLs:
    echo    Web Client:      http://localhost:8080
    echo    Signaling:       ws://localhost:8765
    echo    TURN Server:     turn:localhost:3478
    echo.
    echo View logs:      docker compose logs -f
    echo Stop services:  docker compose down
    echo.
) else (
    echo.
    echo Failed to start services. Check Docker Desktop is running.
    echo.
)

pause
