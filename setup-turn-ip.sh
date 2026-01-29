#!/bin/bash
# Script to configure TURN server with your public IP

echo "========================================="
echo "TURN Server IP Configuration"
echo "========================================="
echo ""

# Detect public IP
echo "Detecting your public IP address..."
PUBLIC_IP=$(curl -4 -s ifconfig.me)

if [ -z "$PUBLIC_IP" ]; then
    echo "ERROR: Could not detect public IP"
    echo "Please set it manually in config/turnserver.conf"
    exit 1
fi

echo "Detected public IP: $PUBLIC_IP"
echo ""

# Update turnserver.conf
CONFIG_FILE="config/turnserver.conf"

if [ ! -f "$CONFIG_FILE" ]; then
    echo "ERROR: $CONFIG_FILE not found"
    exit 1
fi

echo "Updating $CONFIG_FILE..."

# Backup original
cp "$CONFIG_FILE" "$CONFIG_FILE.backup"

# Update the configuration
sed -i "s/^external-ip=.*/external-ip=$PUBLIC_IP/" "$CONFIG_FILE"
sed -i "s/^# external-ip=.*/external-ip=$PUBLIC_IP/" "$CONFIG_FILE"
sed -i "s/^relay-ip=127.0.0.1/# relay-ip=127.0.0.1/" "$CONFIG_FILE"

# If external-ip doesn't exist, add it
if ! grep -q "^external-ip=" "$CONFIG_FILE"; then
    sed -i "/^# External IP/a external-ip=$PUBLIC_IP" "$CONFIG_FILE"
fi

echo ""
echo "========================================="
echo "Configuration Updated!"
echo "========================================="
echo ""
echo "External IP set to: $PUBLIC_IP"
echo "Backup saved to: $CONFIG_FILE.backup"
echo ""
echo "Next steps:"
echo "1. Verify firewall allows ports:"
echo "   - 3479 (TCP/UDP) - TURN server"
echo "   - 49152-49200 (UDP) - Media relay"
echo ""
echo "2. Restart TURN server:"
echo "   docker-compose restart turn"
echo ""
echo "3. Test TURN connectivity:"
echo "   Visit: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "   Use: turn:ts.interdo.me:3479"
echo "   Username: webrtc"
echo "   Password: webrtc123"
echo ""
