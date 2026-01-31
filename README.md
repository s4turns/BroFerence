# BroFerence - WebRTC Video Conferencing

<img width="2680" height="1325" alt="image" src="https://github.com/user-attachments/assets/6928a137-044d-4d89-b55b-bc0829687fee" />

A complete multi-participant WebRTC video conferencing application with Python signaling server, TURN server, and IRC chat bridge.

## Features

- **Multi-participant video conferencing** - Unlimited users per room
- **Real-time text chat** - In-app messaging with IRC bridge support
- **Password-protected rooms** - Secure your private meetings
- **Audio enhancements** - Echo cancellation, noise suppression, auto gain control
- **Speaking indicator** - Glowing ring shows who's talking
- **Screen sharing** - Share your screen with participants
- **Dynamic configuration** - Auto-detects localhost vs production
- **Retro terminal aesthetic** - Matrix-style green on black UI
- **IRC bridge** - Connect conference rooms to IRC channels
- **Easy deployment** - Docker support with one-command setup

## Quick Start

### Local Development (Easiest)

**Windows:**
```bash
start-local-dev.bat
```

**Linux/Mac:**
```bash
chmod +x start-local-dev.sh
./start-local-dev.sh
```

This will:
1. Install Python dependencies
2. Start signaling server on `ws://localhost:8765`
3. Start web client on `http://localhost:8080`
4. Open your browser automatically

Access at: **http://localhost:8080/app.html**

### Production Deployment (Docker)

**Prerequisites:**
- Docker and Docker Compose
- Domain name with SSL certificates
- Server with public IP

**1. Clone and configure:**
```bash
git clone https://github.com/s4turns/BroFerence.git
cd BroFerence
```

**2. Set up TURN server with your public IP:**
```bash
chmod +x setup-turn-ip.sh
./setup-turn-ip.sh
```

**3. Start services:**
```bash
docker-compose up -d
```

**4. Update deployment:**
```bash
chmod +x update-vps.sh
./update-vps.sh
```

Access at: **https://your-domain.com/app.html**

## Components

1. **Signaling Server** (Python/WebSockets)
   - Handles WebRTC signaling between peers
   - Multi-room support with password protection
   - IRC bridge integration
   - Dynamic local/production configuration

2. **TURN Server** (Coturn)
   - Relays media when direct P2P fails
   - NAT traversal support
   - Configurable relay ports

3. **Web Client** (HTML/JavaScript/CSS)
   - Browser-based video conferencing
   - Matrix-style retro UI
   - Real-time speaking indicators
   - Built-in audio enhancements

## Usage

### Joining a Room

