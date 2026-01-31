#!/bin/bash
# Script to update VPS with latest code and restart services

echo "========================================="
echo "Updating WebRTC Server on VPS"
echo "========================================="
echo ""

# Reset files that get modified by this script (passwords are regenerated anyway)
echo "[1/4] Pulling latest code from GitHub..."
git checkout -- config/turnserver.production.conf client/conference.js update-vps.sh 2>/dev/null
git pull origin main
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to pull from GitHub"
    echo "Make sure you're in the repo directory and have no uncommitted changes"
    exit 1
fi

# Generate random TURN password
echo ""
echo "[2/4] Generating random TURN server credentials..."
TURN_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "New TURN password generated (32 chars)"

# Update turnserver.production.conf
sed -i "s/^user=webrtc:.*/user=webrtc:${TURN_PASSWORD}/" config/turnserver.production.conf
echo "Updated config/turnserver.production.conf"

# Update conference.js
sed -i "s/credential: '[^']*'/credential: '${TURN_PASSWORD}'/" client/conference.js
echo "Updated client/conference.js"

# Rebuild and restart Docker containers
echo ""
echo "[3/4] Rebuilding Docker containers with latest code..."
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
echo "[4/4] Checking container status..."
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
