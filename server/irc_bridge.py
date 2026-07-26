#!/usr/bin/env python3
"""
IRC Bridge for BroFerence

Every conference room is a real IRC channel (#<prefix><roomname>), and every
participant gets their own IRC connection so they appear on the network as a
real user that others can see, highlight and /msg.

Three layers:
  IRCConnection  - one socket. Registration, PING/PONG, rate-limited sending,
                   line splitting, reconnect with backoff, 433 nick collisions.
  IRCUserSession - an IRCConnection owned by one conference participant.
  IRCBridge      - the manager. Owns the bot connection (the sole reader of
                   channel traffic) plus the per-room user sessions, and maps
                   rooms to channels in both directions.
"""

import asyncio
import hashlib
import logging
import os
import random
import re
import ssl
from typing import Callable, Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


# ── Configuration (deployment knobs only — never user-facing) ──────────────────

IRC_SERVER = os.environ.get('IRC_SERVER', 'irc.blcknd.network')
IRC_PORT = int(os.environ.get('IRC_PORT', '6697'))
IRC_SSL = os.environ.get('IRC_SSL', 'true').lower() not in ('false', '0', 'no')
IRC_CHANNEL_PREFIX = os.environ.get('IRC_CHANNEL_PREFIX', 'bro-')
IRC_BOT_NICK = os.environ.get('IRC_BOT_NICK', 'webrtc')
IRC_MAX_USER_CONNECTIONS = int(os.environ.get('IRC_MAX_USER_CONNECTIONS', '64'))
IRC_SEND_RATE = float(os.environ.get('IRC_SEND_RATE', '0.6'))

# An IRC line is 512 bytes including prefix, command, target and CRLF. Budget
# conservatively for the payload so the server never truncates us.
IRC_LINE_LIMIT = 400
CHANNEL_MAXLEN = 50
NICK_MAXLEN = 30

# Space out connections so a full room doesn't open every socket at once and
# trip the network's connection throttling.
CONNECT_SPACING = 0.3

_connect_lock = asyncio.Lock()
_last_connect_at = 0.0


async def _stagger_connect():
    """Serialise connection attempts, spacing them by CONNECT_SPACING."""
    global _last_connect_at
    async with _connect_lock:
        loop = asyncio.get_event_loop()
        wait = CONNECT_SPACING - (loop.time() - _last_connect_at)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_connect_at = loop.time()


# ── Pure helpers ──────────────────────────────────────────────────────────────

_CHANNEL_ILLEGAL = re.compile(r'[^a-z0-9._-]+')
_CHANNEL_RUNS = re.compile(r'-{2,}')
# RFC 2812 nick charset: letters, digits and []\`_^{|}-
_NICK_ILLEGAL = re.compile(r'[^A-Za-z0-9\[\]\\`_^{|}-]+')


def channel_for_room(room_id: str, prefix: str = None) -> str:
    """Derive an IRC channel name from a room name.

    Room names are free-form and unvalidated, so everything illegal in a
    channel name (spaces, commas, colons, control bytes) collapses to '-'.
    """
    prefix = IRC_CHANNEL_PREFIX if prefix is None else prefix
    base = _CHANNEL_ILLEGAL.sub('-', (room_id or '').lower())
    base = _CHANNEL_RUNS.sub('-', base).strip('-._')

    if not base:
        # Nothing survived sanitising (e.g. a name that was entirely emoji).
        base = hashlib.sha1((room_id or '').encode('utf-8')).hexdigest()[:8]

    budget = CHANNEL_MAXLEN - 1 - len(prefix)
    return '#' + prefix + base[:budget]


def nick_for_username(username: str) -> str:
    """Derive a legal IRC nick from a conference username.

    Server-side collisions (433) are handled by IRCConnection, not here.
    """
    nick = _NICK_ILLEGAL.sub('', username or '')
    # A nick may not start with a digit or a hyphen.
    nick = nick.lstrip('0123456789-')

    if not nick:
        nick = 'user' + hashlib.sha1((username or '').encode('utf-8')).hexdigest()[:6]

    return nick[:NICK_MAXLEN]


