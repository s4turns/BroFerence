#!/usr/bin/env python3
"""
Enhanced WebRTC Signaling Server with Multi-Participant Support
Supports multiple users per room, password protection, and IRC chat bridge
"""

import asyncio
import json
import logging
import re
import signal
import ssl
import os
import hmac
import secrets
import ipaddress
from typing import Dict, Optional, Tuple
import websockets
from websockets.server import WebSocketServerProtocol
from irc_bridge import IRCBridge
import hashlib
from pathlib import Path
from datetime import datetime, timezone
from cryptography import x509
from cryptography.hazmat.backends import default_backend

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Store connected clients: {websocket: {'id': str, 'room': str, 'username': str}}
clients: Dict[WebSocketServerProtocol, dict] = {}

# Store rooms: {room_id: {'users': list[websocket], 'password': Optional[bytes], 'irc_channel': Optional[str],
#               'moderator': Optional[str], 'co_mods': set[str], 'banned': set[str], 'e2ee_enabled': bool}}
rooms: Dict[str, dict] = {}

# IRC bridge instance
irc_bridge: Optional[IRCBridge] = None

# Admin WebSocket connections (authenticated)
admin_clients: set = set()

# Ban records for admin panel display: list of dicts with metadata
ban_records: list = []

# Global IP bans (admin-only). banned_ips is the enforcement set (fast lookup at
# connection time); ip_ban_records carries display metadata for the admin panel.
# Unlike the per-room client_id bans above, these survive page refreshes because
# they key on the source IP, which the signaling socket sees directly.
banned_ips: set = set()
ip_ban_records: list = []

# Admin secret — read from env or auto-generate
ADMIN_SECRET = os.environ.get('ADMIN_SECRET') or secrets.token_hex(16)

# How long users are given between the restart warning and the containers going
# down. update-vps.sh sleeps for the same span, so keep the two in step — both
# default to 60 and both read RESTART_GRACE_SECONDS from .env.
try:
    RESTART_GRACE_SECONDS = max(5, int(os.environ.get('RESTART_GRACE_SECONDS', '60')))
except ValueError:
    RESTART_GRACE_SECONDS = 60


async def init_irc_bridge():
    """Initialize IRC bridge connection on-demand."""
    global irc_bridge

    # Only initialize if not already connected
    # Check both existence AND connection status
    if irc_bridge is not None and irc_bridge.connected:
        return True

    try:
        logger.info("Initializing IRC bridge (on-demand)...")
        logger.info("IRC server: irc.blcknd.org:6697 (SSL)")
        irc_bridge = IRCBridge(
            server="irc.blcknd.org",
            port=6697,
            nickname="webrtc",
            use_ssl=True
        )
        logger.info("Attempting to connect to IRC server...")
        await irc_bridge.connect()
        logger.info("✓ IRC bridge connected successfully")
        return True
    except ConnectionError as e:
        logger.error(f"✗ IRC connection error: {e}")
        irc_bridge = None
        return False
    except TimeoutError as e:
        logger.error(f"✗ IRC connection timeout: {e}")
        irc_bridge = None
        return False
    except Exception as e:
        logger.error(f"✗ Failed to initialize IRC bridge: {type(e).__name__}: {e}")
        import traceback
        logger.error(f"Traceback: {traceback.format_exc()}")
        irc_bridge = None
        return False


def get_admin_state() -> dict:
    """Build the full state snapshot sent to admin clients."""
    rooms_out = {}
    for room_id, room in rooms.items():
        users_out = []
        for ws in room['users']:
            info = clients.get(ws)
            if info:
                users_out.append({
                    'id': info['id'],
                    'username': info['username'],
                    'ip': info.get('ip', ''),
                    'isMod': room.get('moderator') == info['id'],
                    'isCoMod': info['id'] in room.get('co_mods', set()),
                })
        rooms_out[room_id] = {
            'users': users_out,
            'moderatorId': room.get('moderator'),
            'coModIds': list(room.get('co_mods', set())),
            'hasPassword': room['password'] is not None,
            'e2eeEnabled': room.get('e2ee_enabled', False),
            'bannedCount': len(room.get('banned', set())),
        }
    return {
        'type': 'admin-state',
        'rooms': rooms_out,
        'bans': ban_records,
        'ipBans': ip_ban_records,
        'totalClients': len(clients),
    }


async def broadcast_admin_state():
    """Push updated state to all connected admin clients."""
    if not admin_clients:
        return
    state = get_admin_state()
    msg = json.dumps(state)
    await asyncio.gather(*[ws.send(msg) for ws in list(admin_clients)], return_exceptions=True)


def hash_password(password: str) -> bytes:
    """Hash password using PBKDF2-HMAC-SHA256 with a random salt."""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 260000)
    return salt + dk


def verify_password(password: str, stored: bytes) -> bool:
    """Verify a password against a stored PBKDF2 hash."""
    salt, dk = stored[:16], stored[16:]
    check = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 260000)
    return hmac.compare_digest(check, dk)


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


async def register_client(websocket: WebSocketServerProtocol, client_id: str, username: str = None):
    """Register a new client connection."""
    ip = websocket.remote_address[0] if websocket.remote_address else 'unknown'
    clients[websocket] = {
        'id': client_id,
        'room': None,
        'username': username or f"User_{client_id[:8]}",
        'ip': ip,
    }
    logger.info(f"Client {client_id} ({clients[websocket]['username']}) connected. Total clients: {len(clients)}")


