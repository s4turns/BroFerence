#!/bin/bash
# Test TURN server connectivity

echo "========================================="
echo "TURN Server Diagnostic"
echo "========================================="
echo ""

# Check if Docker containers are running
echo "[1/4] Checking Docker containers..."
docker compose ps

echo ""
echo "[2/4] Checking TURN server logs..."
docker compose logs --tail=20 turn

echo ""
echo "[3/4] Checking if TURN ports are listening..."
echo "Port 3479 (TURN):"
sudo netstat -tulpn | grep 3479 || echo "  Port 3479 not listening!"

echo ""
echo "Relay ports (49152-49200):"
sudo netstat -tulpn | grep -E "491[5-9][0-9]|4920[0]" | head -5 || echo "  No relay ports listening!"

echo ""
echo "[4/4] Testing TURN server connectivity..."
echo "You can test TURN server at: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "Use these settings:"
echo "  STUN/TURN URI: turn:ts.interdo.me:3479"
echo "  Username: webrtc"
echo "  Password: webrtc123"

echo ""
echo "========================================="
echo "Next Steps:"
echo "========================================="
echo "1. Make sure TURN container is running"
echo "2. Check firewall allows ports 3479 and 49152-49200 (UDP)"
echo "3. Test TURN connectivity with the URL above"
echo ""
