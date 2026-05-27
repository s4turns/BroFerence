#!/bin/bash
# Script to update VPS with latest code and restart services

echo "========================================="
echo "Updating WebRTC Server on VPS"
echo "========================================="
echo ""

# Stash any local changes before pulling
echo "[1/4] Pulling latest code from GitHub..."
git stash --include-untracked 2>/dev/null

git pull origin main
if [ $? -ne 0 ]; then
    echo "ERROR: Failed to pull from GitHub"
    echo "Make sure you're in the repo directory and have no uncommitted changes"
    exit 1
fi

# Ensure update script stays executable after pull
chmod +x update-vps.sh

# Stamp static assets with git commit hash to bust browser cache
COMMIT_HASH=$(git rev-parse --short HEAD)
sed -i "s/?v=[^\"']*/?v=${COMMIT_HASH}/g" client/app.html
echo "Cache-busted assets with commit ${COMMIT_HASH}"

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
    sed -i "/^listening-ip=/a external-ip=${EXTERNAL_IP}" config/turnserver.production.conf
fi

# Update allowed-peer-ip to match external-ip (enables hairpin relay)
if grep -q "^allowed-peer-ip=" config/turnserver.production.conf; then
    sed -i "s/^allowed-peer-ip=.*/allowed-peer-ip=${EXTERNAL_IP}/" config/turnserver.production.conf
else
    sed -i "/^external-ip=/a allowed-peer-ip=${EXTERNAL_IP}" config/turnserver.production.conf
fi
echo "Updated config/turnserver.production.conf"

# Update primary TURN credential in conference.js (leave turn2Config untouched)
sed -i "s/const PRIMARY_TURN_CREDENTIAL = '[^']*'/const PRIMARY_TURN_CREDENTIAL = '${TURN_PASSWORD}'/" client/conference.js
echo "Updated client/conference.js"

# Sync fail2ban config if fail2ban is installed
if command -v fail2ban-client &>/dev/null; then
    echo "Syncing fail2ban config..."
    REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    sed "s|__REPO_DIR__|$REPO_DIR|g" fail2ban/jail.local > /etc/fail2ban/jail.local
    cp fail2ban/filter.d/coturn-auth.conf /etc/fail2ban/filter.d/coturn-auth.conf
    cp fail2ban/filter.d/nginx-req-limit.conf /etc/fail2ban/filter.d/nginx-req-limit.conf
    systemctl reload fail2ban 2>/dev/null || systemctl restart fail2ban
    echo "fail2ban config updated"
fi

# Ensure log dirs exist for fail2ban
mkdir -p logs/nginx logs/coturn

# Rebuild and restart Docker containers
echo ""
echo "[3/4] Rebuilding Docker containers with latest code..."
docker compose down
docker compose build
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