async def unregister_client(websocket: WebSocketServerProtocol):
    """Remove a client and clean up their room."""
    if websocket in clients:
        client_info = clients[websocket]
        client_id = client_info['id']
        username = client_info['username']
        room = client_info['room']

        # Remove from room if in one
        if room and room in rooms:
            try:
                rooms[room]['users'].remove(websocket)
            except ValueError:
                pass

            # Notify others in room
            await broadcast_to_room(room, {
                'type': 'user-left',
                'clientId': client_id,
                'username': username
            }, exclude=websocket)

            # Send IRC notification
            if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                await irc_bridge.send_message(room, "System", f"{username} left the room")

            # Free the screen-share slot if the disconnecting user held it,
            # otherwise a crashed presenter wedges the room permanently
            if rooms[room].get('presenter') == client_id:
                await release_presenter(room)

            # Transfer mod role if the disconnecting user was the moderator
            await transfer_mod_if_needed(room, client_id)

            # Clean up empty rooms
            if not rooms[room]['users']:
                if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                    await irc_bridge.leave_channel(room)
                del rooms[room]
                logger.info(f"Room {room} deleted (empty)")

        del clients[websocket]
        logger.info(f"Client {client_id} disconnected. Total clients: {len(clients)}")
        await broadcast_admin_state()


async def create_room(room_id: str, password: Optional[str] = None, irc_channel: Optional[str] = None, moderator_id: Optional[str] = None):
    """Create a new room."""
    if room_id not in rooms:
        rooms[room_id] = {
            'users': [],        # Ordered list — join order determines owner succession
            'password': hash_password(password) if password else None,
            'irc_channel': irc_channel,
            'moderator': moderator_id,  # Primary owner (first creator or successor)
            'co_mods': set(),   # Additional co-moderators promoted by the owner
            'banned': set(),
            'e2ee_enabled': False,
            'presenter': None   # Client id currently sharing their screen (one at a time)
        }

        # Initialize IRC bridge if channel specified and not already connected
        if irc_channel:
            if not irc_bridge or not irc_bridge.connected:
                logger.info(f"IRC channel specified ({irc_channel}), initializing IRC bridge...")
                success = await init_irc_bridge()
                if not success:
                    logger.error(f"Failed to connect IRC bridge for room {room_id}")

        # Join IRC channel if specified and bridge is available
        if irc_bridge and irc_bridge.connected and irc_channel:
            await irc_bridge.join_channel(irc_channel, room_id)

            # Register callback for IRC messages
            async def irc_message_callback(nick: str, message: str):
                await broadcast_to_room(room_id, {
                    'type': 'chat-message',
                    'username': f"{nick} (IRC)",
                    'message': message,
                    'timestamp': asyncio.get_event_loop().time()
                })

            irc_bridge.register_message_callback(room_id, irc_message_callback)
            logger.info(f"✓ IRC bridge joined channel {irc_channel} for room {room_id}")

        logger.info(f"Room {room_id} created")


