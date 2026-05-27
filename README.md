# BroFerence - WebRTC Video Conferencing

LIVE DEMO: https://broference.cam/ https://blcknd.net/

<img width="1077" height="721" alt="image" src="https://github.com/user-attachments/assets/da9df2b7-5a0e-40eb-8f03-ed3132c300d0" />

<img width="3380" height="1551" alt="image" src="https://github.com/user-attachments/assets/8719147f-69ba-4efa-b974-d35924090e3b" />

A complete multi-participant WebRTC video conferencing application with Python signaling server, dual TURN servers, and IRC chat bridge.

## Features

- **Multi-participant video conferencing** - Unlimited users per room
- **Real-time text chat** - In-app messaging with IRC bridge support
- **Password-protected rooms** - Secure your private meetings
- **YouTube/Video streaming** - Share YouTube videos or direct video URLs with participants (Watch Together)
- **AI Noise Suppression** - Adjustable noise gate with real-time mic level visualization (off by default, enable via options)
- **Microphone Selector** - Switch input device live, including NVIDIA Broadcast / RTX Voice
- **Low Bandwidth Mode** - Reduces video to 480p/15fps and caps bitrate for mobile or slow connections
- **Video Quality Selector** - Choose 480p, 720p, or 1080p output from the Options menu (persisted across sessions)
- **Moderator controls** - Room owner can kick, mute, rename, and promote/demote co-moderators
- **Moderator succession** - Moderator role auto-transfers to the next user by join order when mod leaves
- **Audio enhancements** - Echo cancellation, noise suppression, auto gain control
- **Speaking indicator** - Glowing ring shows who's talking
- **Connection quality indicator** - Signal bars showing RTT and packet loss
- **Per-user volume controls** - Adjust volume for each participant individually
- **Per-participant hide video** - Hide any remote stream with one click; disables track decoding to save CPU/GPU
- **DEFCON button** - Toggle all video feeds off/on instantly (in Options menu)
- **Screen share audio mixer** - Independent mic and desktop audio sliders when sharing with audio
- **Hardware codec preference** - Prefers H.264 → VP9 → AV1 → VP8 for hardware-accelerated encoding/decoding
- **Gravatar avatars** - Set your email in Options to show your Gravatar when camera is off; shared with all peers automatically
- **Nickname persistence** - Your display name is saved and auto-filled on return visits
- **Spotlight mode** - Click any video to fullscreen it
- **Screen sharing** - Share your screen with audio support
- **End-to-end encryption** - Optional AES-GCM-256 encryption for both audio and video (moderator-controlled)
- **Theme selector** - Multiple color themes (Matrix, Cyberpunk, Ocean, Sunset, Amber, Corporate)
- **Mobile optimized** - Tap-to-unmute for mobile browsers
- **Dynamic configuration** - Auto-detects localhost vs production
- **Retro terminal aesthetic** - Customizable color themes
- **IRC bridge (on-demand)** - Connect conference rooms to IRC channels when needed
- **Multi-domain SSL support** - Auto-discovers certificates from multiple locations
- **Easy deployment** - Docker support with one-command setup
- **Dual TURN relay** - Two independent coturn servers for asymmetric relay, covering same-NAT scenarios without third-party TURN

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
docker compose up -d
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

2. **TURN Servers** (Coturn × 2)
   - Two independent relay servers for asymmetric ICE paths
   - Handles same-NAT hairpin without third-party TURN
   - Credentials auto-rotated on each deploy via `update-vps.sh`

3. **Web Client** (HTML/JavaScript/CSS)
   - Browser-based video conferencing
   - Matrix-style retro UI
   - Real-time speaking indicators
   - Built-in audio enhancements

## Usage

### Joining a Room

