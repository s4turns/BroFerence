#!/bin/bash
# Install and configure fail2ban for BroFerence
# Run once on a fresh server: bash setup-fail2ban.sh

set -e

echo "=== Installing fail2ban ==="
apt-get update -qq && apt-get install -y fail2ban

echo "=== Creating log directories ==="
mkdir -p /home/bro/BroFerence/logs/nginx
mkdir -p /home/bro/BroFerence/logs/coturn
chown -R bro:bro /home/bro/BroFerence/logs

echo "=== Installing fail2ban config ==="
cp /home/bro/BroFerence/fail2ban/jail.local /etc/fail2ban/jail.local
cp /home/bro/BroFerence/fail2ban/filter.d/coturn-auth.conf /etc/fail2ban/filter.d/coturn-auth.conf
cp /home/bro/BroFerence/fail2ban/filter.d/nginx-req-limit.conf /etc/fail2ban/filter.d/nginx-req-limit.conf

echo "=== Enabling and starting fail2ban ==="
systemctl enable fail2ban
systemctl restart fail2ban

echo "=== fail2ban status ==="
systemctl is-active fail2ban
fail2ban-client status

echo ""
echo "Done. Check jail status with: fail2ban-client status <jail-name>"
echo "Check bans with: fail2ban-client status sshd"
