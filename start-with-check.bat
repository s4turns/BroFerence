@echo off
REM Start all WebRTC services with Docker readiness check

echo Checking Docker status...
echo.

REM Check if Docker Desktop is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo Docker Desktop is not running.
    echo.
    echo Please start Docker Desktop and wait for it to fully initialize.
    echo Press any key once Docker Desktop shows a green icon in the system tray...
    pause >nul

    REM Check again
    docker info >nul 2>&1
    if %errorlevel% neq 0 (
        echo.
        echo Docker still not ready. Please ensure Docker Desktop is running.
        echo.
        pause
        exit /b 1
    )
)

echo Docker is ready!
echo.
echo Starting WebRTC Services...
echo.

docker compose up -d

if %errorlevel% equ 0 (
    echo.
    echo ================================================
    echo  All services started successfully!
    echo ================================================
    echo.
    echo  Web Client:      http://localhost:8080
    echo  Signaling:       ws://localhost:8765
    echo  TURN Server:     turn:localhost:3478
    echo.
    echo ================================================
    echo.
    echo Useful commands:
    echo   View logs:       docker compose logs -f
    echo   Stop services:   docker compose down
    echo   Restart:         docker compose restart
    echo.
) else (
    echo.
    echo Failed to start services.
    echo Please check Docker Desktop is running properly.
    echo.
)

pause
