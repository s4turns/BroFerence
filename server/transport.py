#!/usr/bin/env python3
"""Transport abstraction for the signaling server.

The signaling logic in signaling_server_v2.py stores whatever connection object
it is handed as the key of the global `clients` dict and inside
`rooms[x]['users']`, then calls `.send()` / `.close()` on it directly. That is
~43 send sites and ~6 close sites. Rather than rewrite every one of them to
branch on the transport, we hand the logic a `Peer` wrapper that presents the
same duck-typed surface no matter what is underneath.

Two consequences worth stating, because both are load-bearing:

  * `Peer` deliberately does NOT define __eq__/__hash__. Identity semantics are
    what `clients[peer]`, `rooms[x]['users'].remove(peer)`, `admin_clients` and
    the `exclude=` compare in broadcast_to_room all rely on.
  * `send()` never raises. Some call sites wrap sends in
    `asyncio.gather(..., return_exceptions=True)` and some don't; making the
    method swallow-and-log removes a whole class of "one dead socket kills the
    broadcast" bugs instead of adding one for the new transport.
"""

import asyncio
import logging
import struct

logger = logging.getLogger(__name__)

# Mirrors max_size on websockets.serve(). Chat imageData (base64) is what
# actually drives this ceiling.
MAX_FRAME_BYTES = 4 * 1024 * 1024

# A peer that stops reading must not let us buffer without bound.
MAX_PENDING_SEND_BYTES = 8 * 1024 * 1024


class PeerClosed(Exception):
    """Transport-neutral 'this peer went away'. Each subclass maps its own."""


class Peer:
    """Abstract signaling peer. Subclasses supply _send_impl/_close_impl."""

    kind = 'unknown'

    def __init__(self, remote_ip=None):
        self.remote_ip = remote_ip

    async def send(self, data: str) -> None:
        try:
            await self._send_impl(data)
        except Exception as e:
            # Dropping a message to a dying peer is normal and extremely noisy
            # at INFO; the session teardown path logs the disconnect itself.
            logger.debug(f'send to {self.kind} peer {self.remote_ip} failed: {e}')

    async def close(self) -> None:
        try:
            await self._close_impl()
        except Exception as e:
            logger.debug(f'close of {self.kind} peer {self.remote_ip} failed: {e}')

    async def _send_impl(self, data: str) -> None:
        raise NotImplementedError

    async def _close_impl(self) -> None:
        raise NotImplementedError

    def __aiter__(self):
        return self._messages()

    def _messages(self):
        raise NotImplementedError


class WebSocketPeer(Peer):
    """Wraps a websockets server protocol object."""

    kind = 'ws'

    def __init__(self, websocket):
        addr = getattr(websocket, 'remote_address', None)
        super().__init__(addr[0] if addr else None)
        self.ws = websocket

    async def _send_impl(self, data: str) -> None:
        await self.ws.send(data)

    async def _close_impl(self) -> None:
        await self.ws.close()

    async def _messages(self):
        import websockets
        try:
            async for message in self.ws:
                yield message
        except websockets.exceptions.ConnectionClosed:
            return


class WebTransportPeer(Peer):
    """Wraps one bidirectional WebTransport stream on an HTTP/3 session.

    Framing is a 4-byte big-endian length prefix followed by UTF-8 JSON. A
    length prefix rather than a newline delimiter because the large payload
    here is base64 image data in chat: prefixing gives an O(1) size check and a
    cheap DoS bound instead of scanning megabytes for a separator.
    """

    kind = 'quic'

    def __init__(self, quic, protocol, stream_id, remote_ip=None):
        super().__init__(remote_ip)
        # Data on a WebTransport stream goes straight onto the QUIC stream.
        # H3Connection.send_data() refuses it with FrameUnexpected, because
        # from H3's point of view no response headers were ever sent on this
        # stream -- it is a raw WebTransport stream, not an HTTP body.
        self._quic = quic
        self._protocol = protocol
        self._stream_id = stream_id
        self._inbox = asyncio.Queue()
        self._buffer = bytearray()
        self._closed = False
        self._pending_bytes = 0

    # -- inbound ---------------------------------------------------------

    def feed(self, data: bytes) -> None:
        """Called by the QUIC protocol when stream data arrives."""
        self._buffer.extend(data)
        while len(self._buffer) >= 4:
            (length,) = struct.unpack('!I', self._buffer[:4])
            if length > MAX_FRAME_BYTES:
                logger.warning(
                    f'WebTransport peer {self.remote_ip} sent a {length}B frame '
                    f'(max {MAX_FRAME_BYTES}B) — closing')
                self.feed_eof()
                return
            if len(self._buffer) < 4 + length:
                return  # incomplete frame, wait for more
            payload = bytes(self._buffer[4:4 + length])
            del self._buffer[:4 + length]
            try:
                self._inbox.put_nowait(payload.decode('utf-8'))
            except UnicodeDecodeError:
                logger.warning(f'WebTransport peer {self.remote_ip} sent invalid UTF-8')

    def feed_eof(self) -> None:
        """Called when the stream or the whole QUIC connection ends."""
        if not self._closed:
            self._closed = True
            self._inbox.put_nowait(None)  # sentinel

    async def _messages(self):
        while True:
            message = await self._inbox.get()
            if message is None:
                return
            yield message

    # -- outbound --------------------------------------------------------

    async def _send_impl(self, data: str) -> None:
        if self._closed:
            raise PeerClosed('peer already closed')
        payload = data.encode('utf-8')
        if len(payload) > MAX_FRAME_BYTES:
            raise ValueError(f'frame of {len(payload)}B exceeds {MAX_FRAME_BYTES}B')

        # aioquic buffers into the QUIC connection with no backpressure of its
        # own, so a peer that stops reading would otherwise grow our heap.
        self._pending_bytes += len(payload)
        if self._pending_bytes > MAX_PENDING_SEND_BYTES:
            logger.warning(f'WebTransport peer {self.remote_ip} is not draining — closing')
            self.feed_eof()
            raise PeerClosed('send buffer exceeded')

        self._quic.send_stream_data(self._stream_id,
                                    struct.pack('!I', len(payload)) + payload,
                                    end_stream=False)
        self._protocol.transmit()
        self._pending_bytes -= len(payload)

    async def _close_impl(self) -> None:
        self.feed_eof()
        try:
            self._quic.send_stream_data(self._stream_id, b'', end_stream=True)
            self._protocol.transmit()
        except Exception:
            pass
