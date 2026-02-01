#!/usr/bin/env python3
"""
Local Development WebRTC Signaling Server (No SSL)
For local testing without SSL certificates
"""

import asyncio
import json
import logging
from typing import Dict, Optional
import websockets
from websockets.server import WebSocketServerProtocol

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Store connected clients: {websocket: {'id': str, 'room': str, 'username': str}}
clients: Dict[WebSocketServerProtocol, dict] = {}

# Store rooms: {room_id: {'users': Set[websocket], 'password': Optional[str], 'irc_channel': Optional[str]}}
rooms: Dict[str, dict] = {}


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

            # Clean up empty rooms
            if not rooms[room]['users']:
                del rooms[room]
                logger.info(f"Room {room} deleted (empty)")

        del clients[websocket]
        logger.info(f"Client {client_id} disconnected. Total clients: {len(clients)}")


async def create_room(room_id: str, password: Optional[str] = None, irc_channel: Optional[str] = None):
    """Create a new room."""
    if room_id not in rooms:
        rooms[room_id] = {
            'users': set(),
            'password': password,  # Note: No hashing for local dev
            'irc_channel': irc_channel
        }
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

    # Check password if required
    if rooms[room_id]['password']:
        if not password or password != rooms[room_id]['password']:
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

    # Send room info to joining client
    await websocket.send(json.dumps({
        'type': 'room-joined',
        'roomId': room_id,
        'users': other_users,
        'hasPassword': rooms[room_id]['password'] is not None
    }))

    # Notify others in room
    await broadcast_to_room(room_id, {
        'type': 'user-joined',
        'clientId': client_id,
        'username': username
    }, exclude=websocket)

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
            await create_room(room_id, password, irc_channel)
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
    """Start the WebSocket server (without SSL for local development)."""
    host = "0.0.0.0"
    port = 8765

    logger.info(f"Starting LOCAL DEV WebRTC signaling server on ws://{host}:{port}")
    logger.info("NOTE: This is for LOCAL DEVELOPMENT ONLY - No SSL/encryption!")

    async with websockets.serve(handler, host, port):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
