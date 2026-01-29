#!/bin/bash
# Stop all WebRTC services

echo "🛑 Stopping WebRTC Services..."

if docker compose version &> /dev/null; then
    docker compose down
else
    docker-compose down
fi

echo "✅ All services stopped!"
