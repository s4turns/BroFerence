#!/bin/bash
# Script to update VPS with latest code and restart services

echo "========================================="
echo "Updating WebRTC Server on VPS"
echo "========================================="
echo ""

# Reset files that get modified by this script (passwords are regenerated anyway)
echo "[1/4] Pulling latest code from GitHub..."
git checkout -- config/turnserver.production.conf client/conference.js 2>/dev/null

# Reset this script itself and restore execute permission
git checkout -- update-vps.sh 2>/dev/null
chmod +x update-vps.sh

git pull origin main
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to pull from GitHub"
    echo "Make sure you're in the repo directory and have no uncommitted changes"
    exit 1
fi

# Generate random TURN password and detect external IP
echo ""
echo "[2/4] Configuring TURN server..."

TURN_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "New TURN password generated (32 chars)"

EXTERNAL_IP=$(curl -4 -s ifconfig.me)
echo "Detected external IP: ${EXTERNAL_IP}"

# Update turnserver.production.conf - password
sed -i "s/^user=webrtc:.*/user=webrtc:${TURN_PASSWORD}/" config/turnserver.production.conf

# Update turnserver.production.conf - external IP (add or update)
if grep -q "^external-ip=" config/turnserver.production.conf; then
    sed -i "s/^external-ip=.*/external-ip=${EXTERNAL_IP}/" config/turnserver.production.conf
else
    # Add external-ip after listening-ip line
    sed -i "/^listening-ip=/a external-ip=${EXTERNAL_IP}" config/turnserver.production.conf
fi
echo "Updated config/turnserver.production.conf"

# Update conference.js
sed -i "s/credential: '[^']*'/credential: '${TURN_PASSWORD}'/" client/conference.js
echo "Updated client/conference.js"

# Rebuild and restart Docker containers
echo ""
echo "[3/4] Rebuilding Docker containers with latest code..."
docker compose down
docker compose build --no-cache
docker compose up -d

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to start Docker containers"
    echo "Check logs with: docker compose logs"
    exit 1
fi

# Show container status
echo ""
echo "[4/4] Checking container status..."
docker compose ps

# Get system hostname
HOSTNAME=$(hostname -f 2>/dev/null || hostname)

echo ""
echo "========================================="
echo "Update Complete!"
echo "========================================="
echo ""
echo "Services should be running at:"
echo "  - Web:       https://${HOSTNAME}"
echo "  - WebSocket: wss://${HOSTNAME}:8765"
echo "  - TURN:      ${HOSTNAME}:3479"
echo ""
echo "External IP: ${EXTERNAL_IP}"
echo "Check logs with: docker compose logs -f signaling"
echo ""
