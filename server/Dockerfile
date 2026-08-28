FROM python:3.11-slim

WORKDIR /app

# Install dependencies. aioquic needs pylsqpack (a C extension); wheels
# normally cover cp311, but keep a toolchain available so a wheel-less
# platform falls back to a source build instead of failing the image build.
RUN apt-get update && apt-get install -y --no-install-recommends build-essential libssl-dev && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy server code
COPY signaling_server_v2.py .
COPY irc_bridge.py .
COPY transport.py .
COPY webtransport_server.py .

# WSS signaling (TCP) and WebTransport-over-QUIC signaling (UDP)
EXPOSE 8765
EXPOSE 8767/udp

# Run the enhanced signaling server
CMD ["python", "signaling_server_v2.py"]
