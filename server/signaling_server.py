#!/usr/bin/env python3
"""
WebRTC Signaling Server using WebSockets
Handles signaling between peers for WebRTC connections
"""

import asyncio
import json
import logging
import ssl
from typing import Dict, Set, Tuple
import websockets
from websockets.server import WebSocketServerProtocol
from pathlib import Path
from datetime import datetime
from cryptography import x509
from cryptography.hazmat.backends import default_backend

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Store connected clients: {websocket: {'id': str, 'room': str}}
clients: Dict[WebSocketServerProtocol, dict] = {}
# Store rooms: {room_id: Set[websocket]}
rooms: Dict[str, Set[WebSocketServerProtocol]] = {}


async def register_client(websocket: WebSocketServerProtocol, client_id: str):
    """Register a new client connection."""
    clients[websocket] = {'id': client_id, 'room': None}
    logger.info(f"Client {client_id} connected. Total clients: {len(clients)}")


async def unregister_client(websocket: WebSocketServerProtocol):
    """Remove a client and clean up their room."""
    if websocket in clients:
        client_info = clients[websocket]
        client_id = client_info['id']
        room = client_info['room']

        # Remove from room if in one
        if room and room in rooms:
            rooms[room].discard(websocket)
            # Notify others in room
            await broadcast_to_room(room, {
                'type': 'user-left',
                'clientId': client_id
            }, exclude=websocket)

            # Clean up empty rooms
            if not rooms[room]:
                del rooms[room]
                logger.info(f"Room {room} deleted (empty)")

        del clients[websocket]
        logger.info(f"Client {client_id} disconnected. Total clients: {len(clients)}")


async def join_room(websocket: WebSocketServerProtocol, room_id: str):
    """Add client to a room."""
    client_info = clients[websocket]
    client_id = client_info['id']

    # Leave current room if in one
    if client_info['room']:
        await leave_room(websocket)

    # Join new room
    if room_id not in rooms:
        rooms[room_id] = set()

    rooms[room_id].add(websocket)
    client_info['room'] = room_id

    # Get list of other users in room
    other_users = [
        clients[ws]['id']
        for ws in rooms[room_id]
        if ws != websocket
    ]

    logger.info(f"Client {client_id} joined room {room_id}. Room size: {len(rooms[room_id])}")

    # Send room info to joining client
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'roomId': room_id,
        'users': other_users
    }))

    # Notify others in room
    await broadcast_to_room(room_id, {
        'type': 'user-joined',
        'clientId': client_id
    }, exclude=websocket)


async def leave_room(websocket: WebSocketServerProtocol):
    """Remove client from their current room."""
    client_info = clients[websocket]
    room = client_info['room']

    if room and room in rooms:
        rooms[room].discard(websocket)
        client_info['room'] = None

        # Notify others
        await broadcast_to_room(room, {
            'type': 'user-left',
            'clientId': client_info['id']
        }, exclude=websocket)

        # Clean up empty rooms
        if not rooms[room]:
            del rooms[room]


async def broadcast_to_room(room_id: str, message: dict, exclude: WebSocketServerProtocol = None):
    """Send a message to all clients in a room except the excluded one."""
    if room_id not in rooms:
        return

    message_json = json.dumps(message)
    tasks = []

    for websocket in rooms[room_id]:
        if websocket != exclude and websocket in clients:
            tasks.append(websocket.send(message_json))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def relay_to_peer(target_id: str, message: dict):
    """Send a message to a specific peer by their client ID."""
    for websocket, info in clients.items():
        if info['id'] == target_id:
            await websocket.send(json.dumps(message))
            return True
    return False


async def handle_message(websocket: WebSocketServerProtocol, message: str):
    """Handle incoming WebSocket messages."""
    try:
        data = json.loads(message)
        msg_type = data.get('type')

        if msg_type == 'register':
            # Client registering with ID
            client_id = data.get('clientId')
            await register_client(websocket, client_id)
            await websocket.send(json.dumps({
                'type': 'registered',
                'clientId': client_id
            }))

        elif msg_type == 'join-room':
            # Client wants to join a room
            room_id = data.get('roomId')
            await join_room(websocket, room_id)

        elif msg_type == 'leave-room':
            # Client leaving room
            await leave_room(websocket)

        elif msg_type in ['offer', 'answer', 'ice-candidate']:
            # WebRTC signaling messages - relay to target peer
            target_id = data.get('targetId')
            sender_id = clients[websocket]['id']

            relay_message = {
                'type': msg_type,
                'senderId': sender_id,
                'data': data.get('data')
            }

            success = await relay_to_peer(target_id, relay_message)
            if not success:
                logger.warning(f"Could not relay {msg_type} to {target_id}")

        else:
            logger.warning(f"Unknown message type: {msg_type}")

    except json.JSONDecodeError:
        logger.error(f"Invalid JSON received: {message}")
    except Exception as e:
        logger.error(f"Error handling message: {e}")


async def handler(websocket: WebSocketServerProtocol):
    """Main WebSocket connection handler."""
    try:
        async for message in websocket:
            await handle_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await unregister_client(websocket)