1. Visit the app in your browser
2. Enter your name (auto-filled from your last visit)
3. Enter a room name (creates if doesn't exist)
4. Optional: Set a password for private rooms
5. Optional: Bridge to an IRC channel
6. Click "Continue" to configure audio/video, then "Join Room"
7. Grant camera/microphone permissions

### Controls

- **Mute/Unmute** - Toggle your microphone
- **Camera On/Off** - Toggle your video
- **Share Screen** - Share your entire screen with optional audio
- **Watch Together** - Stream YouTube videos or direct video URLs to all participants
- **Stop Streaming** - Stop sharing video/screen and return to camera
- **Chat** - Open/close text chat sidebar
- **Options** ☰ - Access all settings (see below)
- **Spotlight** - Click any participant's video to fullscreen it
- **Volume Control** - Hover over any participant to adjust their volume
- **Hide Video** (📹) - Click on any remote participant's controls to hide their video and stop decoding it; click again to restore

### Options Menu

The ☰ Options button opens a side panel with:

- **Change Name** - Update your display name mid-call
- **Gravatar Email** - Enter your email to show your Gravatar when camera is off
- **AI Noise Suppression** - Toggle noise gate with adjustable threshold
- **Low Bandwidth Mode** - Cap video/audio bitrates for slow connections
- **Video Quality** - Select 480p, 720p, or 1080p camera output
- **Theme** - Switch color theme
- **Copy Invite Link** - Copy a direct link to this room
- **DEFCON** - Toggle all video feeds off/on instantly
- **Report a Bug** - Open GitHub issues
- **Leave Room** - Exit the conference

### Invite Links

Share a direct link to join a specific room:
```
https://your-domain.com/app.html?room=MyRoom
```

You can also include a suggested username:
```
https://your-domain.com/app.html?room=MyRoom&name=Guest
```

### Connection Quality

Each participant's video shows a **signal bar indicator** (like cell phone reception) in the bottom-right corner:
- **4 bars (green)** - Excellent connection (RTT < 100ms, loss < 1%)
- **3 bars (green)** - Good connection
- **2 bars (yellow)** - Fair connection
- **1 bar (red)** - Poor connection

Hover over the signal bars to see detailed stats (RTT in ms and packet loss %).

### User Avatars

When a participant turns off their camera, their video shows a **circular avatar**. If they have set a Gravatar email in Options, their Gravatar image is shown; otherwise their first initial is displayed. Gravatar hashes are shared peer-to-peer so all participants see the correct avatar automatically.

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

### TURN Server Credentials

TURN credentials are automatically rotated on every `update-vps.sh` deploy. The primary server credential is updated in both `config/turnserver.production.conf` and `client/conference.js` by the deploy script. The second TURN server uses a static credential configured directly on that host.

**Manual credential update:**

Edit `config/turnserver.conf`:
```conf
user=webrtc:YOUR_STRONG_PASSWORD_HERE
```

And update the `PRIMARY_TURN_CREDENTIAL` constant in `client/conference.js`.

### Firewall Rules

Open these ports on your server:
```bash
# WebSocket signaling
sudo ufw allow 8765/tcp

# TURN server
sudo ufw allow 3479/tcp
sudo ufw allow 3479/udp

# Media relay ports
sudo ufw allow 49152:65535/udp
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

## Helper Scripts

### `setup-turn-ip.sh`
Auto-configures TURN server with your public IP address.

### `update-vps.sh`
One-command update script:
- Pulls latest code from GitHub
- Generates new TURN password and updates both the TURN config and client JS
- Auto-detects external IP and hostname
- Rebuilds Docker containers with latest changes
- Restarts all services
- Shows service URLs with your actual hostname

### `test-turn-server.sh`
Diagnostic tool to test TURN server connectivity.

### `debug-hostname.html`
Debug tool to verify dynamic URL detection.

## Troubleshooting

### WebSocket won't connect
```bash
# Check signaling server logs
docker compose logs signaling

# Verify server is running
docker compose ps
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
docker compose down -v
docker compose build --no-cache --pull
docker compose up -d
```

## Project Structure

```
BroFerence/
├── client/                        # Web client files
│   ├── app.html                   # Main conference UI
│   ├── conference.js              # WebRTC logic
│   ├── e2ee-worker.js             # End-to-end encryption worker
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
├── docker compose.yml             # Docker orchestration
├── start-local-dev.bat/.sh        # Local dev startup
├── setup-turn-ip.sh               # TURN auto-config
└── update-vps.sh                  # VPS update script
```

## Security Notes

**Default configuration is for LOCAL TESTING ONLY**

For production:
1. Change TURN credentials (rotated automatically by `update-vps.sh`)
2. Use HTTPS/WSS (not HTTP/WS)
3. Set up proper firewall rules
4. Configure `external-ip` in TURN server
5. Implement user authentication
6. Use secure room passwords
7. Keep dependencies updated

## UI Customization

### Speaking Threshold

Adjust sensitivity in `conference.js`:
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
- [ ] Configure firewall rules
- [ ] Update `docker compose.yml` with your domain
- [ ] Start services: `docker compose up -d`
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

### v1.7 (2026-04-26)
- **Gravatar support** — Enter your email in the Options menu to display your Gravatar when your camera is off. Hashed client-side with MD5 and broadcast to all peers so everyone sees each other's avatar without sharing the raw email
- **Nickname persistence** — Display name is saved to localStorage on join and name changes, auto-filled on return visits
- **Video quality selector** — Choose 480p, 720p, or 1080p camera output from the Options menu; persists across sessions, applies constraints live without rejoining
- **Options menu consolidation** — Invite, DEFCON, and Bug Report moved into the Options side panel to reduce toolbar clutter
- **Room name in browser tab** — Tab title now shows the active room name (e.g. `monkeybread - BroFerence`) instead of the generic app title
- **Uniform options menu item height** — All settings rows are a consistent 44px regardless of whether they contain a button, toggle, or select element
- **Screen share avatar fix** — Remote peers with their camera off no longer show their initials avatar overlaid on their screen share content; the avatar is now correctly hidden when screen sharing starts and restored when it stops
- **Dual coturn relay** — Removed Metered.ca TURN dependency; two independent coturn servers now handle relay using asymmetric ICE paths to avoid same-server hairpin without requiring a third-party provider

### v1.6 (2026-04-01)
- **Per-participant hide video** — 📹 button on each remote stream hides the video and disables the inbound track so the browser skips decoding entirely, reducing CPU/GPU load
- **DEFCON button** — Toggle in the toolbar kills all video feeds at once; useful when bandwidth drops or you need to go audio-only fast
- **Screen share audio mixer** — When screen sharing with system audio, a mixer strip appears on your local tile with independent 🎤 mic and 🖥️ desktop audio sliders (0–100%)
- **Hardware codec preference** — Reorders transceivers to prefer H.264 → VP9 → AV1 → VP8, enabling hardware-accelerated encode/decode where supported
- **Corporate (Teams) theme** — Flat dark design with Segoe UI, purple accent. Available in the theme selector
- **AI Noise Suppression off by default** — No longer auto-enabled on join; enable manually via the options menu
- **TURN external-ip auto-detection** — `update-vps.sh` now sets `external-ip` in coturn config using `curl -4 ifconfig.me`
- **PBKDF2 password hashing** — Room passwords now use PBKDF2-HMAC-SHA256 with a random 16-byte salt (260k iterations)
- **XSS / security hardening** — All user-controlled strings sanitized before DOM insertion; URL validation added; stack traces no longer leak in HTTP error responses
- **Stats monitoring interval leak fix** — `startStatsMonitoring` clears any existing interval before starting a new one

### v1.5 (2026-03-25)
- **Low Bandwidth Mode** — Caps video to 480p/15fps, video bitrate to 200kbps, audio to 32kbps. Toggleable from prejoin screen and Options menu
- **Moderator succession** — Mod role auto-transfers to the next user in join order when mod leaves
- **iOS/Safari connectivity fix** — Detects zero relay candidates at ICE gathering and falls back to direct P2P
- **WebSocket reconnect no longer drops healthy peers** — Preserves peers already in `connected` state on rejoin
- **Prejoin defaults** — Microphone on, camera off by default
- **Prejoin ON/OFF labels** — Mic, camera, and low bandwidth buttons show clear ON/OFF status

### v1.4 (2026-03-25)
- **ICE restart on disconnect** — `connectionState: disconnected` triggers ICE restart after 6 seconds, fixing silent dead connections on Firefox/Safari/mobile
- **WebSocket auto-reconnect** — Reconnects with exponential backoff (2s → 30s cap) on signaling server drops
- **Username preserved across reconnects** — Display names no longer reset on reconnect
- **Cache-busting** — `update-vps.sh` stamps asset URLs with the current git commit hash on each deploy

### v1.3 (2026-02-18)
- **Microphone Device Selector** — Switch input device live (supports NVIDIA Broadcast, RTX Voice, Krisp, etc.)
- **Version display** — App version shown in status bar footer
- Fixed scratchy audio from `Math.exp` in audio worklet hot path
- Fixed outgoing audio distortion during click suppression
- Fixed mobile users hearing glitchy audio

### v1.2.1 (2026-02-05)
- **Firefox Compatibility** — Fixed remote video autoplay issues
- **IRC Bridge Reconnection** — Auto-reconnect when connection drops
- **IRC Bridge DNS Fix** — Added DNS servers to Docker container
- **Video Autoplay Fix** — Remote videos start muted with unmute overlay for browser compatibility

### v1.2 (2026-02)
- **YouTube/Video Streaming** — Share YouTube videos with participants via built-in proxy
- **AI Noise Suppression** — Adjustable noise gate (1–80%) with real-time mic level visualization
- **Per-user Volume Controls** — Adjust volume for each remote participant
- **Theme Selector** — 5 color themes (Matrix, Cyberpunk, Ocean, Sunset, Amber)
- **Screen Share with Audio** — Share system audio along with screen

### v1.1 (2026-02)
- Multi-domain SSL certificate auto-discovery
- On-demand IRC bridge (only connects when needed)
- Dynamic hostname detection in update script

### v1.0 (2026-01)
- Initial release — multi-participant video conferencing, TURN server, IRC bridge, Matrix UI

---

**Powered by BLCKND** | [GitHub](https://github.com/s4turns/BroFerence)

For issues or questions: https://github.com/s4turns/BroFerence/issues
