#!/bin/bash
# Run from the repo root regardless of where this script is invoked from.
cd "$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
# Install WebRTC services on Linux (systemd)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Installing WebRTC Services...${NC}"
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

# Get the current directory
INSTALL_DIR=$(pwd)

echo -e "${YELLOW}Installation directory: $INSTALL_DIR${NC}"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
apt update
apt install -y python3 python3-pip coturn

# Install Python packages
pip3 install -r server/requirements.txt

# Create turnserver user if doesn't exist
if ! id "turnserver" &>/dev/null; then
    useradd -r -s /bin/false turnserver
fi

# Update service files with correct paths
echo "📝 Configuring service files..."
sed -i "s|/path/to/webrtc-server|$INSTALL_DIR|g" systemd/*.service

# Copy service files
echo "📋 Installing systemd services..."
cp systemd/webrtc-signaling.service /etc/systemd/system/
cp systemd/webrtc-web.service /etc/systemd/system/
cp systemd/coturn.service /etc/systemd/system/

# Reload systemd
systemctl daemon-reload

# Enable services
echo "✅ Enabling services..."
systemctl enable webrtc-signaling
systemctl enable webrtc-web
systemctl enable coturn

# Start services
echo "🚀 Starting services..."
systemctl start coturn
systemctl start webrtc-signaling
systemctl start webrtc-web

echo ""
echo -e "${GREEN}✅ Installation complete!${NC}"
echo ""
echo "Service status:"
systemctl status coturn --no-pager -l
systemctl status webrtc-signaling --no-pager -l
systemctl status webrtc-web --no-pager -l
echo ""
echo "Useful commands:"
echo "  Start all:    sudo systemctl start coturn webrtc-signaling webrtc-web"
echo "  Stop all:     sudo systemctl stop coturn webrtc-signaling webrtc-web"
echo "  Restart all:  sudo systemctl restart coturn webrtc-signaling webrtc-web"
echo "  View logs:    sudo journalctl -f -u webrtc-signaling"
echo ""
echo "Access your app at: http://localhost:8080"
