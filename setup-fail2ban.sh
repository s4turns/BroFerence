#!/bin/bash
# Install and configure fail2ban for BroFerence
# Run as root from inside the repo directory: bash setup-fail2ban.sh
#
# Environment variable overrides (all optional):
#   REPO_DIR   - path to repo (default: directory containing this script)
#   APP_USER   - unix user that owns/runs the app (default: auto-detected from REPO_DIR owner)

set -e

# --- Config ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${REPO_DIR:-$SCRIPT_DIR}"
APP_USER="${APP_USER:-$(stat -c '%U' "$REPO_DIR" 2>/dev/null || echo "$(ls -ld "$REPO_DIR" | awk '{print $3}')")}"

echo "=== fail2ban setup ==="
echo "  REPO_DIR : $REPO_DIR"
echo "  APP_USER : $APP_USER"
echo ""

# --- Install ---
echo "[1/4] Installing fail2ban..."
apt-get update -qq && apt-get install -y fail2ban

# --- Log dirs ---
echo "[2/4] Creating log directories..."
mkdir -p "$REPO_DIR/logs/nginx" "$REPO_DIR/logs/coturn"
chown -R "$APP_USER":"$APP_USER" "$REPO_DIR/logs"

# --- Install configs ---
echo "[3/4] Installing fail2ban config..."

# Substitute __REPO_DIR__ placeholder in jail.local before copying
sed "s|__REPO_DIR__|$REPO_DIR|g" "$REPO_DIR/fail2ban/jail.local" > /etc/fail2ban/jail.local

cp "$REPO_DIR/fail2ban/filter.d/coturn-auth.conf"  /etc/fail2ban/filter.d/coturn-auth.conf
cp "$REPO_DIR/fail2ban/filter.d/nginx-req-limit.conf" /etc/fail2ban/filter.d/nginx-req-limit.conf

# --- Start ---
echo "[4/4] Enabling fail2ban..."
systemctl enable fail2ban
systemctl restart fail2ban
sleep 2

echo ""
echo "=== Status ==="
systemctl is-active fail2ban && fail2ban-client status
echo ""
echo "Done. Log files at $REPO_DIR/logs/ will populate after containers are redeployed."
echo "Check a jail with: fail2ban-client status sshd"