def split_message(text: str, limit: int = IRC_LINE_LIMIT) -> List[str]:
    """Split text into IRC-safe lines.

    Embedded newlines become separate messages rather than being flattened,
    and long lines are chunked on UTF-8 character boundaries so multi-byte
    characters are never cut in half.
    """
    lines = []
    normalised = (text or '').replace('\r\n', '\n').replace('\r', '\n')

    for line in normalised.split('\n'):
        if not line:
            continue

        data = line.encode('utf-8')
        if len(data) <= limit:
            lines.append(line)
            continue

        start = 0
        while start < len(data):
            chunk = data[start:start + limit]
            # Back off to the last valid UTF-8 boundary.
            while chunk:
                try:
                    lines.append(chunk.decode('utf-8'))
                    break
                except UnicodeDecodeError:
                    chunk = chunk[:-1]
            if not chunk:
                # Pathological input; skip a byte rather than spin forever.
                start += 1
            else:
                start += len(chunk)

    return lines


def parse_line(line: str) -> Tuple[Optional[str], str, List[str]]:
    """Parse an IRC line into (prefix, command, params).

    The trailing parameter (after ' :') is returned as the final param.
    """
    prefix = None
    rest = line

    if rest.startswith(':'):
        prefix, _, rest = rest[1:].partition(' ')

    trailing = None
    if ' :' in rest:
        rest, _, trailing = rest.partition(' :')
    elif rest.startswith(':'):
        trailing, rest = rest[1:], ''

    parts = rest.split()
    command = parts[0].upper() if parts else ''
    params = parts[1:]
    if trailing is not None:
        params.append(trailing)

    return prefix, command, params


def nick_from_prefix(prefix: Optional[str]) -> str:
    """Extract the nick from a 'nick!user@host' prefix."""
    if not prefix:
        return ''
    return prefix.split('!', 1)[0]


# ── One IRC socket ────────────────────────────────────────────────────────────

