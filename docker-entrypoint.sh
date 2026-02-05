#!/bin/sh
# Try multiple SSL cert sources, generate self-signed as last resort

CERT_PATH="/etc/ssl/certs/fullchain.pem"
KEY_PATH="/etc/ssl/private/privkey.pem"

if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ]; then
    mkdir -p /etc/ssl/certs /etc/ssl/private

    # Try Let's Encrypt first (check common domain dirs)
    for domain in /etc/letsencrypt/live/*/; do
        if [ -f "${domain}fullchain.pem" ] && [ -f "${domain}privkey.pem" ]; then
            echo "Found Let's Encrypt certs in ${domain}"
            cp "${domain}fullchain.pem" "$CERT_PATH"
            cp "${domain}privkey.pem" "$KEY_PATH"
            break
        fi
    done
fi

# If still no certs, generate self-signed
if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ]; then
    echo "No SSL certificates found, generating self-signed..."
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$KEY_PATH" \
        -out "$CERT_PATH" \
        -subj "/CN=localhost" 2>/dev/null
    echo "Self-signed certificates generated."
fi

exec nginx -g "daemon off;"
