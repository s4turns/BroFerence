#!/bin/bash
# Start all WebRTC services with one command

set -e

echo "🚀 Starting WebRTC Services..."

# Check if Docker is installed
if command -v docker &> /dev/null; then
    echo "✅ Docker found. Starting services..."

    docker compose up -d

    echo ""
    echo "✅ All services started!"
    echo ""
    echo "📋 Service URLs:"
    echo "   Web Client:      http://localhost:8080"
    echo "   Signaling:       ws://localhost:8765"
    echo "   TURN Server:     turn:localhost:3478"
    echo ""
    echo "📊 View logs:      docker compose logs -f"
    echo "🛑 Stop services:  docker compose down"
    echo ""

else
    echo "❌ Docker not found. Please install Docker and Docker Compose."
    echo ""
    echo "Installation guides:"
    echo "  - Windows: https://docs.docker.com/desktop/install/windows-install/"
    echo "  - Mac:     https://docs.docker.com/desktop/install/mac-install/"
    echo "  - Linux:   https://docs.docker.com/engine/install/"
    exit 1
fi