class IRCConnection:
    """A single IRC connection: registration, keepalive, sending, reconnect."""

    def __init__(self, nick: str, *, realname: str = 'BroFerence',
                 on_message: Optional[Callable] = None,
                 on_ready: Optional[Callable] = None,
                 label: str = ''):
        self.desired_nick = nick
        self.nick = nick
        self.realname = realname
        self.on_message = on_message      # async (prefix, command, params)
        self.on_ready = on_ready          # async () - called after registration
        self.label = label or nick

        self.reader: Optional[asyncio.StreamReader] = None
        self.writer: Optional[asyncio.StreamWriter] = None
        self.connected = False

        self._sendq: asyncio.Queue = asyncio.Queue()
        self._run_task: Optional[asyncio.Task] = None
        self._sender_task: Optional[asyncio.Task] = None
        self._closing = False

    # -- lifecycle --

    def start(self):
        if self._run_task is None or self._run_task.done():
            self._run_task = asyncio.create_task(self._run())

    async def close(self, reason: str = 'disconnecting'):
        self._closing = True
        try:
            if self.writer and self.connected:
                await self._write_now(f'QUIT :{reason}')
        except Exception:
            pass
        await self._teardown()
        for task in (self._sender_task, self._run_task):
            if task and not task.done():
                task.cancel()
        logger.info(f'IRC[{self.label}] closed')

    async def _teardown(self):
        self.connected = False
        if self.writer:
            try:
                self.writer.close()
                await self.writer.wait_closed()
            except Exception:
                pass
        self.reader = None
        self.writer = None

    async def _run(self):
        """Connect, register, read. Reconnect with backoff until closed."""
        attempt = 0
        while not self._closing:
            try:
                await _stagger_connect()
                await self._connect()
                await self._register()

                self.connected = True
                attempt = 0
                logger.info(f'IRC[{self.label}] registered as {self.nick}')

                if self._sender_task is None or self._sender_task.done():
                    self._sender_task = asyncio.create_task(self._sender())

                if self.on_ready:
                    await self.on_ready()

                await self._read_loop()

            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f'IRC[{self.label}] connection error: {type(e).__name__}: {e}')

            await self._teardown()

            if self._closing:
                break

            attempt += 1
            # Exponential backoff with jitter, capped at a minute.
            delay = min(60.0, (2 ** min(attempt, 6))) * (0.5 + random.random() / 2)
            logger.info(f'IRC[{self.label}] reconnecting in {delay:.1f}s (attempt {attempt})')
            await asyncio.sleep(delay)

    async def _connect(self):
        ssl_context = ssl.create_default_context() if IRC_SSL else None
        self.reader, self.writer = await asyncio.wait_for(
            asyncio.open_connection(IRC_SERVER, IRC_PORT, ssl=ssl_context),
            timeout=15.0
        )

    async def _register(self):
        """Send NICK/USER and wait for welcome, resolving 433 collisions."""
        self.nick = self.desired_nick
        await self._write_now(f'NICK {self.nick}')
        await self._write_now(f'USER {self.nick} 0 * :{self.realname}')

        collisions = 0
        while True:
            line = await asyncio.wait_for(self.reader.readline(), timeout=30.0)
            if not line:
                raise ConnectionError('connection closed during registration')

            text = line.decode('utf-8', errors='ignore').strip()
            if not text:
                continue

            prefix, command, params = parse_line(text)

            if command == 'PING':
                await self._write_now(f'PONG :{params[-1] if params else ""}')
                continue

            # 433 ERR_NICKNAMEINUSE / 432 erroneous / 436 collision
            if command in ('433', '432', '436'):
                collisions += 1
                self.nick = self._next_nick(collisions)
                logger.info(f'IRC[{self.label}] nick in use, trying {self.nick}')
                await self._write_now(f'NICK {self.nick}')
                continue

            if command in ('001', '376', '422'):
                return

            # Fatal: banned, throttled, etc.
            if command in ('465', '464', 'won'):
                raise ConnectionError(f'registration refused: {text}')

    def _next_nick(self, collisions: int) -> str:
        base = self.desired_nick[:NICK_MAXLEN - 3]
        if collisions <= 3:
            return (base + '_' * collisions)[:NICK_MAXLEN]
        suffix = str(random.randint(10, 999))
        return (base[:NICK_MAXLEN - len(suffix)] + suffix)[:NICK_MAXLEN]

    # -- io --

    async def _write_now(self, line: str):
        """Write immediately, bypassing the rate limiter (registration/PONG)."""
        if not self.writer:
            return
        clean = line.replace('\r', '').replace('\n', '')
        self.writer.write(f'{clean}\r\n'.encode('utf-8'))
        await self.writer.drain()

    def send(self, line: str):
        """Queue a line for rate-limited sending."""
        self._sendq.put_nowait(line)

    def privmsg(self, target: str, text: str):
        for chunk in split_message(text):
            self.send(f'PRIVMSG {target} :{chunk}')

    async def _sender(self):
        """Drain the send queue at a fixed rate to avoid Excess Flood kills."""
        while not self._closing:
            line = await self._sendq.get()
            try:
                if self.connected:
                    await self._write_now(line)
            except Exception as e:
                logger.warning(f'IRC[{self.label}] send failed: {e}')
            await asyncio.sleep(IRC_SEND_RATE)

    async def _read_loop(self):
        while self.connected:
            line = await self.reader.readline()
            if not line:
                raise ConnectionError('connection closed by peer')

            text = line.decode('utf-8', errors='ignore').strip()
            if not text:
                continue

            prefix, command, params = parse_line(text)

            if command == 'PING':
                await self._write_now(f'PONG :{params[-1] if params else ""}')
                continue

            if self.on_message:
                try:
                    await self.on_message(prefix, command, params)
                except Exception as e:
                    logger.error(f'IRC[{self.label}] handler error: {e}')

    # -- channel ops --

    def join(self, channel: str):
        self.send(f'JOIN {channel}')

    def part(self, channel: str):
        self.send(f'PART {channel}')


# ── One participant's IRC presence ────────────────────────────────────────────

