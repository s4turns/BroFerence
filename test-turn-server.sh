#!/bin/bash
# Test TURN server connectivity
# Run from inside the repo directory: bash test-turn-server.sh

# Auto-detect hostname
HOSTNAME="${HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
TURN_PORT="${TURN_PORT:-3479}"

# Read TURN password from production config
TURN_PASS=$(grep "^user=" config/turnserver.production.conf 2>/dev/null | cut -d: -f2)
TURN_PASS="${TURN_PASS:-webrtc123}"

echo "========================================="
echo "TURN Server Diagnostic"
echo "========================================="
echo "  Host      : $HOSTNAME"
echo "  TURN port : $TURN_PORT"
echo ""

# Check if Docker containers are running
echo "[1/4] Checking Docker containers..."
docker compose ps

echo ""
echo "[2/4] Checking TURN server logs..."
docker compose logs --tail=20 turn

echo ""
echo "[3/4] Checking if TURN ports are listening..."
echo "Port $TURN_PORT (TURN):"
ss -tulpn | grep "$TURN_PORT" || echo "  Port $TURN_PORT not listening!"

echo ""
echo "Relay ports (sample):"
ss -tulpn | grep -E "491[5-9][0-9]|4920[0]" | head -5 || echo "  No relay ports listening yet (normal if no active sessions)"

echo ""
echo "[4/4] TURN connection info..."
echo "Test at: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "  STUN/TURN URI : turn:${HOSTNAME}:${TURN_PORT}"
echo "  Username      : webrtc"
echo "  Password      : ${TURN_PASS}"

echo ""
echo "========================================="
echo "Next Steps:"
echo "========================================="
echo "1. Make sure TURN container is running"
echo "2. Firewall allows: $TURN_PORT (TCP/UDP) and 49152-65535 (UDP)"
echo "3. Test TURN connectivity with the URL above"
echo ""
