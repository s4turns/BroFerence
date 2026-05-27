#!/bin/bash
# Configure iptables for BroFerence
# Run as root: bash setup-iptables.sh

set -e

echo "=== Installing iptables-persistent ==="
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent

echo "=== Configuring INPUT chain ==="
iptables -F INPUT
iptables -P INPUT DROP

iptables -A INPUT -i lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -p tcp --dport 22 -m conntrack --ctstate NEW -m limit --limit 4/min --limit-burst 8 -j ACCEPT
iptables -A INPUT -p tcp --dport 443 -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p tcp --dport 8080 -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p tcp --dport 8765 -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p tcp --dport 3479 -m conntrack --ctstate NEW -j ACCEPT
iptables -A INPUT -p udp --dport 3479 -j ACCEPT
iptables -A INPUT -p udp --dport 49152:65535 -j ACCEPT
iptables -A INPUT -s 174.138.183.167 -j ACCEPT  # second TURN VPS
iptables -A INPUT -m conntrack --ctstate INVALID -j DROP

echo "=== Configuring DOCKER-USER chain ==="
iptables -F DOCKER-USER
iptables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DOCKER-USER -p tcp --dport 8765 -m conntrack --ctstate NEW -m hashlimit \
  --hashlimit-name ws-limit --hashlimit-above 20/min --hashlimit-burst 30 \
  --hashlimit-mode srcip -j DROP
iptables -A DOCKER-USER -j RETURN

echo "=== Saving rules ==="
netfilter-persistent save

echo "=== Done ==="
iptables -L INPUT -n --line-numbers