class IRCUserSession:
    """An IRC connection representing one conference participant.

    Write-mostly: the bot is the sole reader of channel traffic, otherwise N
    sessions would deliver N copies of every line. This session only reacts to
    private messages addressed to it, which are routed back to its one user.
    """

    def __init__(self, room_id: str, client_id: str, username: str, channel: str,
                 on_private: Optional[Callable] = None):
        self.room_id = room_id
        self.client_id = client_id
        self.username = username
        self.channel = channel
        self.on_private = on_private      # async (from_nick, text)

        self.conn = IRCConnection(
            nick_for_username(username),
            realname=f'{username} (BroFerence)',
            on_message=self._handle,
            on_ready=self._on_ready,
            label=f'{username}@{room_id}',
        )

    def start(self):
        self.conn.start()

    async def stop(self):
        await self.conn.close('left the room')

    @property
    def nick(self) -> str:
        return self.conn.nick

    async def _on_ready(self):
        self.conn.join(self.channel)

    async def _handle(self, prefix, command, params):
        # Only private messages — channel traffic belongs to the bot.
        if command != 'PRIVMSG' or len(params) < 2:
            return
        target, text = params[0], params[-1]
        if target.startswith('#'):
            return
        if self.on_private:
            await self.on_private(nick_from_prefix(prefix), text)

    def say(self, text: str):
        self.conn.privmsg(self.channel, text)

    def set_nick(self, username: str):
        """Follow a conference rename onto IRC."""
        self.username = username
        new_nick = nick_for_username(username)
        self.conn.desired_nick = new_nick
        self.conn.send(f'NICK {new_nick}')


# ── The manager ───────────────────────────────────────────────────────────────