async def join_room(websocket: WebSocketServerProtocol, room_id: str, password: Optional[str] = None):
    """Add client to a room."""
    client_info = clients[websocket]
    client_id = client_info['id']
    username = client_info['username']

    # Check if room exists
    if room_id not in rooms:
        await websocket.send(json.dumps({
            'type': 'error',
            'message': 'Room does not exist'
        }))
        return False

    # Check if user is banned
    if client_id in rooms[room_id].get('banned', set()):
        await websocket.send(json.dumps({
            'type': 'error',
            'message': 'You have been banned from this room'
        }))
        return False

    # Check password if required
    if rooms[room_id]['password']:
        if not password:
            await websocket.send(json.dumps({
                'type': 'password-required',
                'roomId': room_id
            }))
            return False

        if not verify_password(password, rooms[room_id]['password']):
            await websocket.send(json.dumps({
                'type': 'error',
                'message': 'Incorrect password'
            }))
            return False

    # Leave current room if in one
    if client_info['room']:
        await leave_room(websocket)

    # Join new room first so user can receive messages
    rooms[room_id]['users'].append(websocket)
    client_info['room'] = room_id

    # Never let two people in a room share a nick — rename the newcomer, since
    # renaming whoever was already here would be worse.
    deduped = unique_username(room_id, username, exclude_ws=websocket)
    if deduped != username:
        logger.info(f"Nick '{username}' taken in room {room_id}, joining as '{deduped}'")
        client_info['username'] = deduped
        await websocket.send(json.dumps({
            'type': 'username-assigned',
            'username': deduped,
            'reason': f'"{username}" is already taken in this room'
        }))
        username = deduped

    # Initialize IRC bridge if room has IRC channel and bridge is not connected
    irc_channel = rooms[room_id].get('irc_channel')
    irc_status_msg = None

    if irc_channel:
        if not irc_bridge or not irc_bridge.connected:
            logger.info(f"Room has IRC channel ({irc_channel}), ensuring IRC bridge is connected...")
            # Send connecting message
            await broadcast_to_room(room_id, {
                'type': 'chat-message',
                'username': 'System',
                'message': f'🔌 Connecting to IRC ({irc_channel})...',
                'timestamp': asyncio.get_event_loop().time()
            })

            success = await init_irc_bridge()
            if not success:
                irc_status_msg = f'❌ Failed to connect to IRC bridge'
            else:
                irc_status_msg = f'✓ Connected to IRC bridge'

        # Join IRC channel if bridge is available and we're not already in it
        if irc_bridge and irc_bridge.connected and room_id not in irc_bridge.room_channels:
            await irc_bridge.join_channel(irc_channel, room_id)

            # Register callback for IRC messages
            async def irc_message_callback(nick: str, message: str):
                await broadcast_to_room(room_id, {
                    'type': 'chat-message',
                    'username': f"{nick} (IRC)",
                    'message': message,
                    'timestamp': asyncio.get_event_loop().time()
                })

            irc_bridge.register_message_callback(room_id, irc_message_callback)
            logger.info(f"✓ IRC bridge joined channel {irc_channel} for room {room_id}")
            irc_status_msg = f'✓ IRC bridge active on {irc_channel}'
        elif irc_bridge and irc_bridge.connected:
            # Already in channel
            irc_status_msg = f'✓ IRC bridge already connected to {irc_channel}'
        elif not irc_bridge or not irc_bridge.connected:
            if not irc_status_msg:  # Only if we didn't already set error message
                irc_status_msg = f'❌ IRC bridge not connected'

    # Send IRC status message if we have one
    if irc_status_msg:
        await broadcast_to_room(room_id, {
            'type': 'chat-message',
            'username': 'System',
            'message': irc_status_msg,
            'timestamp': asyncio.get_event_loop().time()
        })

    # Get list of other users in room
    other_users = [
        {
            'id': clients[ws]['id'],
            'username': clients[ws]['username']
        }
        for ws in rooms[room_id]['users']
        if ws != websocket
    ]

    logger.info(f"Client {client_id} ({username}) joined room {room_id}. Room size: {len(rooms[room_id]['users'])}")
    await broadcast_admin_state()

    # Check if user is moderator
    is_moderator = is_privileged(rooms[room_id], client_id)
    is_owner = (rooms[room_id]['moderator'] == client_id)
    co_mod_ids = list(rooms[room_id].get('co_mods', set()))

    # Send room info to joining client
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'roomId': room_id,
        'users': other_users,
        'hasPassword': rooms[room_id]['password'] is not None,
        'ircChannel': rooms[room_id].get('irc_channel'),
        'isModerator': is_moderator,
        'isOwner': is_owner,
        'moderatorId': rooms[room_id]['moderator'],
        'coModIds': co_mod_ids,
        'e2eeEnabled': rooms[room_id].get('e2ee_enabled', False),
        'presenterId': rooms[room_id].get('presenter'),
        'presenterUsername': get_username_by_id(room_id, rooms[room_id]['presenter'])
                             if rooms[room_id].get('presenter') else None
    }))

    # Notify others in room
    await broadcast_to_room(room_id, {
        'type': 'user-joined',
        'clientId': client_id,
        'username': username
    }, exclude=websocket)

    # Send IRC notification
    if irc_bridge and irc_bridge.connected and rooms[room_id].get('irc_channel'):
        await irc_bridge.send_message(room_id, "System", f"{username} joined the room")

    return True


async def transfer_mod_if_needed(room_id: str, departing_client_id: str):
    """On departure: clean up co-mod status; if owner left, pass owner role."""
    if room_id not in rooms:
        return
    room = rooms[room_id]

    # Always clean up co-mod status if the departing user had it
    room['co_mods'].discard(departing_client_id)

    # If departing user was not the owner, nothing more to do
    if room['moderator'] != departing_client_id:
        return

    if not room['users']:
        room['moderator'] = None
        return

    # Prefer the oldest co-mod as next owner; fall back to first user by join order
    new_mod_ws = None
    for ws in room['users']:
        info = clients.get(ws)
        if info and info['id'] in room['co_mods']:
            new_mod_ws = ws
            break
    if new_mod_ws is None:
        new_mod_ws = room['users'][0]

    new_mod_info = clients.get(new_mod_ws)
    if not new_mod_info:
        return
    new_mod_id = new_mod_info['id']
    new_mod_username = new_mod_info['username']

    # Promote to owner — remove from co_mods if they were one
    room['co_mods'].discard(new_mod_id)
    room['moderator'] = new_mod_id

    await new_mod_ws.send(json.dumps({'type': 'you-are-moderator'}))
    await broadcast_to_room(room_id, {
        'type': 'moderator-promoted',
        'moderatorId': new_mod_id,
        'username': new_mod_username,
        'coModIds': list(room['co_mods'])
    })
    logger.info(f"Owner transferred to {new_mod_username} ({new_mod_id}) in room {room_id}")


async def leave_room(websocket: WebSocketServerProtocol):
    """Remove client from their current room."""
    client_info = clients[websocket]
    room = client_info['room']

    if room and room in rooms:
        try:
            rooms[room]['users'].remove(websocket)
        except ValueError:
            pass
        client_info['room'] = None

        # Notify others
        await broadcast_to_room(room, {
            'type': 'user-left',
            'clientId': client_info['id'],
            'username': client_info['username']
        }, exclude=websocket)

        # Free the screen-share slot if the leaver held it
        if rooms[room].get('presenter') == client_info['id']:
            await release_presenter(room)

        # Transfer mod role if the leaver was the moderator
        await transfer_mod_if_needed(room, client_info['id'])

        # Clean up empty rooms
        if not rooms[room]['users']:
            if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                await irc_bridge.leave_channel(room)
            del rooms[room]


