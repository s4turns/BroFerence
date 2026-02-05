#!/bin/bash
# Script to configure TURN server with your public IP or hostname

echo "========================================="
echo "TURN Server IP Configuration"
echo "========================================="
echo ""

# Check for hostname argument
if [ -n "$1" ]; then
    PUBLIC_IP="$1"
    echo "Using provided hostname/IP: $PUBLIC_IP"
else
    # Detect public IP
    echo "Detecting your public IP address..."
    PUBLIC_IP=$(curl -4 -s ifconfig.me)

    if [ -z "$PUBLIC_IP" ]; then
        echo "ERROR: Could not detect public IP"
        echo "Usage: $0 [hostname]"
        echo "Example: $0 ts.interdo.me"
        exit 1
    fi

    echo "Detected public IP: $PUBLIC_IP"
fi
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
# Replace any existing external-ip line
sed -i "s/^external-ip=.*/external-ip=$PUBLIC_IP/" "$CONFIG_FILE"
sed -i "s/^# external-ip=.*/external-ip=$PUBLIC_IP/" "$CONFIG_FILE"

# Make sure relay-ip is commented out or removed
sed -i "s/^relay-ip=127.0.0.1/# relay-ip=127.0.0.1/" "$CONFIG_FILE"
sed -i "s/^relay-ip=0.0.0.0/# relay-ip=0.0.0.0/" "$CONFIG_FILE"

# Replace placeholder
sed -i "s/YOUR_PUBLIC_IP_HERE/$PUBLIC_IP/" "$CONFIG_FILE"

# If external-ip still doesn't exist, add it after the external-ip comment
if ! grep -q "^external-ip=" "$CONFIG_FILE"; then
    sed -i "/^# external-ip=/a external-ip=$PUBLIC_IP" "$CONFIG_FILE"
fi

echo ""
echo "========================================="
echo "Configuration Updated!"
echo "========================================="
echo ""
echo "External IP/Hostname set to: $PUBLIC_IP"
echo "Backup saved to: $CONFIG_FILE.backup"
echo ""
echo "Next steps:"
echo "1. Verify firewall allows ports:"
echo "   - 3479 (TCP/UDP) - TURN server"
echo "   - 49152-49200 (UDP) - Media relay"
echo ""
echo "2. Restart TURN server:"
echo "   docker compose restart turn"
echo ""
echo "3. Test TURN connectivity:"
echo "   Visit: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/"
echo "   Use: turn:$PUBLIC_IP:3479"
echo "   Username: webrtc"
echo "   Password: webrtc123"
echo ""