class IRCBridge:
    """Owns the bot connection, the room<->channel maps and the user sessions."""

    def __init__(self):
        self.room_channels: Dict[str, str] = {}     # room_id -> #channel
        self.channel_rooms: Dict[str, str] = {}     # #channel -> room_id
        self.message_callbacks: Dict[str, Callable] = {}
        self.sessions: Dict[Tuple[str, str], IRCUserSession] = {}
        self.suspended: set = set()                 # rooms with E2EE on

        self.bot = IRCConnection(
            IRC_BOT_NICK,
            realname='BroFerence Bridge',
            on_message=self._handle_bot_message,
            on_ready=self._on_bot_ready,
            label='bot',
        )

    # -- lifecycle --

    def start(self):
        self.bot.start()

    async def stop(self):
        for session in list(self.sessions.values()):
            await session.stop()
        self.sessions.clear()
        await self.bot.close('shutting down')

    @property
    def connected(self) -> bool:
        return self.bot.connected

    async def _on_bot_ready(self):
        # Rejoin every live channel after a reconnect.
        for channel in self.room_channels.values():
            self.bot.join(channel)

    # -- channel mapping --

    def channel_for(self, room_id: str) -> str:
        """The channel for a room, allocating one on first use.

        Distinct room names can sanitise to the same channel ("my room" and
        "my-room"), so a colliding derivation gets a short hash suffix rather
        than two rooms sharing one channel.
        """
        if room_id in self.room_channels:
            return self.room_channels[room_id]

        channel = channel_for_room(room_id)
        if self.channel_rooms.get(channel, room_id) != room_id:
            digest = hashlib.sha1(room_id.encode('utf-8')).hexdigest()[:4]
            channel = f'{channel[:CHANNEL_MAXLEN - 5]}-{digest}'

        self.room_channels[room_id] = channel
        self.channel_rooms[channel] = room_id
        return channel

    async def open_room(self, room_id: str) -> str:
        """Ensure the bot is in the room's channel. Returns the channel."""
        channel = self.channel_for(room_id)
        if self.bot.connected and room_id not in self.suspended:
            self.bot.join(channel)
        return channel

    async def close_room(self, room_id: str):
        """Room is gone: part the channel and drop all of its state."""
        channel = self.room_channels.pop(room_id, None)
        if channel:
            self.channel_rooms.pop(channel, None)
            if self.bot.connected:
                self.bot.part(channel)

        # Drop the callback too — the old implementation leaked these.
        self.message_callbacks.pop(room_id, None)
        self.suspended.discard(room_id)

        for key in [k for k in self.sessions if k[0] == room_id]:
            await self.sessions.pop(key).stop()

    def register_message_callback(self, room_id: str, callback: Callable):
        self.message_callbacks[room_id] = callback

    # -- participants --

    async def add_user(self, room_id: str, client_id: str, username: str):
        """Give a participant their own IRC presence in the room's channel."""
        if room_id in self.suspended:
            return
        key = (room_id, client_id)
        if key in self.sessions:
            return
        if len(self.sessions) >= IRC_MAX_USER_CONNECTIONS:
            # Over budget: this user still talks, relayed via the bot.
            logger.warning(f'IRC user connection cap reached; {username} will be bot-relayed')
            return

        session = IRCUserSession(
            room_id, client_id, username, self.channel_for(room_id),
            on_private=self._make_private_handler(room_id, client_id),
        )
        self.sessions[key] = session
        session.start()

    async def remove_user(self, room_id: str, client_id: str):
        session = self.sessions.pop((room_id, client_id), None)
        if session:
            await session.stop()

    def rename_user(self, room_id: str, client_id: str, username: str):
        session = self.sessions.get((room_id, client_id))
        if session:
            session.set_nick(username)

    # -- messages --

    async def send_user_message(self, room_id: str, client_id: str,
                                username: str, message: str):
        """Relay a conference message to IRC as that user, if possible."""
        if room_id in self.suspended or room_id not in self.room_channels:
            return

        session = self.sessions.get((room_id, client_id))
        if session and session.conn.connected:
            session.say(message)
        elif self.bot.connected:
            # No session (cap reached, or still connecting): fall back to relay.
            for chunk in split_message(f'<{username}> {message}'):
                self.bot.send(f'PRIVMSG {self.room_channels[room_id]} :{chunk}')

    async def send_system(self, room_id: str, message: str):
        """Server-generated notice. Used sparingly — presence comes from JOIN/PART."""
        if room_id in self.suspended or room_id not in self.room_channels:
            return
        if self.bot.connected:
            self.bot.privmsg(self.room_channels[room_id], message)

    # -- E2EE interlock --

    async def suspend_room(self, room_id: str):
        """Room turned on E2EE: leave IRC entirely until it is turned off."""
        if room_id in self.suspended:
            return
        self.suspended.add(room_id)

        channel = self.room_channels.get(room_id)
        if channel and self.bot.connected:
            self.bot.part(channel)

        for key in [k for k in self.sessions if k[0] == room_id]:
            await self.sessions.pop(key).stop()

        logger.info(f'IRC bridge suspended for room {room_id} (E2EE enabled)')

    async def resume_room(self, room_id: str, participants=None):
        """E2EE turned off: rejoin and restore user sessions."""
        if room_id not in self.suspended:
            return
        self.suspended.discard(room_id)

        await self.open_room(room_id)
        for client_id, username in (participants or []):
            await self.add_user(room_id, client_id, username)

        logger.info(f'IRC bridge resumed for room {room_id}')

    # -- inbound --

    def _make_private_handler(self, room_id: str, client_id: str):
        async def handler(from_nick: str, text: str):
            callback = self.message_callbacks.get(room_id)
            if callback:
                await callback(from_nick, text, client_id)
        return handler

    async def _handle_bot_message(self, prefix, command, params):
        """The bot is the sole reader of channel traffic."""
        if command != 'PRIVMSG' or len(params) < 2:
            return

        target, text = params[0], params[-1]
        if not target.startswith('#'):
            return

        nick = nick_from_prefix(prefix)
        if nick == self.bot.nick:
            return

        room_id = self.channel_rooms.get(target)
        if not room_id or room_id in self.suspended:
            return

        # Don't echo conference users back to themselves — they are real IRC
        # users now, so their own messages arrive on the bot's socket too.
        # Scoped to this room: an unrelated IRC user elsewhere may share a nick.
        for (sess_room, _), session in self.sessions.items():
            if sess_room == room_id and session.conn.connected and session.nick == nick:
                return

        callback = self.message_callbacks.get(room_id)
        if callback:
            await callback(nick, text, None)