def get_username_by_id(room_id: str, client_id: str) -> str:
    """Look up a client's display name within a room."""
    if room_id not in rooms:
        return 'User'
    for websocket in rooms[room_id]['users']:
        info = clients.get(websocket)
        if info and info['id'] == client_id:
            return info['username']
    return 'User'


async def release_presenter(room_id: str):
    """Free the screen-share slot and tell the room it is available."""
    if room_id not in rooms or not rooms[room_id].get('presenter'):
        return
    rooms[room_id]['presenter'] = None
    await broadcast_to_room(room_id, {
        'type': 'screen-share-state',
        'presenterId': None,
        'username': None
    })


async def broadcast_to_room(room_id: str, message: dict, exclude: WebSocketServerProtocol = None):
    """Send a message to all clients in a room except the excluded one."""
    if room_id not in rooms:
        return

    message_json = json.dumps(message)
    tasks = []

    for websocket in rooms[room_id]['users']:
        if websocket != exclude and websocket in clients:
            tasks.append(websocket.send(message_json))

    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)


async def announce_restart():
    """Warn every connected client that the server is about to go down.

    Triggered by SIGUSR1 so the deploy script can give people notice without
    needing the admin secret — `docker compose kill -s SIGUSR1 signaling`.
    """
    if not clients:
        logger.info('Restart warning requested, but nobody is connected')
        return

    message_json = json.dumps({
        'type': 'server-restart',
        'seconds': RESTART_GRACE_SECONDS
    })
    tasks = [websocket.send(message_json) for websocket in list(clients.keys())]
    await asyncio.gather(*tasks, return_exceptions=True)
    logger.info(f'Restart warning sent to {len(tasks)} client(s), {RESTART_GRACE_SECONDS}s grace')


async def relay_to_peer(target_id: str, message: dict):
    """Send a message to a specific peer by their client ID."""
    for websocket, info in clients.items():
        if info['id'] == target_id:
            await websocket.send(json.dumps(message))
            return True
    return False


def unique_username(room_id: str, desired: str, exclude_ws=None) -> str:
    """IRC-style de-duplication: append _2, _3 ... until the nick is free.

    Comparison is case-insensitive so 'Dave' can't shadow an existing 'dave' —
    two near-identical names in the user list are exactly the confusion this
    is meant to prevent. Returns `desired` unchanged when it is already free.
    """
    if room_id not in rooms:
        return desired

    taken = {
        clients[ws]['username'].lower()
        for ws in rooms[room_id]['users']
        if ws is not exclude_ws and ws in clients
    }

    if desired.lower() not in taken:
        return desired

    suffix = 2
    while f"{desired}_{suffix}".lower() in taken:
        suffix += 1
    return f"{desired}_{suffix}"


def is_privileged(room: dict, client_id: str) -> bool:
    """True if client_id is the owner or a co-moderator."""
    return room.get('moderator') == client_id or client_id in room.get('co_mods', set())


def can_act_on(room: dict, actor_id: str, target_id: str) -> bool:
    """True if actor may perform mod actions on target.
    Owner can act on anyone. Co-mods can only act on regular users."""
    if room.get('moderator') == actor_id:
        return True
    if actor_id in room.get('co_mods', set()):
        return (target_id != room.get('moderator') and
                target_id not in room.get('co_mods', set()))
    return False


