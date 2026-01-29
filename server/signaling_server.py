#!/usr/bin/env python3
"""
WebRTC Signaling Server using WebSockets
Handles signaling between peers for WebRTC connections
"""

import asyncio
import json
import logging
import ssl
from typing import Dict, Set
import websockets
from websockets.server import WebSocketServerProtocol

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


async def main():
    """Start the WebSocket server."""
    host = "0.0.0.0"
    port = 8765

    # SSL context for WSS
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ssl_context.load_cert_chain('/etc/ssl/certs/fullchain.pem', '/etc/ssl/private/privkey.pem')

    logger.info(f"Starting WebRTC signaling server on wss://{host}:{port}")

    async with websockets.serve(handler, host, port, ssl=ssl_context):
        await asyncio.Future()  # Run forever


if __name__ == "__main__":
    asyncio.run(main())
