#!/bin/bash
# Script to update VPS with latest code and restart services

echo "========================================="
echo "Updating WebRTC Server on VPS"
echo "========================================="
echo ""

# Stash any local changes before pulling
echo "[1/5] Pulling latest code from GitHub..."
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
echo "[2/5] Configuring TURN server..."

TURN_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
echo "New TURN password generated (32 chars)"

EXTERNAL_IP=$(curl -4 -s ifconfig.me)
echo "Detected external IP: ${EXTERNAL_IP}"

# Update turnserver.production.conf - password
sed -i "s/^user=webrtc:.*/user=webrtc:${TURN_PASSWORD}/" config/turnserver.production.conf

# No external-ip: the VPS owns its public IP directly on the NIC (no NAT).
# Setting external-ip anyway makes coturn remap peer addresses matching the
# public IP before the allowed-peer-ip check, 403'ing same-server relay
# paths (outage 2026-07-17 when turn2 went down and primary<->primary was
# the only path left). Strip any leftover line from older deploys.
sed -i "/^external-ip=/d" config/turnserver.production.conf

# Allowed relay peers: own IP (hairpin relay) AND the secondary TURN server,
# so relay paths that cross between the two TURN servers aren't 403'd.
# Client is relay-only with no P2P fallback — blocking cross-TURN pairs
# breaks media whenever two users land on different TURN servers.
TURN2_IP=174.138.183.167
sed -i "/^allowed-peer-ip=/d" config/turnserver.production.conf
sed -i "/^listening-ip=/a allowed-peer-ip=${EXTERNAL_IP}\nallowed-peer-ip=${TURN2_IP}" config/turnserver.production.conf
echo "Updated config/turnserver.production.conf"

# Update primary TURN credential in conference.js
sed -i "s/const PRIMARY_TURN_CREDENTIAL = '[^']*'/const PRIMARY_TURN_CREDENTIAL = '${TURN_PASSWORD}'/" client/conference.js
echo "Updated client/conference.js (primary TURN credential)"

# Update secondary TURN credential (second VPS) from .env — not rotated here since
# that coturn lives on another host. Keeps the secret out of git.
[ -f .env ] && set -a && . ./.env && set +a
if [ -n "${TURN2_PASSWORD}" ]; then
    sed -i "s/const SECONDARY_TURN_CREDENTIAL = '[^']*'/const SECONDARY_TURN_CREDENTIAL = '${TURN2_PASSWORD}'/" client/conference.js
    echo "Updated client/conference.js (secondary TURN credential)"
else
    echo "WARNING: TURN2_PASSWORD not set in .env — secondary TURN credential left as placeholder (turn2 relay will fail)"
fi

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

# Warn anyone in a call before pulling the floor out. SIGUSR1 makes the signaling
# server broadcast a countdown to every connected client; we then wait out the same
# grace period before stopping anything. RESTART_GRACE_SECONDS comes from .env
# (sourced above) and must match the server's default of 60 if left unset.
GRACE="${RESTART_GRACE_SECONDS:-60}"
echo ""
echo "[3/5] Warning connected users (${GRACE}s grace period)..."
if docker compose kill -s SIGUSR1 signaling 2>/dev/null; then
    echo "Warning sent — waiting ${GRACE}s before restarting"
    sleep "${GRACE}"
else
    echo "WARNING: could not signal the signaling container (not running?) — restarting without notice"
fi

# Rebuild and restart Docker containers
echo ""
echo "[4/5] Rebuilding Docker containers with latest code..."
docker compose down
docker compose build
docker compose up -d

if [ $? -ne 0 ]; then
    echo "ERROR: Failed to start Docker containers"
    echo "Check logs with: docker compose logs"
    exit 1
fi

# Propagate the rotated primary TURN credential to the dev environment (which
# shares this coturn) and redeploy it in lockstep, so dev never drifts out of
# sync. Skipped cleanly if the dev repo/.env isn't present or isn't writable.
DEV_DIR="${BROFERENCE_DEV_DIR:-/home/interdome/BroFerence-dev}"
if [ -f "$DEV_DIR/.env" ] && [ -w "$DEV_DIR/.env" ]; then
    echo ""
    echo "Syncing dev environment (${DEV_DIR})..."
    if grep -q '^PRIMARY_PASSWORD=' "$DEV_DIR/.env"; then
        sed -i "s/^PRIMARY_PASSWORD=.*/PRIMARY_PASSWORD=${TURN_PASSWORD}/" "$DEV_DIR/.env"
    else
        echo "PRIMARY_PASSWORD=${TURN_PASSWORD}" >> "$DEV_DIR/.env"
    fi
    if [ -f "$DEV_DIR/update-dev.sh" ]; then
        ( cd "$DEV_DIR" && bash update-dev.sh ) || echo "WARNING: dev redeploy failed (prod is unaffected)"
    fi
fi

# Show container status
echo ""
echo "[5/5] Checking container status..."
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