async def handle_message(websocket: WebSocketServerProtocol, message: str):
    """Handle incoming WebSocket messages."""
    global ban_records
    try:
        data = json.loads(message)
        msg_type = data.get('type')

        if msg_type == 'register':
            # Client registering with ID
            client_id = data.get('clientId')
            username = data.get('username')
            await register_client(websocket, client_id, username)
            await websocket.send(json.dumps({
                'type': 'registered',
                'clientId': client_id,
                'username': username
            }))

        elif msg_type == 'create-room':
            # Create a new room
            room_id = data.get('roomId')
            password = data.get('password')
            irc_channel = data.get('ircChannel')
            client_id = clients[websocket]['id']
            await create_room(room_id, password, irc_channel, client_id)
            await join_room(websocket, room_id, password)

        elif msg_type == 'join-room':
            # Client wants to join a room
            room_id = data.get('roomId')
            password = data.get('password')

            # Create room if it doesn't exist
            if room_id not in rooms:
                await create_room(room_id)

            await join_room(websocket, room_id, password)

        elif msg_type == 'leave-room':
            # Client leaving room
            await leave_room(websocket)

        elif msg_type == 'chat-message':
            # Chat message in room
            client_info = clients[websocket]
            room = client_info['room']
            username = client_info['username']
            msg_content = data.get('message')

            if room:
                # Broadcast to WebRTC users
                broadcast_msg = {
                    'type': 'chat-message',
                    'username': username,
                    'message': msg_content,
                    'timestamp': asyncio.get_event_loop().time()
                }
                # Pass through E2EE payload opaquely if present
                if 'encrypted' in data:
                    broadcast_msg['encrypted'] = data['encrypted']
                # Pass through image data opaquely if present
                if 'imageData' in data:
                    broadcast_msg['imageData'] = data['imageData']
                await broadcast_to_room(room, broadcast_msg)

                # Send to IRC if bridged
                if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                    await irc_bridge.send_message(room, username, msg_content)

        elif msg_type == 'video-state':
            # User toggled their video - broadcast to room
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']
            video_enabled = data.get('videoEnabled', True)

            if room:
                await broadcast_to_room(room, {
                    'type': 'video-state',
                    'clientId': client_id,
                    'videoEnabled': video_enabled
                }, exclude=websocket)

        elif msg_type == 'screen-share-start':
            # Claim the presenter slot. Only one screen share per room at a time.
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']
            username = client_info['username']

            if room and room in rooms:
                current = rooms[room].get('presenter')
                if current and current != client_id:
                    await websocket.send(json.dumps({
                        'type': 'screen-share-denied',
                        'presenterId': current,
                        'username': get_username_by_id(room, current)
                    }))
                else:
                    rooms[room]['presenter'] = client_id
                    await broadcast_to_room(room, {
                        'type': 'screen-share-state',
                        'presenterId': client_id,
                        'username': username
                    })

        elif msg_type == 'screen-share-stop':
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']

            if room and room in rooms and rooms[room].get('presenter') == client_id:
                await release_presenter(room)

        elif msg_type == 'audio-state':
            # User toggled their audio - broadcast to room
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']
            audio_enabled = data.get('audioEnabled', True)

            if room:
                await broadcast_to_room(room, {
                    'type': 'audio-state',
                    'clientId': client_id,
                    'audioEnabled': audio_enabled
                }, exclude=websocket)

        elif msg_type == 'e2ee-toggle':
            # Moderator toggling end-to-end encryption for the room
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']

            if room and rooms[room]['moderator'] == client_id:  # only owner controls E2EE
                rooms[room]['e2ee_enabled'] = data.get('enabled', False)
                await broadcast_to_room(room, {
                    'type': 'e2ee-toggle',
                    'clientId': client_id,
                    'enabled': rooms[room]['e2ee_enabled']
                })

        elif msg_type in ['offer', 'answer', 'ice-candidate', 'public-key', 'e2ee-room-key']:
            # WebRTC signaling messages - relay to target peer
            target_id = data.get('targetId')
            sender_id = clients[websocket]['id']

            msg_data = data.get('data')

            # Strip raddr/rport from relay ICE candidates to prevent real IP leaks.
            # Even with iceTransportPolicy:'relay', browsers embed the peer's real
            # public IP in the raddr attribute of relay candidates.
            if msg_type == 'ice-candidate' and isinstance(msg_data, dict):
                candidate_str = msg_data.get('candidate', '')
                if candidate_str and 'typ relay' in candidate_str:
                    candidate_str = re.sub(r'\s+raddr\s+\S+', '', candidate_str)
                    candidate_str = re.sub(r'\s+rport\s+\S+', '', candidate_str)
                    msg_data = {**msg_data, 'candidate': candidate_str}

            relay_message = {
                'type': msg_type,
                'senderId': sender_id,
                'data': msg_data
            }

            success = await relay_to_peer(target_id, relay_message)
            if not success:
                logger.warning(f"Could not relay {msg_type} to {target_id}")

        elif msg_type == 'kick-user':
            client_info = clients[websocket]
            room = client_info['room']
            target_id = data.get('targetId')

            if room and can_act_on(rooms[room], client_info['id'], target_id):
                for ws, info in list(clients.items()):
                    if info['id'] == target_id and info['room'] == room:
                        await ws.send(json.dumps({
                            'type': 'kicked',
                            'message': 'You have been kicked from the room'
                        }))
                        await ws.close()
                        break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderators can kick users'
                }))

        elif msg_type == 'ban-user':
            client_info = clients[websocket]
            room = client_info['room']
            target_id = data.get('targetId')

            if room and can_act_on(rooms[room], client_info['id'], target_id):
                rooms[room]['banned'].add(target_id)
                target_username = target_id
                for ws, info in list(clients.items()):
                    if info['id'] == target_id and info['room'] == room:
                        target_username = info['username']
                        await ws.send(json.dumps({
                            'type': 'banned',
                            'message': 'You have been banned from this room'
                        }))
                        await ws.close()
                        break
                if len(ban_records) >= 1000:
                    ban_records.pop(0)
                ban_records.append({
                    'clientId': target_id,
                    'username': target_username,
                    'room': room,
                    'bannedAt': datetime.now(timezone.utc).isoformat(),
                    'bannedBy': client_info['username'],
                })
                logger.info(f"User {target_id} banned from room {room}")
                await broadcast_admin_state()
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderators can ban users'
                }))

        elif msg_type == 'mute-user':
            client_info = clients[websocket]
            room = client_info['room']
            target_id = data.get('targetId')

            if room and can_act_on(rooms[room], client_info['id'], target_id):
                for ws, info in list(clients.items()):
                    if info['id'] == target_id and info['room'] == room:
                        await ws.send(json.dumps({
                            'type': 'force-mute',
                            'by': client_info['username']
                        }))
                        break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderators can mute users'
                }))

        elif msg_type == 'change-name':
            # User changing their name
            client_info = clients[websocket]
            room = client_info['room']
            old_username = client_info['username']
            new_username = data.get('newUsername', '').strip()

            if new_username and room:
                # Keep nicks unique; the client picked the name optimistically,
                # so tell it what it actually ended up with.
                requested = new_username
                new_username = unique_username(room, requested, exclude_ws=websocket)
                if new_username != requested:
                    await websocket.send(json.dumps({
                        'type': 'username-assigned',
                        'username': new_username,
                        'reason': f'"{requested}" is already taken in this room'
                    }))

                # Update username
                client_info['username'] = new_username

                # Broadcast name change to room
                await broadcast_to_room(room, {
                    'type': 'name-changed',
                    'clientId': client_info['id'],
                    'oldUsername': old_username,
                    'newUsername': new_username
                }, exclude=websocket)

                # Send IRC notification if bridged
                if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                    await irc_bridge.send_message(room, "System", f"{old_username} changed their name to {new_username}")

                logger.info(f"User {old_username} changed name to {new_username} in room {room}")

        elif msg_type == 'set-room-password':
            # Owner locking/unlocking the room with a password
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                new_password = data.get('password')  # None or empty string = unlock
                if new_password:
                    rooms[room]['password'] = hash_password(new_password)
                    locked = True
                else:
                    rooms[room]['password'] = None
                    locked = False

                await broadcast_to_room(room, {
                    'type': 'room-lock-changed',
                    'locked': locked,
                    'changedBy': client_info['username']
                })
                logger.info(f"Room {room} {'locked' if locked else 'unlocked'} by {client_info['username']}")
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only the room owner can lock or unlock the room'
                }))

        elif msg_type == 'promote-moderator':
            # Owner transferring primary ownership to another user
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')

                for ws, info in clients.items():
                    if info['id'] == target_id and info['room'] == room:
                        rooms[room]['co_mods'].discard(target_id)
                        rooms[room]['moderator'] = target_id

                        await ws.send(json.dumps({'type': 'you-are-moderator'}))
                        await broadcast_to_room(room, {
                            'type': 'moderator-promoted',
                            'moderatorId': target_id,
                            'username': info['username'],
                            'coModIds': list(rooms[room]['co_mods'])
                        })

                        if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                            await irc_bridge.send_message(room, "System", f"{info['username']} is now the room owner")

                        logger.info(f"Ownership transferred to {target_id} in room {room}")
                        break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only the room owner can transfer ownership'
                }))

        elif msg_type == 'add-co-mod':
            # Owner adding a co-moderator
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')

                for ws, info in clients.items():
                    if info['id'] == target_id and info['room'] == room:
                        if target_id == rooms[room]['moderator']:
                            break  # Already the owner, no-op
                        rooms[room]['co_mods'].add(target_id)

                        await ws.send(json.dumps({'type': 'you-are-co-mod'}))
                        await broadcast_to_room(room, {
                            'type': 'co-mod-added',
                            'coModId': target_id,
                            'username': info['username']
                        })

                        if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                            await irc_bridge.send_message(room, "System", f"{info['username']} is now a co-moderator")

                        logger.info(f"User {target_id} added as co-mod in room {room}")
                        break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only the room owner can add co-moderators'
                }))

        elif msg_type == 'remove-co-mod':
            # Owner removing a co-moderator
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')

                if target_id in rooms[room]['co_mods']:
                    rooms[room]['co_mods'].discard(target_id)
                    target_username = None
                    for ws, info in clients.items():
                        if info['id'] == target_id and info['room'] == room:
                            target_username = info['username']
                            await ws.send(json.dumps({'type': 'co-mod-removed-self'}))
                            break

                    await broadcast_to_room(room, {
                        'type': 'co-mod-removed',
                        'coModId': target_id,
                        'username': target_username or target_id
                    })
                    logger.info(f"User {target_id} removed as co-mod in room {room}")
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only the room owner can remove co-moderators'
                }))

        elif msg_type == 'moderator-change-name':
            # Moderator (owner or co-mod) changing another user's name
            client_info = clients[websocket]
            room = client_info['room']
            target_id_rename = data.get('targetId')

            if room and can_act_on(rooms[room], client_info['id'], target_id_rename):
                target_id = target_id_rename
                new_username = data.get('newUsername', '').strip()

                if new_username:
                    # Find target user and update their name
                    for ws, info in clients.items():
                        if info['id'] == target_id and info['room'] == room:
                            old_username = info['username']
                            # Keep nicks unique even when a mod assigns one.
                            new_username = unique_username(room, new_username, exclude_ws=ws)
                            info['username'] = new_username

                            # Notify the target user
                            await ws.send(json.dumps({
                                'type': 'name-changed-by-moderator',
                                'newUsername': new_username
                            }))

                            # Broadcast to room
                            await broadcast_to_room(room, {
                                'type': 'name-changed',
                                'clientId': target_id,
                                'oldUsername': old_username,
                                'newUsername': new_username
                            })

                            # Send IRC notification if bridged
                            if irc_bridge and irc_bridge.connected and rooms[room].get('irc_channel'):
                                await irc_bridge.send_message(room, "System", f"Moderator changed {old_username}'s name to {new_username}")

                            logger.info(f"Moderator changed {old_username} to {new_username} in room {room}")
                            break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderators can change user names'
                }))

        elif msg_type == 'gravatar':
            client_info = clients[websocket]
            room = client_info['room']
            client_id = client_info['id']
            if room:
                await broadcast_to_room(room, {
                    'type': 'gravatar',
                    'clientId': client_id,
                    'hash': data.get('hash', '')
                }, exclude=websocket)

        # ── Admin commands ─────────────────────────────────────────────────────
        elif msg_type == 'admin-auth':
            secret = data.get('secret', '')
            if hmac.compare_digest(secret, ADMIN_SECRET):
                admin_clients.add(websocket)
                await websocket.send(json.dumps({'type': 'admin-authed'}))
                await websocket.send(json.dumps(get_admin_state()))
                logger.info('Admin client authenticated')
            else:
                await websocket.send(json.dumps({'type': 'admin-auth-failed'}))

        elif msg_type == 'admin-get-state':
            if websocket in admin_clients:
                await websocket.send(json.dumps(get_admin_state()))

        elif msg_type == 'admin-kick':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            for ws, info in list(clients.items()):
                if info['id'] == target_id and info['room'] == room_id:
                    await ws.send(json.dumps({'type': 'kicked', 'message': 'You have been kicked by an admin'}))
                    await ws.close()
                    logger.info(f'Admin kicked {target_id} from {room_id}')
                    break

        elif msg_type == 'admin-ban':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            target_username = data.get('username', target_id)
            if room_id in rooms:
                rooms[room_id]['banned'].add(target_id)
                target_ip = next((info.get('ip', '') for ws, info in clients.items() if info['id'] == target_id), '')
                if len(ban_records) >= 1000:
                    ban_records.pop(0)
                ban_records.append({
                    'clientId': target_id,
                    'username': target_username,
                    'ip': target_ip,
                    'room': room_id,
                    'bannedAt': datetime.now(timezone.utc).isoformat(),
                    'bannedBy': 'admin',
                })
                for ws, info in list(clients.items()):
                    if info['id'] == target_id and info['room'] == room_id:
                        await ws.send(json.dumps({'type': 'banned', 'message': 'You have been banned by an admin'}))
                        await ws.close()
                        break
                logger.info(f'Admin banned {target_id} from {room_id}')
                await broadcast_admin_state()

        elif msg_type == 'admin-unban':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            if room_id in rooms:
                rooms[room_id]['banned'].discard(target_id)
            ban_records = [r for r in ban_records if not (r['clientId'] == target_id and r['room'] == room_id)]
            logger.info(f'Admin unbanned {target_id} from {room_id}')
            await broadcast_admin_state()

        elif msg_type == 'admin-set-mod':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            if room_id in rooms:
                rooms[room_id]['co_mods'].discard(target_id)
                rooms[room_id]['moderator'] = target_id
                for ws, info in clients.items():
                    if info['id'] == target_id and info['room'] == room_id:
                        await ws.send(json.dumps({'type': 'you-are-moderator'}))
                        target_username = info['username']
                        break
                else:
                    target_username = target_id
                await broadcast_to_room(room_id, {
                    'type': 'moderator-promoted',
                    'moderatorId': target_id,
                    'username': target_username,
                    'coModIds': list(rooms[room_id]['co_mods'])
                })
                logger.info(f'Admin set {target_id} as mod in {room_id}')
                await broadcast_admin_state()

        elif msg_type == 'admin-remove-mod':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            if room_id in rooms:
                if rooms[room_id]['moderator'] == target_id:
                    rooms[room_id]['moderator'] = None
                rooms[room_id]['co_mods'].discard(target_id)
                for ws, info in clients.items():
                    if info['id'] == target_id and info['room'] == room_id:
                        await ws.send(json.dumps({'type': 'co-mod-removed-self'}))
                        break
                await broadcast_to_room(room_id, {
                    'type': 'co-mod-removed',
                    'coModId': target_id,
                    'username': target_id
                })
                logger.info(f'Admin removed mod from {target_id} in {room_id}')
                await broadcast_admin_state()

        elif msg_type == 'admin-set-noise-gate':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            enabled = data.get('enabled')      # bool or None
            threshold = data.get('threshold')  # int 1-80 or None
            for ws, info in clients.items():
                if info['id'] == target_id:
                    await ws.send(json.dumps({
                        'type': 'noise-gate-set',
                        'enabled': enabled,
                        'threshold': threshold,
                    }))
                    logger.info(f'Admin set noise gate for {target_id}: enabled={enabled}, threshold={threshold}')
                    break

        elif msg_type == 'admin-mute':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            for ws, info in list(clients.items()):
                if info['id'] == target_id and info['room'] == room_id:
                    await ws.send(json.dumps({
                        'type': 'force-mute',
                        'by': 'Admin'
                    }))
                    logger.info(f'Admin muted {target_id} in {room_id}')
                    break

        elif msg_type == 'admin-ban-ip':
            if websocket not in admin_clients:
                return
            raw_ip = (data.get('ip') or '').strip()
            reason = (data.get('reason') or '').strip()
            # Validate + canonicalize so '1.2.3.004' / casing variants can't slip past.
            try:
                ip = str(ipaddress.ip_address(raw_ip))
            except ValueError:
                await websocket.send(json.dumps({
                    'type': 'admin-error',
                    'message': f'Invalid IP address: {raw_ip}'
                }))
                return
            if ip not in banned_ips:
                banned_ips.add(ip)
                if len(ip_ban_records) >= 1000:
                    ip_ban_records.pop(0)
                ip_ban_records.append({
                    'ip': ip,
                    'reason': reason,
                    'bannedAt': datetime.now(timezone.utc).isoformat(),
                    'bannedBy': 'admin',
                })
            # Kick any currently-connected clients from this IP.
            kicked = 0
            for ws, info in list(clients.items()):
                if info.get('ip') == ip:
                    try:
                        await ws.send(json.dumps({'type': 'banned', 'message': 'Your IP address has been banned'}))
                        await ws.close()
                        kicked += 1
                    except Exception:
                        pass
            logger.info(f'Admin IP-banned {ip} (reason: {reason or "n/a"}), kicked {kicked} active client(s)')
            await broadcast_admin_state()

        elif msg_type == 'admin-unban-ip':
            if websocket not in admin_clients:
                return
            raw_ip = (data.get('ip') or '').strip()
            try:
                ip = str(ipaddress.ip_address(raw_ip))
            except ValueError:
                ip = raw_ip  # fall through to a no-op discard on a malformed value
            banned_ips.discard(ip)
            ip_ban_records[:] = [r for r in ip_ban_records if r['ip'] != ip]
            logger.info(f'Admin lifted IP ban on {ip}')
            await broadcast_admin_state()

        elif msg_type == 'admin-rename':
            if websocket not in admin_clients:
                return
            target_id = data.get('targetId')
            room_id = data.get('roomId')
            new_username = (data.get('newUsername') or '').strip()
            if not new_username:
                return
            for ws, info in clients.items():
                if info['id'] == target_id and info['room'] == room_id:
                    old_username = info['username']
                    info['username'] = new_username
                    await ws.send(json.dumps({
                        'type': 'name-changed-by-moderator',
                        'newUsername': new_username
                    }))
                    await broadcast_to_room(room_id, {
                        'type': 'name-changed',
                        'clientId': target_id,
                        'oldUsername': old_username,
                        'newUsername': new_username
                    })
                    if irc_bridge and irc_bridge.connected and rooms.get(room_id, {}).get('irc_channel'):
                        await irc_bridge.send_message(room_id, "System", f"Admin changed {old_username}'s name to {new_username}")
                    logger.info(f'Admin renamed {target_id} to {new_username} in {room_id}')
                    break
            await broadcast_admin_state()

        elif msg_type == 'admin-set-room-password':
            if websocket not in admin_clients:
                return
            room_id = data.get('roomId')
            new_password = data.get('password')  # None / empty = unlock
            if room_id in rooms:
                if new_password:
                    rooms[room_id]['password'] = hash_password(new_password)
                    locked = True
                else:
                    rooms[room_id]['password'] = None
                    locked = False
                await broadcast_to_room(room_id, {
                    'type': 'room-lock-changed',
                    'locked': locked,
                    'changedBy': 'admin'
                })
                logger.info(f"Admin {'locked' if locked else 'unlocked'} room {room_id}")
                await broadcast_admin_state()

        elif msg_type == 'admin-broadcast':
            if websocket not in admin_clients:
                return
            room_id = data.get('roomId')
            text = (data.get('message') or '').strip()
            if not text:
                return
            targets = [room_id] if room_id else list(rooms.keys())
            for rid in targets:
                if rid in rooms:
                    await broadcast_to_room(rid, {
                        'type': 'chat-message',
                        'username': 'System',
                        'message': text,
                        'timestamp': asyncio.get_event_loop().time()
                    })
                    if irc_bridge and irc_bridge.connected and rooms[rid].get('irc_channel'):
                        await irc_bridge.send_message(rid, "System", text)
            logger.info(f"Admin broadcast to {'room ' + room_id if room_id else 'all rooms'}: {text}")

        else:
            logger.warning(f"Unknown message type: {msg_type}")

    except json.JSONDecodeError:
        logger.error(f"Invalid JSON received: {message}")
    except Exception as e:
        logger.error(f"Error handling message: {e}", exc_info=True)


