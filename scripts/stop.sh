#!/bin/bash
# Run from the repo root regardless of where this script is invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
# Stop all WebRTC services

echo "🛑 Stopping WebRTC Services..."

docker compose down

echo "✅ All services stopped!"
