#!/usr/bin/env python3
"""WebTransport-over-HTTP/3 listener for signaling.

Runs alongside the existing websockets listener on the same asyncio loop and
the same TLS certificate, and feeds the identical message router. aioquic has
no `serve()`-style convenience for WebTransport the way the websockets library
does for WSS, so the H3 event plumbing is hand-rolled here and kept out of
signaling_server_v2.py.

Session shape: the client CONNECTs to /signaling with :protocol webtransport,
then opens exactly one client-initiated bidirectional stream which becomes the
duplex signaling channel for the life of the session. Additional streams are
ignored. No datagrams — SDP and ICE are order- and delivery-sensitive.
"""

import asyncio
import logging
from typing import Callable, Optional

from aioquic.asyncio import QuicConnectionProtocol, serve
from aioquic.h3.connection import H3_ALPN, H3Connection
from aioquic.h3.events import (
    DatagramReceived,
    HeadersReceived,
    WebTransportStreamDataReceived,
)
from aioquic.quic.configuration import QuicConfiguration
from aioquic.quic.events import ConnectionTerminated, ProtocolNegotiated, StreamReset

from transport import WebTransportPeer

logger = logging.getLogger(__name__)

SIGNALING_PATH = '/signaling'

# Set by serve_webtransport(); called as `await session_handler(peer)` once the
# duplex stream is open, and returns when the session is over.
_session_handler: Optional[Callable] = None


class WebTransportProtocol(QuicConnectionProtocol):
    """One QUIC connection. Carries at most one signaling session."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._http: Optional[H3Connection] = None
        self._session_id: Optional[int] = None
        self._peer: Optional[WebTransportPeer] = None
        self._task: Optional[asyncio.Task] = None
        self._remote_ip: Optional[str] = None

    def _capture_remote_ip(self):
        # The client's real address as QUIC sees it. Note that if Docker's
        # userland proxy is in play for the published UDP port this will be a
        # bridge address (172.x) rather than the true client IP, which would
        # silently break the IP-ban check — see README.
        try:
            paths = getattr(self._quic, '_network_paths', None)
            if paths:
                self._remote_ip = paths[0].addr[0]
        except Exception:
            pass

    def quic_event_received(self, event):
        if isinstance(event, ProtocolNegotiated):
            self._http = H3Connection(self._quic, enable_webtransport=True)
            self._capture_remote_ip()
        elif isinstance(event, ConnectionTerminated):
            self._end_session()
            return
        elif isinstance(event, StreamReset) and self._peer is not None:
            self._end_session()
            return

        if self._http is None:
            return

        for h3_event in self._http.handle_event(event):
            self._h3_event_received(h3_event)

    def _h3_event_received(self, event):
        if isinstance(event, HeadersReceived):
            self._handle_headers(event)
        elif isinstance(event, WebTransportStreamDataReceived):
            self._handle_stream_data(event)
        elif isinstance(event, DatagramReceived):
            pass  # not used; signaling needs reliable ordered delivery

    def _handle_headers(self, event: HeadersReceived):
        headers = {k: v for k, v in event.headers}
        method = headers.get(b':method')
        protocol = headers.get(b':protocol')
        path = headers.get(b':path', b'')

        if method != b'CONNECT' or protocol != b'webtransport':
            self._respond(event.stream_id, b'405')
            return
        if path != SIGNALING_PATH.encode():
            logger.info(f'Rejected WebTransport CONNECT to {path!r} from {self._remote_ip}')
            self._respond(event.stream_id, b'404')
            return

        self._session_id = event.stream_id
        self._http.send_headers(
            stream_id=event.stream_id,
            headers=[
                (b':status', b'200'),
                (b'sec-webtransport-http3-draft', b'draft02'),
            ],
        )
        self.transmit()
        logger.info(f'WebTransport session opened from {self._remote_ip}')

    def _respond(self, stream_id: int, status: bytes):
        self._http.send_headers(stream_id=stream_id, headers=[(b':status', status)],
                                end_stream=True)
        self.transmit()

    def _handle_stream_data(self, event: WebTransportStreamDataReceived):
        if event.session_id != self._session_id:
            return

        # The first client-initiated bidi stream on this session becomes the
        # signaling channel. Anything after it is ignored.
        if self._peer is None:
            self._peer = WebTransportPeer(
                quic=self._quic,
                protocol=self,
                stream_id=event.stream_id,
                remote_ip=self._remote_ip,
            )
            if _session_handler is None:
                logger.error('WebTransport session opened before a handler was registered')
                return
            self._task = asyncio.ensure_future(self._run_session(self._peer))
        elif event.stream_id != self._peer._stream_id:
            return

        if event.data:
            self._peer.feed(event.data)
        if event.stream_ended:
            self._peer.feed_eof()

    async def _run_session(self, peer):
        try:
            await _session_handler(peer)
        except Exception:
            logger.exception('WebTransport session handler crashed')
        finally:
            logger.info(f'WebTransport session closed from {self._remote_ip}')

    def _end_session(self):
        if self._peer is not None:
            self._peer.feed_eof()


async def serve_webtransport(session_handler, host: str, port: int,
                             certfile: str, keyfile: str):
    """Bind the QUIC listener. Returns once bound; the server runs on the loop.

    Raises on failure so the caller can decide — the intent is that a QUIC
    problem is logged and skipped, never allowed to take WSS down with it.
    """
    global _session_handler
    _session_handler = session_handler

    # aioquic logs per-packet handshake detail at INFO -- version negotiation,
    # ALPN, and several "Duplicate CRYPTO data" lines per connection. That is
    # multiple lines for every join, drowning the signaling log this server
    # shares. Warnings and errors still come through.
    logging.getLogger('quic').setLevel(logging.WARNING)
    logging.getLogger('http3').setLevel(logging.WARNING)

    configuration = QuicConfiguration(
        alpn_protocols=H3_ALPN,
        is_client=False,
        max_datagram_frame_size=65536,
    )
    configuration.load_cert_chain(certfile, keyfile)

    await serve(
        host,
        port,
        configuration=configuration,
        create_protocol=WebTransportProtocol,
    )
    logger.info(f'QUIC/WebTransport listener on udp/{port}{SIGNALING_PATH}')
