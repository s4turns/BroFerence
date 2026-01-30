#!/usr/bin/env python3
"""
Enhanced WebRTC Signaling Server with Multi-Participant Support
Supports multiple users per room, password protection, and IRC chat bridge
"""

import asyncio
import json
import logging
import ssl
from typing import Dict, Set, Optional
import websockets
from websockets.server import WebSocketServerProtocol
from irc_bridge import IRCBridge
import hashlib

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Store connected clients: {websocket: {'id': str, 'room': str, 'username': str}}
clients: Dict[WebSocketServerProtocol, dict] = {}

# Store rooms: {room_id: {'users': Set[websocket], 'password': Optional[str], 'irc_channel': Optional[str], 'moderator': Optional[str], 'banned': Set[str]}}
rooms: Dict[str, dict] = {}

# IRC bridge instance
irc_bridge: Optional[IRCBridge] = None


async def init_irc_bridge():
    """Initialize IRC bridge connection."""
    global irc_bridge
    try:
        irc_bridge = IRCBridge(
            server="irc.blcknd.network",
            port=6697,
            nickname="webrtc",
            use_ssl=True
        )
        await irc_bridge.connect()
        logger.info("IRC bridge initialized")
    except Exception as e:
        logger.error(f"Failed to initialize IRC bridge: {e}")
        irc_bridge = None


def hash_password(password: str) -> str:
    """Hash password for storage."""
    return hashlib.sha256(password.encode()).hexdigest()


async def register_client(websocket: WebSocketServerProtocol, client_id: str, username: str = None):
    """Register a new client connection."""
    clients[websocket] = {
        'id': client_id,
        'room': None,
        'username': username or f"User_{client_id[:8]}"
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
            rooms[room]['users'].discard(websocket)

            # Notify others in room
            await broadcast_to_room(room, {
                'type': 'user-left',
                'clientId': client_id,
                'username': username
            }, exclude=websocket)

            # Send IRC notification
            if irc_bridge and rooms[room].get('irc_channel'):
                await irc_bridge.send_message(room, "System", f"{username} left the room")

            # Clean up empty rooms
            if not rooms[room]['users']:
                if irc_bridge and rooms[room].get('irc_channel'):
                    await irc_bridge.leave_channel(room)
                del rooms[room]
                logger.info(f"Room {room} deleted (empty)")

        del clients[websocket]
        logger.info(f"Client {client_id} disconnected. Total clients: {len(clients)}")


async def create_room(room_id: str, password: Optional[str] = None, irc_channel: Optional[str] = None, moderator_id: Optional[str] = None):
    """Create a new room."""
    if room_id not in rooms:
        rooms[room_id] = {
            'users': set(),
            'password': hash_password(password) if password else None,
            'irc_channel': irc_channel,
            'moderator': moderator_id,  # First user to create the room becomes moderator
            'banned': set()  # Set of banned client IDs
        }

        # Join IRC channel if specified
        if irc_bridge and irc_channel:
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

        if hash_password(password) != rooms[room_id]['password']:
            await websocket.send(json.dumps({
                'type': 'error',
                'message': 'Incorrect password'
            }))
            return False

    # Leave current room if in one
    if client_info['room']:
        await leave_room(websocket)

    # Join new room
    rooms[room_id]['users'].add(websocket)
    client_info['room'] = room_id

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

    # Check if user is moderator
    is_moderator = (rooms[room_id]['moderator'] == client_id)

    # Send room info to joining client
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'roomId': room_id,
        'users': other_users,
        'hasPassword': rooms[room_id]['password'] is not None,
        'ircChannel': rooms[room_id].get('irc_channel'),
        'isModerator': is_moderator,
        'moderatorId': rooms[room_id]['moderator']
    }))

    # Notify others in room
    await broadcast_to_room(room_id, {
        'type': 'user-joined',
        'clientId': client_id,
        'username': username
    }, exclude=websocket)

    # Send IRC notification
    if irc_bridge and rooms[room_id].get('irc_channel'):
        await irc_bridge.send_message(room_id, "System", f"{username} joined the room")

    return True


