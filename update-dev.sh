#!/bin/bash
# Redeploy the BroFerence dev environment (web :443, signaling :8765).
#
# Dev is its own host, so it mirrors prod's ports — no port in the URL, and the
# client's default WebSocket port selection works without special-casing.
#
# Dev shares PROD's primary coturn (turn:<host>:3479), so the primary TURN
# credential is NOT generated here — it is read from .env PRIMARY_PASSWORD,
# which prod's update-vps.sh propagates on every prod deploy. The secondary
# (turn2) credential comes from .env TURN2_PASSWORD.
#
# Run as a user with Docker access and read/write to this repo (root in our
# setup, since prod's update-vps.sh invokes this in lockstep).
set -e
cd "$(dirname "$(readlink -f "$0")")"

DEV_BRANCH="${DEV_BRANCH:-testing}"

echo "[1/4] Updating dev code (branch: ${DEV_BRANCH})..."
git fetch origin -q
git reset --hard "origin/${DEV_BRANCH}"

echo "[2/4] Substituting TURN credentials from .env..."
[ -f .env ] && set -a && . ./.env && set +a
if [ -z "${PRIMARY_PASSWORD}" ]; then
    echo "ERROR: PRIMARY_PASSWORD not set in .env (propagated by prod update-vps.sh). Aborting."
    exit 1
fi
[ -n "${TURN2_PASSWORD}" ] || echo "WARNING: TURN2_PASSWORD not set in .env — turn2 relay will fail"
sed -i "s/const PRIMARY_TURN_CREDENTIAL = '[^']*'/const PRIMARY_TURN_CREDENTIAL = '${PRIMARY_PASSWORD}'/" client/conference.js
sed -i "s/const SECONDARY_TURN_CREDENTIAL = '[^']*'/const SECONDARY_TURN_CREDENTIAL = '${TURN2_PASSWORD}'/" client/conference.js
echo "  primary=${PRIMARY_PASSWORD:0:6}...  turn2=${TURN2_PASSWORD:0:6}..."

echo "[3/4] Cache-busting assets..."
COMMIT=$(git rev-parse --short HEAD)
sed -i "s/?v=[^\"']*/?v=${COMMIT}/g" client/app.html

echo "[4/4] Rebuilding dev containers..."
docker compose -f docker-compose.dev.yml build
# Clear any pre-compose standalone containers holding the names, then bring up clean.
docker rm -f broference-dev-web broference-dev-signaling 2>/dev/null || true
docker compose -f docker-compose.dev.yml up -d

echo ""
echo "Dev redeploy complete (commit ${COMMIT})."
docker compose -f docker-compose.dev.yml ps
