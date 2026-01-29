# WebRTC Video Chat Server

A complete WebRTC video chat application with Python signaling server and local TURN server.

## Components

1. **Signaling Server** (Python/WebSockets) - Handles WebRTC signaling between peers
2. **TURN Server** (Coturn) - Relays media when direct peer-to-peer connection fails
3. **Web Client** (HTML/JavaScript) - Browser-based video chat interface

## Prerequisites

- Python 3.7+
- Node.js (optional, for serving static files)
- Coturn (TURN server)

### Installing Coturn

**On Ubuntu/Debian:**
```bash
sudo apt update
sudo apt install coturn
```

**On macOS:**
```bash
brew install coturn
```

**On Windows:**
Download from: https://github.com/coturn/coturn/wiki/Downloads

## Quick Start (One Command)

### Option 1: Docker (Recommended - Works on All Platforms)

**Install Docker:**
- Windows/Mac: [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Linux: [Docker Engine](https://docs.docker.com/engine/install/)

**Start all services:**

```bash
# Windows
start.bat

# Linux/Mac
chmod +x start.sh
./start.sh
```

**Stop all services:**
```bash
# Windows
stop.bat

# Linux/Mac
./stop.sh
```

Access at: http://localhost:8080

### Option 2: PM2 Process Manager (Development)

**Install PM2:**
```bash
npm install -g pm2
# or
npm run install-pm2
```

**Start all services:**
```bash
npm start
# or
pm2 start ecosystem.config.js
```

**Manage services:**
```bash
npm run logs       # View logs
npm run status     # Check status
npm run stop       # Stop services
npm run restart    # Restart services
pm2 monit          # Monitor in real-time
```

**Run on system startup:**
```bash
pm2 startup        # Follow the instructions
pm2 save           # Save current process list
```

> Note: You still need to run Coturn separately:
> ```bash
> turnserver -c config/turnserver.conf
> ```

### Option 3: Linux System Services (Production)

**Install as systemd services:**
```bash
sudo chmod +x install-services.sh
sudo ./install-services.sh
```

**Manage services:**
```bash
# Start all
sudo systemctl start coturn webrtc-signaling webrtc-web

# Stop all
sudo systemctl stop coturn webrtc-signaling webrtc-web

# Restart all
sudo systemctl restart coturn webrtc-signaling webrtc-web

# Check status
sudo systemctl status coturn webrtc-signaling webrtc-web

# View logs
sudo journalctl -f -u webrtc-signaling
```

Services will auto-start on system boot.

## Manual Setup Instructions

<details>
<summary>Click to expand manual setup instructions</summary>

### 1. Install Python Dependencies

```bash
cd server
pip install -r requirements.txt
```

### 2. Configure and Start TURN Server

**On Linux/Mac:**
```bash
# Enable coturn service
sudo systemctl enable coturn
sudo systemctl start coturn

# Or run manually with config
turnserver -c config/turnserver.conf
```

**On Windows:**
```bash
# Run turnserver with config file
turnserver.exe -c config\turnserver.conf
```

**Test TURN Server:**
Visit https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ and add:
- STUN/TURN URI: `turn:localhost:3478`
- Username: `webrtc`
- Password: `webrtc123`

### 3. Start Signaling Server

```bash
cd server
python signaling_server.py
```

The server will start on `ws://localhost:8765`

### 4. Serve the Web Client

**Option A: Using Python's built-in server:**
```bash
cd client
python -m http.server 8080
```

**Option B: Using Node.js:**
```bash
cd client
npx http-server -p 8080
```

### 5. Access the Application

Open your browser and navigate to:
- http://localhost:8080

</details>

## Usage

1. **Open the application** in two different browser tabs/windows (or two different devices on the same network)

2. **Join a room:**
   - Enter the same room name (e.g., "room1") in both clients
   - Click "Join Room"
   - Grant camera/microphone permissions when prompted

3. **Start a call:**
   - Once both users are in the room, you'll see them listed
   - Click "Call" button next to the user you want to call
   - The video chat will establish automatically

4. **Controls:**
   - Mute/Unmute audio
   - Stop/Start video
   - Leave room to disconnect

## Architecture

### Signaling Flow

1. Client connects to WebSocket signaling server
2. Client registers with unique ID
3. Client joins a room
4. Server notifies other clients in the room
5. Clients exchange WebRTC offers/answers through signaling server
6. Clients exchange ICE candidates
7. Peer-to-peer connection established

### WebRTC Connection

```
Client A                    Signaling Server                Client B
   |                              |                             |
   |-------- Register ----------->|                             |
   |<------- Registered ----------|                             |
   |                              |<-------- Register ----------|
   |                              |--------- Registered ------->|
   |                              |                             |
   |------ Join Room ------------>|                             |
   |<----- Room Joined -----------|                             |
   |                              |<------- Join Room ----------|
   |<----- User Joined -----------|------ Room Joined --------->|
   |                              |                             |
   |-------- Offer ------------->|                             |
   |                              |--------- Offer ------------>|
   |                              |<-------- Answer ------------|
   |<------- Answer --------------|                             |
   |                              |                             |
   |<---- ICE Candidates -------->|<---- ICE Candidates ------->|
   |                              |                             |
   |<========== Direct P2P Connection Established ===========>|
```

### TURN Server Role

- **STUN**: Helps clients discover their public IP address
- **TURN**: Relays media traffic when direct P2P connection fails (behind NAT/firewall)

The TURN server is used as a fallback when:
- Both peers are behind symmetric NATs
- Firewalls block direct connections
- Network topology prevents P2P

## Configuration

### Signaling Server

Edit `server/signaling_server.py`:
- `host`: Default "0.0.0.0" (all interfaces)
- `port`: Default 8765

### TURN Server

Edit `config/turnserver.conf`:
- `listening-port`: TURN server port (default 3478)
- `user`: Username:password for authentication
- `realm`: Authentication realm
- `relay-ip`: IP address for relaying

### WebRTC Client

Edit `client/client.js` - `iceServers` array:
```javascript
iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },  // Public STUN
    {
        urls: 'turn:localhost:3478',             // Your TURN server
        username: 'webrtc',
        credential: 'webrtc123'
    }
]
```

## Troubleshooting

### Camera/Microphone not working
- Check browser permissions
- Ensure you're using HTTPS or localhost (HTTP)
- Try a different browser

### Connection fails
- Check that signaling server is running
- Check browser console for errors
- Verify TURN server is running: `sudo systemctl status coturn`

### TURN server not relaying
- Test TURN connectivity at https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
- Check firewall rules allow ports 3478 and 49152-65535
- Verify username/password match in config and client

### WebSocket connection fails
- Ensure signaling server is running
- Check firewall allows port 8765
- Verify WebSocket URL in client.js matches server

## Production Deployment

For production use:

1. **Use HTTPS/WSS**: WebRTC requires secure context
   - Get SSL certificates (Let's Encrypt)
   - Configure TLS in turnserver.conf
   - Use WSS:// for signaling

2. **Configure external IP**:
   - Set `external-ip` in turnserver.conf to your public IP
   - Update firewall rules

3. **Authentication**:
   - Use time-limited TURN credentials
   - Implement authentication in signaling server

4. **Scaling**:
   - Use Redis for multi-server signaling
   - Deploy TURN servers in multiple regions
   - Use TURN server pools

## Security Notes

- Current configuration is for LOCAL TESTING ONLY
- Change default TURN credentials before deploying
- Implement proper authentication for signaling server
- Use HTTPS/WSS in production
- Restrict TURN server access with firewall rules

## License

MIT