1. Visit the app in your browser
2. Enter your name
3. Enter a room name (creates if doesn't exist)
4. Optional: Set a password for private rooms
5. Optional: Bridge to an IRC channel
6. Click "Join Room"
7. Grant camera/microphone permissions

### Controls

- **Mute/Unmute** - Toggle your microphone
- **Camera On/Off** - Toggle your video
- **Share Screen** - Share your entire screen
- **Chat** - Open/close text chat sidebar
- **Leave Room** - Exit the conference

### Speaking Indicator

When someone speaks, their video gets a **glowing cyan ring** that pulses with their voice. This works automatically using real-time audio level detection.

### Audio Quality

All audio streams have built-in enhancements:
- **Echo Cancellation** - Removes feedback
- **Noise Suppression** - Filters background noise
- **Auto Gain Control** - Normalizes volume levels

## Configuration

### TURN Server Credentials

**IMPORTANT: Change default credentials in production!**

Edit `config/turnserver.conf`:
```conf
user=webrtc:YOUR_STRONG_PASSWORD_HERE
```

And update `client/conference.js`:
```javascript
credential: 'YOUR_STRONG_PASSWORD_HERE'
```

### Firewall Rules

Open these ports on your server:
```bash
# WebSocket signaling
sudo ufw allow 8765/tcp

# TURN server
sudo ufw allow 3479/tcp
sudo ufw allow 3479/udp

# Media relay ports
sudo ufw allow 49152:49200/udp
```

### IRC Bridge

To bridge a room to IRC:
1. Edit `server/signaling_server_v2.py`
2. Configure IRC server settings (lines 34-38)
3. When creating a room, enter IRC channel (e.g., `#mychannel`)
4. Messages sync between WebRTC and IRC

## Helper Scripts

### `setup-turn-ip.sh`
Auto-configures TURN server with your public IP address.

### `update-vps.sh`
One-command update script:
- Pulls latest code
- Rebuilds Docker containers
- Restarts services

### `test-turn-server.sh`
Diagnostic tool to test TURN server connectivity.

### `debug-hostname.html`
Debug tool to verify dynamic URL detection.

## Troubleshooting

### WebSocket won't connect
```bash
# Check signaling server logs
docker-compose logs signaling

# Verify server is running
docker-compose ps
```

### Video/audio not working
```bash
# Check browser console (F12)
# Verify camera/mic permissions granted
# Test TURN server: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
```

### TURN relay shows 127.0.0.1
```bash
# Run TURN setup script
./setup-turn-ip.sh

# Verify external-ip is set
grep "external-ip" config/turnserver.conf
```

### Browser cache issues
```bash
# Open incognito/private window
Ctrl+Shift+N (or Cmd+Shift+N on Mac)

# Or use DevTools disable cache
F12 > Network tab > Check "Disable cache"
```

### Full rebuild needed
```bash
# Nuclear option - rebuilds everything
docker-compose down -v
docker-compose build --no-cache --pull
docker-compose up -d
```

## Project Structure

```
BroFerence/
├── client/                        # Web client files
│   ├── app.html                   # Main conference UI
│   ├── conference.js              # WebRTC logic
│   ├── styles.css                 # Retro terminal styling
│   └── debug.html                 # Debug tools
├── server/                        # Python backend
│   ├── signaling_server_v2.py     # Production server (WSS + IRC)
│   ├── signaling_server_local.py  # Local dev server (WS)
│   └── irc_bridge.py              # IRC integration
├── config/                        # Configuration
│   └── turnserver.conf            # TURN server config
├── ssl/                           # SSL certificates
│   ├── fullchain.pem
│   └── privkey.pem
├── docker-compose.yml             # Docker orchestration
├── start-local-dev.bat/.sh        # Local dev startup
├── setup-turn-ip.sh               # TURN auto-config
└── update-vps.sh                  # VPS update script
```

## Security Notes

**Default configuration is for LOCAL TESTING ONLY**

For production:
1. Change TURN credentials (default: `webrtc:webrtc123`)
2. Use HTTPS/WSS (not HTTP/WS)
3. Set up proper firewall rules
4. Configure `external-ip` in TURN server
5. Implement user authentication
6. Use secure room passwords
7. Keep dependencies updated

## UI Customization

### Speaking Threshold

Adjust sensitivity in `conference.js` line 271:
```javascript
const SPEAKING_THRESHOLD = 20;  // 10=sensitive, 40=loud only
```

### Color Scheme

Edit CSS variables in `styles.css`:
```css
:root {
    --primary: #00ff41;      /* Matrix green */
    --secondary: #00ffff;    /* Cyan */
    --danger: #ff0040;       /* Red */
}
```

## Production Deployment Checklist

- [ ] Clone repository on VPS
- [ ] Install Docker and Docker Compose
- [ ] Set up SSL certificates (Let's Encrypt)
- [ ] Run `./setup-turn-ip.sh`
- [ ] Change TURN credentials
- [ ] Configure firewall rules
- [ ] Update `docker-compose.yml` with your domain
- [ ] Start services: `docker-compose up -d`
- [ ] Test TURN server connectivity
- [ ] Test from multiple networks

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - feel free to use for personal or commercial projects!

## Acknowledgments

- Built with [WebRTC](https://webrtc.org/)
- [Coturn](https://github.com/coturn/coturn) TURN server
- Matrix terminal aesthetic inspiration
- IRC bridge for retro chat integration

---

**Made by the BroFerence team**

For issues or questions: https://github.com/s4turns/BroFerence/issues