async def leave_room(websocket: WebSocketServerProtocol):
    """Remove client from their current room."""
    client_info = clients[websocket]
    room = client_info['room']

    if room and room in rooms:
        rooms[room]['users'].discard(websocket)
        client_info['room'] = None

        # Notify others
        await broadcast_to_room(room, {
            'type': 'user-left',
            'clientId': client_info['id'],
            'username': client_info['username']
        }, exclude=websocket)

        # Clean up empty rooms
        if not rooms[room]['users']:
            if irc_bridge and rooms[room].get('irc_channel'):
                await irc_bridge.leave_channel(room)
            del rooms[room]


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
                await broadcast_to_room(room, {
                    'type': 'chat-message',
                    'username': username,
                    'message': msg_content,
                    'timestamp': asyncio.get_event_loop().time()
                })

                # Send to IRC if bridged
                if irc_bridge and rooms[room].get('irc_channel'):
                    await irc_bridge.send_message(room, username, msg_content)

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

        elif msg_type == 'kick-user':
            # Moderator kicking a user
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')

                # Find and disconnect the target user
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
                    'message': 'Only moderator can kick users'
                }))

        elif msg_type == 'ban-user':
            # Moderator banning a user
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')

                # Add to banned list
                rooms[room]['banned'].add(target_id)

                # Find and disconnect the target user
                for ws, info in list(clients.items()):
                    if info['id'] == target_id and info['room'] == room:
                        await ws.send(json.dumps({
                            'type': 'banned',
                            'message': 'You have been banned from this room'
                        }))
                        await ws.close()
                        break

                logger.info(f"User {target_id} banned from room {room}")
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderator can ban users'
                }))

        elif msg_type == 'change-name':
            # User changing their name
            client_info = clients[websocket]
            room = client_info['room']
            old_username = client_info['username']
            new_username = data.get('newUsername', '').strip()

            if new_username and room:
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
                if irc_bridge and rooms[room].get('irc_channel'):
                    await irc_bridge.send_message(room, "System", f"{old_username} changed their name to {new_username}")

                logger.info(f"User {old_username} changed name to {new_username} in room {room}")

        elif msg_type == 'moderator-change-name':
            # Moderator changing another user's name
            client_info = clients[websocket]
            room = client_info['room']

            if room and rooms[room]['moderator'] == client_info['id']:
                target_id = data.get('targetId')
                new_username = data.get('newUsername', '').strip()

                if new_username:
                    # Find target user and update their name
                    for ws, info in clients.items():
                        if info['id'] == target_id and info['room'] == room:
                            old_username = info['username']
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
                            if irc_bridge and rooms[room].get('irc_channel'):
                                await irc_bridge.send_message(room, "System", f"Moderator changed {old_username}'s name to {new_username}")

                            logger.info(f"Moderator changed {old_username} to {new_username} in room {room}")
                            break
            else:
                await websocket.send(json.dumps({
                    'type': 'error',
                    'message': 'Only moderator can change user names'
                }))

        else:
            logger.warning(f"Unknown message type: {msg_type}")

    except json.JSONDecodeError:
        logger.error(f"Invalid JSON received: {message}")
    except Exception as e:
        logger.error(f"Error handling message: {e}", exc_info=True)


async def handler(websocket: WebSocketServerProtocol):
    """Main WebSocket connection handler."""
    try:
        async for message in websocket:
            await handle_message(websocket, message)
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await unregister_client(websocket)


async def main():
    """Start the WebSocket server and IRC bridge."""
    # Initialize IRC bridge
    await init_irc_bridge()

    host = "0.0.0.0"
    port = 8765

    # SSL context for WSS
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain('/etc/ssl/certs/fullchain.pem', '/etc/ssl/private/privkey.pem')

    logger.info(f"Starting enhanced WebRTC signaling server on wss://{host}:{port}")
    logger.info(f"Features: Multi-participant, IRC bridge, Password protection")

    async with websockets.serve(handler, host, port, ssl=ssl_context):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