def log_certificate_info(cert_path: str):
    """Log detailed information about an SSL certificate."""
    try:
        with open(cert_path, 'rb') as f:
            cert_data = f.read()
            cert = x509.load_pem_x509_certificate(cert_data, default_backend())

        # Extract domain names
        domains = []
        try:
            # Get Common Name
            cn = cert.subject.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)[0].value
            domains.append(cn)
        except (IndexError, AttributeError):
            pass

        # Get Subject Alternative Names
        try:
            san_ext = cert.extensions.get_extension_for_oid(x509.oid.ExtensionOID.SUBJECT_ALTERNATIVE_NAME)
            san_domains = [name.value for name in san_ext.value]
            domains.extend([d for d in san_domains if d not in domains])
        except x509.ExtensionNotFound:
            pass

        # Get issuer
        try:
            issuer = cert.issuer.get_attributes_for_oid(x509.oid.NameOID.COMMON_NAME)[0].value
        except (IndexError, AttributeError):
            issuer = "Unknown"

        # Get expiration info
        not_before = cert.not_valid_before_utc if hasattr(cert, 'not_valid_before_utc') else cert.not_valid_before
        not_after = cert.not_valid_after_utc if hasattr(cert, 'not_valid_after_utc') else cert.not_valid_after
        days_until_expiry = (not_after - datetime.now(not_after.tzinfo)).days

        # Log certificate details
        logger.info("=" * 70)
        logger.info("SSL CERTIFICATE DETAILS:")
        logger.info(f"  Issuer: {issuer}")
        logger.info(f"  Domains covered ({len(domains)}):")
        for domain in domains:
            logger.info(f"    • {domain}")
        logger.info(f"  Valid from: {not_before.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        logger.info(f"  Valid until: {not_after.strftime('%Y-%m-%d %H:%M:%S UTC')}")
        logger.info(f"  Days until expiry: {days_until_expiry}")
        if days_until_expiry < 30:
            logger.warning(f"  ⚠️  Certificate expires soon! ({days_until_expiry} days)")
        logger.info("=" * 70)

    except Exception as e:
        logger.warning(f"Could not parse certificate details: {e}")


def find_ssl_certificates() -> Tuple[str, str]:
    """
    Find SSL certificate and key files by checking multiple locations.
    Returns tuple of (cert_path, key_path).

    Search order:
    1. /app/ssl/ directory (Docker volume mount)
    2. ../ssl/ directory (BroFerence/ssl folder - relative to server directory)
    3. /etc/letsencrypt/live/ directory (Let's Encrypt certs - checks all domains)
    4. /etc/ssl/ directory (system-wide certs - fallback)
    """
    cert_names = ['fullchain.pem', 'cert.pem', 'certificate.pem']
    key_names = ['privkey.pem', 'key.pem', 'private.pem']

    # Check multiple possible ssl directories
    ssl_dirs = [
        Path('/app/ssl'),  # Docker volume mount
        Path(__file__).parent.parent / 'ssl',  # Relative to script
    ]

    for ssl_dir in ssl_dirs:
        logger.info(f"Checking for SSL certificates in: {ssl_dir.absolute()}")
        if ssl_dir.exists():
            for cert_name in cert_names:
                for key_name in key_names:
                    cert_path = ssl_dir / cert_name
                    key_path = ssl_dir / key_name
                    if cert_path.exists() and key_path.exists():
                        logger.info(f"✓ Found SSL certificates in {ssl_dir}: {cert_name}, {key_name}")
                        log_certificate_info(str(cert_path.absolute()))
                        return (str(cert_path.absolute()), str(key_path.absolute()))

    # Location 2: Let's Encrypt directory - check all domain folders
    letsencrypt_dir = Path('/etc/letsencrypt/live')
    if letsencrypt_dir.exists():
        # Find all domain directories
        try:
            for domain_dir in letsencrypt_dir.iterdir():
                if domain_dir.is_dir():
                    cert_path = domain_dir / 'fullchain.pem'
                    key_path = domain_dir / 'privkey.pem'
                    if cert_path.exists() and key_path.exists():
                        logger.info(f"✓ Found Let's Encrypt certificates for domain: {domain_dir.name}")
                        log_certificate_info(str(cert_path))
                        return (str(cert_path), str(key_path))
        except PermissionError:
            logger.warning("Permission denied accessing /etc/letsencrypt/live")

    # Location 3: System SSL directory
    for cert_name in cert_names:
        for key_name in key_names:
            cert_path = Path(f'/etc/ssl/certs/{cert_name}')
            key_path = Path(f'/etc/ssl/private/{key_name}')
            if cert_path.exists() and key_path.exists():
                logger.info(f"✓ Found SSL certificates in /etc/ssl/: {cert_name}, {key_name}")
                log_certificate_info(str(cert_path))
                return (str(cert_path), str(key_path))

    # Fallback to hardcoded paths (original behavior)
    logger.warning("No SSL certificates found in standard locations, using fallback paths")
    return ('/etc/ssl/certs/fullchain.pem', '/etc/ssl/private/privkey.pem')


async def main():
    """Start the WebSocket server."""
    host = "0.0.0.0"
    port = 8765

    # Find SSL certificates
    cert_path, key_path = find_ssl_certificates()

    # SSL context for WSS
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        ssl_context.load_cert_chain(cert_path, key_path)
        logger.info(f"Loaded SSL certificates: {cert_path}, {key_path}")
    except Exception as e:
        logger.error(f"Failed to load SSL certificates: {e}")
        raise

    logger.info(f"Starting WebRTC signaling server on wss://{host}:{port}")

    async with websockets.serve(handler, host, port, ssl=ssl_context):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
