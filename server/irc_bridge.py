#!/usr/bin/env python3
"""
IRC Bridge for WebRTC Chat
Bridges chat messages between WebRTC rooms and IRC channels
"""

import asyncio
import ssl
import logging
from typing import Dict, Callable, Optional

logger = logging.getLogger(__name__)


class IRCBridge:
    """Bridge between WebRTC chat and IRC."""

    def __init__(self, server: str = "irc.blcknd.network", port: int = 6697,
                 nickname: str = "webrtc-bridge", use_ssl: bool = True):
        self.server = server
        self.port = port
        self.nickname = nickname
        self.use_ssl = use_ssl

        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.connected = False

        # Callbacks for receiving messages from IRC
        self.message_callbacks: Dict[str, Callable] = {}

        # Channel mappings: {webrtc_room: irc_channel}
        self.room_channels: Dict[str, str] = {}

    async def connect(self):
        """Connect to IRC server."""
        try:
            logger.info(f"Connecting to IRC server {self.server}:{self.port}...")
            logger.info(f"SSL enabled: {self.use_ssl}")

            if self.use_ssl:
                logger.info("Creating SSL context...")
                ssl_context = ssl.create_default_context()
                logger.info("Opening SSL connection...")
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(self.server, self.port, ssl=ssl_context),
                    timeout=10.0
                )
            else:
                logger.info("Opening plain connection...")
                self.reader, self.writer = await asyncio.wait_for(
                    asyncio.open_connection(self.server, self.port),
                    timeout=10.0
                )

            logger.info("✓ TCP connection established")

            # Send IRC registration
            logger.info(f"Sending NICK {self.nickname}")
            await self.send_raw(f"NICK {self.nickname}")
            logger.info(f"Sending USER registration")
            await self.send_raw(f"USER {self.nickname} 0 * :WebRTC Bridge Bot")

            # Wait for connection to be established
            logger.info("Waiting for IRC welcome message...")
            await self._wait_for_welcome()

            self.connected = True
            logger.info(f"✓ Connected to IRC as {self.nickname}")

            # Start message listener
            asyncio.create_task(self._message_listener())

        except asyncio.TimeoutError:
            logger.error(f"Timeout connecting to IRC server {self.server}:{self.port}")
            raise ConnectionError(f"Timeout connecting to {self.server}:{self.port}")
        except Exception as e:
            logger.error(f"Failed to connect to IRC: {type(e).__name__}: {e}")
            import traceback
            logger.error(f"Traceback: {traceback.format_exc()}")
            raise

    async def _wait_for_welcome(self):
        """Wait for IRC welcome message."""
        logger.info("Reading IRC server responses...")
        message_count = 0
        while True:
            line = await asyncio.wait_for(self.reader.readline(), timeout=15.0)
            if not line:
                raise ConnectionError("IRC connection closed during registration")

            message = line.decode('utf-8', errors='ignore').strip()
            message_count += 1
            logger.info(f"IRC << [{message_count}] {message}")

            # Respond to PING
            if message.startswith("PING"):
                pong = message.replace("PING", "PONG")
                logger.info(f"IRC >> PONG")
                await self.send_raw(pong)

            # Check for welcome message (001) or end of MOTD (376)
            if " 001 " in message:
                logger.info("✓ Received IRC welcome message (001)")
                break
            elif " 376 " in message:
                logger.info("✓ Received IRC end of MOTD (376)")
                break
            elif " 422 " in message:
                logger.info("✓ Received IRC no MOTD (422)")
                break

    async def send_raw(self, message: str):
        """Send raw IRC message."""
        if self.writer:
            self.writer.write(f"{message}\r\n".encode('utf-8'))
            await self.writer.drain()

    async def join_channel(self, channel: str, room_id: str):
        """Join an IRC channel and map it to a WebRTC room."""
        if not channel.startswith('#'):
            channel = f"#{channel}"

        logger.info(f"Joining IRC channel {channel} for room {room_id}...")
        await self.send_raw(f"JOIN {channel}")
        self.room_channels[room_id] = channel
        logger.info(f"✓ Joined IRC channel {channel} for room {room_id}")

    async def leave_channel(self, room_id: str):
        """Leave an IRC channel."""
        if room_id in self.room_channels:
            channel = self.room_channels[room_id]
            await self.send_raw(f"PART {channel}")
            del self.room_channels[room_id]
            logger.info(f"Left IRC channel {channel}")

    async def send_message(self, room_id: str, username: str, message: str):
        """Send message from WebRTC user to IRC channel."""
        if room_id in self.room_channels:
            channel = self.room_channels[room_id]
            formatted = f"<{username}> {message}"
            await self.send_raw(f"PRIVMSG {channel} :{formatted}")

    def register_message_callback(self, room_id: str, callback: Callable):
        """Register callback for receiving IRC messages for a room."""
        self.message_callbacks[room_id] = callback

    async def _message_listener(self):
        """Listen for messages from IRC."""
        try:
            while self.connected:
                line = await self.reader.readline()
                if not line:
                    logger.warning("IRC connection closed")
                    self.connected = False
                    break

                message = line.decode('utf-8', errors='ignore').strip()
                logger.debug(f"IRC: {message}")

                # Respond to PING
                if message.startswith("PING"):
                    pong = message.replace("PING", "PONG")
                    await self.send_raw(pong)
                    continue

                # Parse PRIVMSG
                if " PRIVMSG " in message:
                    await self._handle_privmsg(message)

        except Exception as e:
            logger.error(f"Error in IRC message listener: {e}")
            self.connected = False

    async def _handle_privmsg(self, message: str):
        """Handle PRIVMSG from IRC."""
        try:
            # Format: :nick!user@host PRIVMSG #channel :message
            parts = message.split(" PRIVMSG ", 1)
            if len(parts) != 2:
                return

            nick_part = parts[0][1:].split("!")[0]  # Extract nickname
            rest = parts[1].split(" :", 1)
            if len(rest) != 2:
                return

            channel = rest[0]
            msg_content = rest[1]

            # Don't echo our own messages
            if nick_part == self.nickname:
                return

            # Find which room this channel belongs to
            for room_id, mapped_channel in self.room_channels.items():
                if mapped_channel == channel:
                    if room_id in self.message_callbacks:
                        await self.message_callbacks[room_id](nick_part, msg_content)
                    break

        except Exception as e:
            logger.error(f"Error handling IRC PRIVMSG: {e}")

    async def disconnect(self):
        """Disconnect from IRC."""
        if self.writer:
            await self.send_raw("QUIT :WebRTC Bridge disconnecting")
            self.writer.close()
            await self.writer.wait_closed()
        self.connected = False
        logger.info("Disconnected from IRC")
