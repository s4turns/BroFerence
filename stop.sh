#!/bin/bash
# Stop all WebRTC services

echo "🛑 Stopping WebRTC Services..."

docker compose down

echo "✅ All services stopped!"
