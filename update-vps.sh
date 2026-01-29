#!/bin/bash
# Script to update VPS with latest code and restart services

echo "========================================="
echo "Updating WebRTC Server on VPS"
echo "========================================="
echo ""

# Pull latest code
echo "[1/3] Pulling latest code from GitHub..."
git pull origin main
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to pull from GitHub"
    echo "Make sure you're in the repo directory and have no uncommitted changes"
    exit 1
fi

# Rebuild and restart Docker containers
echo ""
echo "[2/3] Rebuilding Docker containers with latest code..."
docker-compose down
docker-compose build --no-cache
docker-compose up -d

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to start Docker containers"
    echo "Check docker-compose.yml and logs"
    exit 1
fi

# Show container status
echo ""
echo "[3/3] Checking container status..."
docker-compose ps

echo ""
echo "========================================="
echo "Update Complete!"
echo "========================================="
echo ""
echo "Services should be running at:"
echo "  - Web:      https://ts.interdo.me"
echo "  - WebSocket: wss://ts.interdo.me:8765"
echo ""
echo "Check logs with: docker-compose logs -f signaling"
echo ""