async def handler(websocket: WebSocketServerProtocol):
    """Main WebSocket connection handler."""
    # Reject connections from globally IP-banned sources before any signaling.
    peer_ip = websocket.remote_address[0] if websocket.remote_address else None
    if peer_ip and peer_ip in banned_ips:
        logger.info(f"Rejected connection from IP-banned source {peer_ip}")
        try:
            await websocket.send(json.dumps({'type': 'banned', 'message': 'Your IP address has been banned'}))
        except Exception:
            pass
        await websocket.close()
        return
    try:
        async for message in websocket:
            await handle_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        admin_clients.discard(websocket)
        await unregister_client(websocket)


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

    logger.info(f"Starting enhanced WebRTC signaling server on wss://{host}:{port}")
    logger.info("Features: Multi-participant, IRC bridge (on-demand), Password protection")
    if not os.environ.get('ADMIN_SECRET'):
        logger.warning("ADMIN_SECRET not set in environment — a random secret was generated for this session")
    else:
        logger.info("ADMIN_SECRET loaded from environment")

    # SIGUSR1 = "tell everyone we're going down". Kept off the admin channel on
    # purpose: ADMIN_SECRET is random per boot unless it's set in .env, so a
    # signal is the one trigger the deploy script can always rely on.
    try:
        asyncio.get_running_loop().add_signal_handler(
            signal.SIGUSR1, lambda: asyncio.create_task(announce_restart()))
        logger.info(f'SIGUSR1 broadcasts a {RESTART_GRACE_SECONDS}s restart warning')
    except (NotImplementedError, AttributeError):
        logger.warning('SIGUSR1 handler unavailable on this platform — no restart warnings')

    # ping_interval/ping_timeout raised from the 20s default: clients in large mesh
    # calls can momentarily peg their CPU (per-peer encode/decode) and miss a keepalive
    # pong, which would otherwise drop them with a 1011 timeout and force a refresh.
    async with websockets.serve(handler, host, port, ssl=ssl_context, max_size=4*1024*1024,
                                ping_interval=20, ping_timeout=60):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
