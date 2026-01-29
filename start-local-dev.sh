#!/bin/bash

echo "========================================"
echo "Starting Local Development Environment"
echo "========================================"
echo ""

# Check if Python is installed
if ! command -v python3 &> /dev/null; then
    echo "ERROR: Python 3 is not installed"
    echo "Please install Python 3.7+ from your package manager"
    exit 1
fi

echo "[1/3] Installing Python dependencies..."
cd server
pip3 install websockets > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "WARNING: Could not install dependencies. Trying anyway..."
fi

echo "[2/3] Starting signaling server on ws://localhost:8765..."
python3 signaling_server_local.py &
SIGNALING_PID=$!

echo "[3/3] Starting web server on http://localhost:8080..."
cd ../client
python3 -m http.server 8080 &
WEB_PID=$!

echo ""
echo "========================================"
echo "Local Development Environment Started!"
echo "========================================"
echo ""
echo "Signaling Server: ws://localhost:8765"
echo "Web Client:       http://localhost:8080/app.html"
echo ""
echo "Opening browser..."
sleep 2

# Try to open browser (different commands for different systems)
if command -v xdg-open &> /dev/null; then
    xdg-open http://localhost:8080/app.html
elif command -v open &> /dev/null; then
    open http://localhost:8080/app.html
else
    echo "Could not open browser automatically. Please visit:"
    echo "http://localhost:8080/app.html"
fi

echo ""
echo "Press Ctrl+C to stop all servers"
echo ""

# Wait for Ctrl+C
trap "kill $SIGNALING_PID $WEB_PID 2>/dev/null; exit" SIGINT SIGTERM
wait
