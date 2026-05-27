#!/bin/bash
# Configure iptables for BroFerence
# Run as root: bash setup-iptables.sh
#
# Environment variable overrides (all optional):
#   SSH_PORT   - SSH port to allow (default: 22)
#   TURN2_IP   - Second TURN VPS IP to whitelist (default: none)
#   WS_PORT    - WebSocket signaling port (default: 8765)
#   TURN_PORT  - TURN port (default: 3479)
#   RELAY_MIN  - TURN relay port range start (default: 49152)
#   RELAY_MAX  - TURN relay port range end (default: 65535)

set -e

# --- Config ---
SSH_PORT="${SSH_PORT:-22}"
WS_PORT="${WS_PORT:-8765}"
TURN_PORT="${TURN_PORT:-3479}"
RELAY_MIN="${RELAY_MIN:-49152}"
RELAY_MAX="${RELAY_MAX:-65535}"
TURN2_IP="${TURN2_IP:-}"

echo "=== iptables setup ==="
echo "  SSH_PORT  : $SSH_PORT"
echo "  WS_PORT   : $WS_PORT"
echo "  TURN_PORT : $TURN_PORT"
echo "  RELAY     : $RELAY_MIN-$RELAY_MAX (UDP)"
echo "  TURN2_IP  : ${TURN2_IP:-none}"
echo ""

# --- Install iptables-persistent ---
echo "[1/3] Installing iptables-persistent..."
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent

# --- INPUT chain ---
echo "[2/3] Configuring INPUT chain (policy: DROP)..."
iptables -F INPUT
iptables -P INPUT DROP

# Loopback and established
iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# SSH (rate-limited: max 4 new connections/min per IP)
iptables -A INPUT -p tcp --dport "$SSH_PORT" -m conntrack --ctstate NEW \
  -m limit --limit 4/min --limit-burst 8 -j ACCEPT

# Web (nginx — Docker exposes these, but allow at host level too)
iptables -A INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -m conntrack --ctstate NEW -j ACCEPT

# WebSocket signaling
iptables -A INPUT -p tcp --dport "$WS_PORT" -m conntrack --ctstate NEW -j ACCEPT

# TURN (runs in host network mode — goes through INPUT)
iptables -A INPUT -p tcp --dport "$TURN_PORT" -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p udp --dport "$TURN_PORT" -j ACCEPT

# TURN relay ports
iptables -A INPUT -p udp --dport "$RELAY_MIN:$RELAY_MAX" -j ACCEPT

# Whitelist second TURN VPS if provided
if [ -n "$TURN2_IP" ]; then
    iptables -A INPUT -s "$TURN2_IP" -j ACCEPT
    echo "  Whitelisted TURN2_IP: $TURN2_IP"
fi

# Drop invalid packets
iptables -A INPUT -m conntrack --ctstate INVALID -j DROP

# --- DOCKER-USER chain ---
echo "[3/3] Configuring DOCKER-USER chain (WebSocket rate limiting)..."
iptables -F DOCKER-USER
iptables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DOCKER-USER -p tcp --dport "$WS_PORT" -m conntrack --ctstate NEW -m hashlimit \
  --hashlimit-name ws-limit --hashlimit-above 20/min --hashlimit-burst 30 \
  --hashlimit-mode srcip -j DROP
iptables -A DOCKER-USER -j RETURN

# --- Save ---
netfilter-persistent save

echo ""
echo "=== INPUT rules ==="
iptables -L INPUT -n --line-numbers
echo ""
echo "=== DOCKER-USER rules ==="
iptables -L DOCKER-USER -n --line-numbers
