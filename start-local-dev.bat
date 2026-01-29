@echo off
echo ========================================
echo Starting Local Development Environment
echo ========================================
echo.

REM Check if Python is installed
python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python is not installed or not in PATH
    echo Please install Python 3.7+ from https://www.python.org/downloads/
    pause
    exit /b 1
)

echo [1/3] Installing Python dependencies...
cd server
pip install websockets >nul 2>&1
if errorlevel 1 (
    echo WARNING: Could not install dependencies. Trying anyway...
)

echo [2/3] Starting signaling server on ws://localhost:8765...
start "WebRTC Signaling Server" python signaling_server_local.py

echo [3/3] Starting web server on http://localhost:8080...
cd ..\client
start "WebRTC Web Client" python -m http.server 8080

echo.
echo ========================================
echo Local Development Environment Started!
echo ========================================
echo.
echo Signaling Server: ws://localhost:8765
echo Web Client:       http://localhost:8080/app.html
echo.
echo Press any key to open the web client in your browser...
pause >nul
start http://localhost:8080/app.html

echo.
echo Press Ctrl+C in the terminal windows to stop the servers
echo.
