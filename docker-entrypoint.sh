#!/bin/sh
# Generate self-signed SSL certs if none exist

CERT_PATH="/etc/ssl/certs/fullchain.pem"
KEY_PATH="/etc/ssl/private/privkey.pem"

if [ ! -f "$CERT_PATH" ] || [ ! -f "$KEY_PATH" ]; then
    echo "SSL certificates not found, generating self-signed..."
    mkdir -p /etc/ssl/certs /etc/ssl/private
    openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
        -keyout "$KEY_PATH" \
        -out "$CERT_PATH" \
        -subj "/CN=localhost" 2>/dev/null
    echo "Self-signed certificates generated."
fi

exec nginx -g "daemon off;"
