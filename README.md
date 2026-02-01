# BroFerence - WebRTC Video Conferencing

<img width="3619" height="1495" alt="image" src="https://github.com/user-attachments/assets/e95c0c68-902e-4da1-8c89-64aebf583044" />


<img width="2935" height="1289" alt="image" src="https://github.com/user-attachments/assets/f85f908d-6d29-4bb0-bc46-c7100b82a345" />


<img width="3613" height="1498" alt="image" src="https://github.com/user-attachments/assets/df0287f0-5607-438e-b268-3113f3887c5f" />


A complete multi-participant WebRTC video conferencing application with Python signaling server, TURN server, and IRC chat bridge.

## Features

- **Multi-participant video conferencing** - Unlimited users per room
- **Real-time text chat** - In-app messaging with IRC bridge support
- **Password-protected rooms** - Secure your private meetings
- **Audio enhancements** - Echo cancellation, noise suppression, auto gain control
- **Speaking indicator** - Glowing ring shows who's talking
- **Connection quality indicator** - Signal bars showing RTT and packet loss
- **User avatars** - Shows user initial when video is off
- **Spotlight mode** - Click any video to fullscreen it
- **Screen sharing** - Share your screen with participants
- **Mobile optimized** - Tap-to-unmute for mobile browsers
- **Dynamic configuration** - Auto-detects localhost vs production
- **Retro terminal aesthetic** - Matrix-style green on black UI
- **IRC bridge (on-demand)** - Connect conference rooms to IRC channels when needed
- **Multi-domain SSL support** - Auto-discovers certificates from multiple locations
- **Easy deployment** - Docker support with one-command setup
- **Portable configuration** - Uses system hostname, works anywhere

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
- **Invite** - Copy invite link to clipboard
- **Leave Room** - Exit the conference
- **Spotlight** - Click any participant's video to fullscreen it

### Invite Links

Share a direct link to join a specific room:
```
https://your-domain.com/app.html?room=MyRoom
```

You can also include a suggested username:
```
https://your-domain.com/app.html?room=MyRoom&name=Guest
```

Click the **Invite** button in the header to copy the current room's invite link.

### Connection Quality

Each participant's video shows a **signal bar indicator** (like cell phone reception) in the bottom-right corner:
- **4 bars (green)** - Excellent connection (RTT < 100ms, loss < 1%)
- **3 bars (green)** - Good connection
- **2 bars (yellow)** - Fair connection
- **1 bar (red)** - Poor connection

Hover over the signal bars to see detailed stats (RTT in ms and packet loss %).

### User Avatars

When a participant turns off their camera, their video shows a **circular avatar** with their first initial instead of a black box.

### Speaking Indicator

When someone speaks, their video gets a **glowing cyan ring** that pulses with their voice. This works automatically using real-time audio level detection.

### Audio Quality

All audio streams have built-in enhancements:
- **Echo Cancellation** - Removes feedback
- **Noise Suppression** - Filters background noise
- **Auto Gain Control** - Normalizes volume levels

## Configuration

### SSL Certificates

The server automatically discovers SSL certificates from multiple locations (in priority order):

1. **`./ssl/`** - Local certificates (for custom or development certs)
2. **`/etc/letsencrypt/live/`** - Let's Encrypt certificates (scans all domains)
3. **`/etc/ssl/`** - System certificates (fallback)

**Supported certificate filenames:**
- Certificate: `fullchain.pem`, `cert.pem`, `certificate.pem`
- Key: `privkey.pem`, `key.pem`, `private.pem`

**Wildcard certificates work perfectly!** The server will log all covered domains on startup.

**Docker Setup:**
```bash
# Place your certificates in the ssl/ folder
cp /path/to/your/fullchain.pem ssl/
cp /path/to/your/privkey.pem ssl/
```

The Docker container mounts `./ssl/` to `/app/ssl/` and automatically uses those certificates.

**Certificate Details in Logs:**
```
✓ Found SSL certificates in /app/ssl: fullchain.pem, privkey.pem
======================================================================
SSL CERTIFICATE DETAILS:
  Issuer: Let's Encrypt Authority X3
  Domains covered (3):
    • *.yourdomain.com
    • yourdomain.com
    • www.yourdomain.com
  Valid from: 2026-01-15 08:30:00 UTC
  Valid until: 2026-04-15 08:30:00 UTC
  Days until expiry: 73
======================================================================
```

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

### IRC Bridge (On-Demand)

The IRC bridge **only connects when you specify an IRC channel** - no automatic connections at startup.

To bridge a room to IRC:
1. Edit `server/signaling_server_v2.py` to configure IRC server (lines 34-38)
2. When creating a room, enter IRC channel (e.g., `#mychannel`)
3. IRC bridge connects automatically when first channel is specified
4. Messages sync bidirectionally between WebRTC and IRC

**Server logs when IRC connects:**
```
IRC channel specified (#mychannel), initializing IRC bridge...
✓ IRC bridge connected successfully
```

This saves resources - the IRC connection is only made when actually needed!

## Helper Scripts

### `setup-turn-ip.sh`
Auto-configures TURN server with your public IP address.

### `update-vps.sh`
One-command update script:
- Pulls latest code from GitHub
- Generates new TURN password
- Auto-detects external IP and hostname
- Rebuilds Docker containers with latest changes
- Restarts all services
- Shows service URLs with your actual hostname (portable for any deployment)

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

## Development

### Code Quality

All Python code is linted with **flake8** and follows PEP 8 style guidelines.

**Run linting locally:**
```bash
cd server
pip install flake8
flake8 *.py --max-line-length=120
```

**JavaScript linting:**
```bash
cd client
npm install --save-dev eslint
npx eslint *.js
```

### Dependencies

**Python (server/):**
- `websockets>=12.0` - WebSocket server
- `cryptography>=41.0.0` - SSL certificate parsing

**Install:**
```bash
pip install -r server/requirements.txt
```

## Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run linting checks
5. Test thoroughly
6. Submit a pull request

## License

MIT License - feel free to use for personal or commercial projects!

## Acknowledgments

- Built with [WebRTC](https://webrtc.org/)
- [Coturn](https://github.com/coturn/coturn) TURN server
- Matrix terminal aesthetic inspiration
- IRC bridge for retro chat integration

## Recent Updates

### v2.0 (2026-02)
- ✨ Multi-domain SSL certificate auto-discovery
- ✨ On-demand IRC bridge (only connects when needed)
- ✨ Verbose SSL certificate logging with domain info
- ✨ Dynamic hostname detection in update script
- 🎨 BLCKND branding in status footer
- 🐛 Fixed all linting issues (flake8 clean)
- 📝 Improved code documentation

### v1.0 (2026-01)
- 🎉 Initial release
- Multi-participant video conferencing
- TURN server integration
- IRC chat bridge
- Matrix-style retro UI

---

**Powered by BLCKND** | [GitHub](https://github.com/s4turns/BroFerence)

For issues or questions: https://github.com/s4turns/BroFerence/issues
