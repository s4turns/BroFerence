# BroFerence — WebRTC Video Conferencing

**Live demo:** https://broference.cam/

<img width="1913" height="910" alt="image" src="https://github.com/user-attachments/assets/132524df-a1e2-4266-b78b-cade81818ff8" />
<p></p>
<img width="1731" height="793" alt="image" src="https://github.com/user-attachments/assets/180e1a9a-f857-4bdb-8770-f95fbc144a55" />
<P></P>
<img width="1915" height="911" alt="image" src="https://github.com/user-attachments/assets/576e2826-c8ef-4b60-a2c6-946ec18002b5" />
<p></p>
A self-hosted, multi-participant WebRTC video conferencing app. No accounts, no third-party media servers — just a Python signaling server, dual TURN relay, and a browser client.


---

## Features

- **Multi-participant video** — Unlimited users per room (mesh topology, best for ≤10)
- **Join with whatever you have** — No microphone or camera is fine; you join as a listener and can still see, hear, and chat
- **Real-time text chat** — In-app messaging with optional IRC bridge
- **Password-protected rooms** — PBKDF2-HMAC-SHA256 hashed, per-room
- **Noise suppression** — Adjustable noise gate with adaptive noise-floor tracking, keyboard/mouse click suppression, and real-time mic level visualization
- **Microphone selector** — Switch input device live, including NVIDIA Broadcast / RTX Voice
- **Low Bandwidth Mode** — Caps video to 480p/15fps and audio to 32kbps
- **Video quality selector** — 480p, 720p, or 1080p; persists across sessions
- **Moderator controls** — Kick, hard/soft mute, rename, promote/demote co-moderators
- **Moderator succession** — Auto-transfers to next user by join order on mod disconnect
- **Admin panel** — Global IP bans, remote rename, room lock/password, room-wide broadcast
- **End-to-end encryption** — Optional AES-GCM-256 for audio, video, and screen shares; the room owner is the sole key authority
- **Speaking indicator** — Glowing ring pulses with voice activity
- **Connection quality indicator** — Signal bars showing RTT and packet loss
- **Per-user volume controls** — Independent volume per participant
- **Per-participant hide video** — Disables inbound track decoding to save CPU/GPU
- **DEFCON button** — Kill all video feeds instantly
- **Screen share as its own tile** — The shared screen joins the grid as a separate tile with desktop audio, while your camera keeps running; one presenter at a time
- **Hardware codec preference** — H.264 → VP9 → AV1 → VP8
- **Gravatar avatars** — Set your email in Options; shared peer-to-peer automatically
- **Nickname persistence** — Display name saved and auto-filled on return
- **Spotlight mode** — Click any video to fullscreen it
- **Theme selector** — Tron (default), Matrix, Cyberpunk, Ocean, Sunset, Amber, Corporate
- **Mobile optimized** — Tap-to-unmute, auto noise suppression on mobile
- **IRC bridge (on-demand)** — Bridge rooms to IRC channels when needed
- **Multi-domain SSL** — Auto-discovers Let's Encrypt certs across domains
- **Dual TURN relay** — Two independent coturn servers, ordered per client by a real latency probe, no third-party TURN needed
- **Relay-only ICE** — Participant IPs are never exposed to other participants
- **Echo cancellation, noise suppression, auto gain control** — Built-in audio enhancements

---

## Quick Start

### Local Development

**Windows:**
```bat
scripts\start-local-dev.bat
```

**Linux/Mac:**
```bash
chmod +x scripts/start-local-dev.sh && ./scripts/start-local-dev.sh
```

Opens at **http://localhost:8080**

---

### Production Deployment

**Prerequisites:** Docker, Docker Compose, a domain with DNS pointed at your server, SSL certificates (Let's Encrypt recommended).

**1. Install Docker**

Docker Engine ships with the Compose plugin — one install covers both:

```bash
# Debian / Ubuntu (and most other distros)
curl -fsSL https://get.docker.com | sh

# Verify
docker --version
docker compose version
```

For other platforms or a manual package install, see the [official Docker install docs](https://docs.docker.com/engine/install/). To run Docker without `sudo`, add your user to the docker group: `sudo usermod -aG docker $USER` (log out and back in to take effect).

**2. Clone the repo**
```bash
git clone https://github.com/s4turns/BroFerence.git
cd BroFerence
```

**3. Get SSL certificates**
```bash
apt install certbot
certbot certonly --standalone -d yourdomain.com
```

**4. Deploy**
```bash
bash scripts/update-vps.sh
```

`scripts/update-vps.sh` handles everything in one shot:
- Pulls latest code
- Generates a new random TURN credential
- Auto-detects your server's public IP
- Updates TURN config and client JS
- Rebuilds and restarts all Docker containers
- Syncs fail2ban config if installed

**5. (First time) Set up fail2ban**
```bash
sudo bash scripts/setup-fail2ban.sh
```

**6. Open firewall ports**

| Port | Protocol | Purpose |
|------|----------|---------|
| 22 | TCP | SSH |
| 443 | TCP | HTTPS |
| 8080 | TCP | HTTP (redirects to HTTPS) |
| 8765 | TCP | WebSocket signaling |
| 8767 | UDP | WebTransport/QUIC signaling (optional) |
| 3479 | TCP+UDP | TURN |
| 49152–65535 | UDP | TURN relay |

`ufw allow 8767/udp comment 'BroFerence WebTransport'`

Port 8767 is optional. If it is closed the app still works — clients just fall
back to WebSocket signaling on 8765. See [Signaling transport](#signaling-transport).

---

## Signaling transport

Signaling can travel over either a WebSocket (`wss://host:8765`) or WebTransport
over HTTP/3 (`https://host:8767/signaling`). **Media is unaffected either way** —
audio and video always ride WebRTC/SRTP through the coturn relays, and none of
that changes when the signaling transport does.

Pick a mode under **Options → Signaling**:

| Mode | Behaviour |
|------|-----------|
| `Auto` (default) | Try QUIC, fall back to WebSocket on failure or timeout |
| `QUIC` | Force WebTransport; fail with an error rather than downgrade |
| `WebSocket` | Force WSS; never touch UDP 8767 |

The status bar shows which transport is actually carrying the session.

**Browser support.** Chrome/Edge 97+ and Firefox 114+ support WebTransport.
Safari and all iOS browsers do not, so they use WebSocket via `Auto` — which is
exactly the pre-existing behaviour — and the `QUIC` option is disabled for them.
Networks that block outbound UDP also fall back. After a QUIC failure the client
stops retrying it for five minutes rather than paying the timeout on every
reconnect.

**Certificate.** WebTransport requires a publicly trusted certificate. The
existing Let's Encrypt chain works as-is. For a self-signed dev box, launch
Chrome with `--origin-to-force-quic-on=host:8767` and
`--ignore-certificate-errors-spki-list=<base64 SPKI>`.

**Server config.** `QUIC_PORT` (default `8767`) and `QUIC_ENABLED` (set to `0`
to disable) are read from the environment. If the QUIC listener cannot start,
the server logs it and carries on serving WSS.

**Verifying QUIC is really in use.** In DevTools → Network the `/signaling`
request shows protocol `h3`; `chrome://net-export` records a `QUIC_SESSION` to
port 8767; and the server logs `transport=quic` for that client. On the VPS,
`ss -lunp | grep 8767` shows the UDP socket bound.

> **Docker note:** confirm the server logs the client's real IP, not a `172.x`
> bridge address. If Docker's userland proxy rewrites the UDP source address,
> IP bans stop working for QUIC peers. Fix with `{"userland-proxy": false}` in
> `/etc/docker/daemon.json`.

---

## Components

### Signaling Server (`server/`)
Python + WebSockets. Handles room management, WebRTC offer/answer/ICE relay, password protection, IRC bridge, and SSL cert discovery.

### TURN Servers (`config/`)
Two independent Coturn instances for asymmetric relay — covers same-NAT hairpin without a third-party provider. Credentials auto-rotate on every deploy.

### Web Client (`client/`)
Vanilla JS + WebRTC API. No frameworks. Mesh peer connections, dynamic video grid, audio worklet noise gate, E2E encryption worker.

A screen share does not replace the sharer's camera. It opens a second, send-only peer connection per viewer, carrying the screen video and desktop audio, and renders as its own tile. Screen offers/answers/candidates reuse the normal signaling relay, tagged with `channel: 'screen'` inside the payload. The sharer always offers and the viewer always answers on that channel, so it cannot collide with the camera mesh's negotiation.

---

## Usage

### Joining a Room

1. Open the app in your browser
2. Enter your name (auto-filled from last visit)
3. Enter a room name
4. Optionally set a room password or IRC channel
5. Click **Continue** → configure camera/mic → **Join Room**

If you have no microphone or camera — or you have blocked access, or another app is holding
the device — the prejoin screen says so and **Join Room** stays enabled. You join as a
listener: you see and hear everyone, show up in the grid as an avatar tile, and can chat.

### Invite Links

```
https://yourdomain.com/?room=RoomName
https://yourdomain.com/?room=RoomName&name=YourName
```

### Controls

| Control | Action |
|---------|--------|
| Mic | Mute/unmute your microphone |
| Camera | Camera on/off |
| Screen | Share screen (with optional desktop audio) — appears as its own tile |
| Chat | Toggle chat sidebar |
| Options | Options panel |
| Click video | Spotlight/fullscreen that tile |
| Hover video | Volume slider for that participant, or for a shared screen's audio |

### Options Panel

- Change name mid-call
- Gravatar email
- Noise suppression + gate threshold
- Low Bandwidth Mode
- Video quality (480p / 720p / 1080p)
- Theme selector
- Copy invite link
- DEFCON (all video off/on)
- E2E Encryption (moderator only)
- Leave room

### Connection Quality

Signal bars in the bottom-right of each video tile:

| Bars | Colour | Meaning |
|------|--------|---------|
| 4 | Green | Excellent (RTT < 100ms, loss < 1%) |
| 3 | Green | Good |
| 2 | Yellow | Fair |
| 1 | Red | Poor |

Hover the bars for exact RTT and packet loss numbers.

---

## Configuration

### TURN Server

TURN credentials are auto-rotated by `scripts/update-vps.sh` on every deploy. To manually set credentials, edit `config/turnserver.production.conf`:

```conf
user=webrtc:YOUR_STRONG_PASSWORD
realm=yourdomain.com
external-ip=YOUR_PUBLIC_IP
```

And update `PRIMARY_TURN_CREDENTIAL` in `client/conference.js` to match.

### Second TURN Server

A second independent Coturn instance at a separate IP improves relay coverage. Configure its IP in the `turn2Config` block in `client/conference.js`:

```javascript
const turn2Config = {
    urls: ['turn:YOUR_SECOND_TURN_IP:3479', 'turn:YOUR_SECOND_TURN_IP:3479?transport=tcp'],
    username: 'webrtc',
    credential: 'YOUR_SECOND_CREDENTIAL'
};
```

### SSL Certificates

The signaling server auto-discovers certs in priority order:

1. `./ssl/` — local/custom certs
2. `/etc/letsencrypt/live/` — Let's Encrypt (all domains scanned)
3. `/etc/ssl/` — system fallback

Supported filenames: `fullchain.pem` / `cert.pem` / `certificate.pem` and `privkey.pem` / `key.pem` / `private.pem`.

### IRC Bridge

On-demand only — no IRC connection is made unless a user specifies a channel on room creation. To configure the IRC server, edit `server/irc_bridge.py` (default: no server configured).

---

## Security

### Layers

| Layer | What it does |
|-------|-------------|
| Cloud firewall (Linode/etc.) | Drops traffic before it reaches the server |
| iptables | Host-level INPUT DROP policy, rate-limited SSH, DOCKER-USER WebSocket flood limiting |
| fail2ban | Bans IPs after repeated SSH / nginx / TURN auth failures |
| PBKDF2 room passwords | 260k iterations, random salt — not reversible |
| E2E encryption | Optional AES-GCM-256 for audio/video streams |
| TURN credential rotation | New random 32-char credential on every deploy |

### fail2ban Jails

| Jail | Watches | Bans after |
|------|---------|-----------|
| `sshd` | `/var/log/auth.log` | 5 failures / 10 min → 24h ban |
| `nginx-botsearch` | nginx access log | 10 hits / 1 min → 1h ban |
| `nginx-req-limit` | nginx error log | 10 hits / 1 min → 1h ban |
| `coturn-auth` | TURN log | 10 failures / 1 min → 1h ban |

### iptables (INPUT chain)

```
loopback         → ACCEPT
ESTABLISHED      → ACCEPT
SSH :22          → ACCEPT (rate-limited: 4 new/min)
HTTPS :443       → ACCEPT
HTTP  :8080      → ACCEPT
WS    :8765      → ACCEPT
TURN  :3479 TCP  → ACCEPT
TURN  :3479 UDP  → ACCEPT
Relay :49152-65535 UDP → ACCEPT
everything else  → DROP
```

DOCKER-USER: rate-limits new WebSocket connections to 20/min per IP.

---

## Helper Scripts

| Script | Purpose |
|--------|---------|
| `scripts/update-vps.sh` | Full deploy: pull, rotate TURN creds, rebuild containers, sync fail2ban |
| `scripts/setup-fail2ban.sh` | Install and configure fail2ban (run as root, first time only) |
| `scripts/setup-turn-ip.sh` | Manually set TURN `external-ip` in config |
| `scripts/test-turn-server.sh` | Diagnose TURN server connectivity |
| `scripts/start-local-dev.sh` / `.bat` | Start local dev server |

All scripts are generic — no hardcoded hostnames or paths. They auto-detect from their environment or accept overrides via environment variables:

```bash
# setup-fail2ban.sh
REPO_DIR=/opt/BroFerence APP_USER=myuser sudo bash scripts/setup-fail2ban.sh

# setup-turn-ip.sh
./scripts/setup-turn-ip.sh yourdomain.com

# test-turn-server.sh
HOSTNAME=yourdomain.com TURN_PORT=3479 bash scripts/test-turn-server.sh
```

---

## Project Structure

```
BroFerence/
├── client/
│   ├── app.html               # Main conference UI
│   ├── conference.js          # WebRTC logic, ICE, media, UI
│   ├── icons.js               # Inline SVG icon set (no emoji, no icon font)
│   ├── e2ee-worker.js         # AES-GCM-256 E2E encryption worker
│   ├── noise-processor.js     # Audio worklet noise gate (DSP, no ML)
│   ├── styles.css             # Retro terminal themes
│   └── admin.html             # Admin panel
├── server/
│   ├── signaling_server_v2.py # Production WSS server
│   ├── signaling_server_local.py # Local WS server (no SSL)
│   └── irc_bridge.py          # IRC bridge integration
├── config/
│   ├── turnserver.production.conf  # Production TURN config (auto-updated by deploy)
│   └── turnserver.conf             # Dev/local TURN config
├── fail2ban/
│   ├── jail.local             # fail2ban jail definitions
│   └── filter.d/
│       ├── coturn-auth.conf   # TURN auth failure filter
│       └── nginx-req-limit.conf # Nginx rate limit filter
├── scripts/
│   ├── update-vps.sh          # Deploy script
│   ├── update-dev.sh          # Dev-host redeploy (invoked by update-vps.sh)
│   ├── setup-fail2ban.sh      # fail2ban setup (run as root)
│   ├── setup-turn-ip.sh       # TURN IP config helper
│   ├── test-turn-server.sh    # TURN diagnostic
│   ├── docker-entrypoint.sh   # Web container entrypoint (SSL cert resolution)
│   ├── install-services.sh    # systemd install (non-Docker deployments)
│   └── start-local-dev.sh/.bat, start.sh/.bat, stop.sh/.bat, check-status.bat
├── docs/
│   ├── AUTOSTART.md           # Windows autostart guide
│   ├── FEATURES.md            # Feature reference
│   ├── test-guide.html        # Manual test guide
│   └── debug-hostname.html    # Hostname/WebSocket debug page
├── systemd/                   # Unit files for install-services.sh
├── ssl/                       # SSL certificates (gitignored)
├── logs/                      # Container log mounts for fail2ban (gitignored)
├── docker-compose.yml
└── Dockerfile.web
```

---

## Troubleshooting

**WebSocket won't connect**
```bash
docker compose logs signaling
docker compose ps
```

**Video slow to connect or not connecting**
- Run `./scripts/test-turn-server.sh` to verify TURN is reachable
- Check `external-ip` in TURN config matches your server's actual public IP
- Verify relay ports 49152–65535 UDP are open in your firewall

**TURN relay shows wrong IP**
```bash
# scripts/update-vps.sh auto-fixes this on deploy, or manually:
./scripts/setup-turn-ip.sh yourdomain.com
grep external-ip config/turnserver.production.conf
```

**fail2ban not starting**
```bash
# Ensure log dirs exist (scripts/setup-fail2ban.sh creates them, or manually):
sudo mkdir -p /path/to/BroFerence/logs/nginx /path/to/BroFerence/logs/coturn
sudo systemctl restart fail2ban
sudo fail2ban-client status
```

**Browser cache issues**
```
Ctrl+Shift+N  # Incognito/private window
F12 → Network → Disable cache
```

**Full container rebuild**
```bash
docker compose down -v
docker compose build --no-cache --pull
docker compose up -d
```

---

## Browser Compatibility

| Browser | Support |
|---------|---------|
| Chrome / Edge 90+ | ✅ |
| Firefox 88+ | ✅ |
| Safari 14.1+ | ✅ |
| Opera 76+ | ✅ |
| Internet Explorer | ❌ |

Requires: WebRTC, WebSocket, `getUserMedia`, `getDisplayMedia`, AudioWorklet.

---

## Development

### Linting

```bash
# JavaScript (run from the repo root — the flat config lives there)
npx eslint .

# Python
pip install flake8
cd server && flake8 *.py --max-line-length=120
```

ESLint config is `eslint.config.js` at the repo root. It hand-maintains its browser/worker
globals list rather than pulling in the `globals` package, so a newly used Web API has to be
added there or it shows up as a `no-undef` error. `client/lib/` is ignored — it is generated
Emscripten output for RNNoise, not hand-written code.

**Current status** (2026-09-04):

| Linter | Errors | Warnings |
|--------|--------|----------|
| ESLint (`.`) | 0 | 143 |
| flake8 (`server/*.py`) | 0 | 0 |

All 143 ESLint warnings are `no-console` (142 in `client/conference.js`, 1 in `client/icons.js`).
The rule is deliberately set to `warn` rather than `error` — console logging is how the client
reports ICE/TURN negotiation state, and those logs are the primary tool for debugging connection
failures in the field. Errors are expected to stay at zero; warnings are not tracked.

**Dependencies (Python):**
- `websockets>=12.0`
- `cryptography>=41.0.0`

```bash
pip install -r server/requirements.txt
```

---

## Recent Updates

### v2.3 (2026-08-29)
- **Signaling transport is selectable on the prejoin screen** — The Auto/QUIC/WebSocket choice now sits alongside the mic and camera pickers on the setup screen, so it can be set before joining rather than only from the in-call Options menu. The two controls stay synchronised, matching how low-bandwidth mode already works in both places
- **Quieter signaling logs** — aioquic logs version negotiation, ALPN, and several duplicate-CRYPTO lines per connection at INFO, which put multiple lines in the shared signaling log for every join. Handshake detail is now suppressed; warnings and errors still surface

### v2.2 (2026-08-28)
- **Signaling can run over QUIC** — Signaling may now travel over WebTransport/HTTP-3 (UDP 8767) instead of a WebSocket, selectable under Options &rarr; Signaling as Auto, QUIC, or WebSocket. Auto tries QUIC and falls back to WebSocket on failure or timeout, so a blocked UDP path or an older browser changes nothing. The status bar shows which transport is actually in use
- **Media is untouched** — Audio and video still ride WebRTC/SRTP through the coturn relays. Only the signaling channel moved, so call quality and the relay-only privacy model are unchanged
- **Safari keeps working as before** — Safari and iOS have no WebTransport, so they use WebSocket under Auto and the QUIC option is disabled for them. After a QUIC failure the client stops retrying it for five minutes rather than paying the timeout on every reconnect
- **Fixed a signaling connection that could never reconnect** — If the channel opened and then closed before the server confirmed registration, the connect promise settled neither way, so the reconnect loop waited forever and the client stayed offline until a manual refresh
- **A bad signaling message no longer silently disappears** — Errors thrown while handling one became unhandled promise rejections that dropped the message mid-way through updating state; they are now caught and logged

### v2.1 (2026-08-19)
- **Fixed Safari and iOS never being prompted** — WebKit only shows the camera/microphone prompt while the click that opened the prejoin screen still counts as user activation. v2.0 checked the device list first, which spent that activation before asking, so the prompt never appeared. The request now goes out before anything else and the device probe only runs if it fails
- **In-app browsers are detected** — A link opened inside Instagram, Facebook, TikTok or WeChat cannot get camera or mic at all. The prejoin screen now says so and tells you to open it in Safari or Chrome, instead of appearing to hang
- **Unanswered prompts point at the address bar** — Chrome shows a small icon instead of a dialog for people who often block permissions, which reads as "it never asked me". After a few seconds the prejoin screen names the icon to look for
- **Blocked and dismissed are told apart** — A standing block gets unblock instructions; a dismissed prompt is told to reload. Previously both got the same message
- **Insecure origins are named** — Loading over plain HTTP now explains that as the reason devices are unavailable

### v2.0 (2026-08-19)
- **Fixed invisible tile buttons** — Volume and hide controls on video tiles render and respond correctly
- **Dev environment matches prod** — Serves on 443/8765 instead of 8443/8766
- **Screen share waits for the presenter slot** — No more broadcasting into a slot the server has not granted
- **Restart warning** — A deploy broadcasts a 60-second countdown to everyone in a call before containers go down, on dev as well as prod
- **Owner-only encryption authority** — The room owner is the sole E2EE key authority; keys are regenerated when ownership changes
- **IRC bridge reconnects reliably** — Connects to the hostname its certificate covers and registers under a nickname the network accepts
- **Join without a mic or camera** — Devices are requested individually and the app keeps whatever the browser gives it, so a missing, blocked, or busy camera no longer costs you your microphone. With neither, you join as a listener: you see and hear everyone, appear in the grid as an avatar tile, and can chat
- **Prejoin explains itself** — Says whether a device is missing, blocked, or in use by another app, and how to fix it, instead of a dead-end alert. Controls for absent devices are disabled rather than inert
- **Auto-reload after a restart** — When the countdown expires the page waits for the server to answer again and then reloads itself. It cannot reload on the spot: the containers are going down as the countdown ends and the rebuild takes a couple of minutes, so an immediate reload would just hit a connection error. After ten minutes with no answer it stops and says so rather than reloading into an error page
- **No more stale pages after a deploy** — The web server sent no cache headers for HTML, so browsers kept serving an old `app.html`, including the old version number in the corner, after a successful update. The `?v=<commit>` stamping only ever covered the assets `app.html` references, never `app.html` itself. HTML is now `no-cache`
- **Chat button no longer boxes its own icon** — A header rule meant for bare spans was giving the icon wrapper the button's border and padding, drawing a second box inside the button

### v1.9 (2026-08-18)
- **Screen share gets its own tile** — A share no longer replaces your camera. It rides a dedicated send-only peer connection and joins the grid as a separate tile, so people see your face and your screen at once
- **Screen audio is separate** — Desktop audio travels with the screen tile and has its own volume/mute, so muting someone's screen no longer mutes their voice. Replaces the old mic/desktop mixer, which existed only because there was a single audio sender
- **One presenter at a time** — Tracked server-side, released automatically if the presenter leaves or crashes
- **E2EE covers screen shares** — Encryption transforms are applied to the screen connections too
- **Camera throttled while presenting** — Drops to ~400 kbps at half resolution, since camera + screen to every peer is a lot of relayed uplink
- **SVG icons throughout** — Replaced ~80 emoji with inline stroke icons that inherit each theme's colour
- **Renamed "AI Noise Suppression" to "Noise suppression"** — It never used a model; it is a DSP noise gate

### v1.8 (2026-05)
- **New domain** — Migrated to broference.cam
- **TURN realm** — Updated to broference.cam across all configs
- **fail2ban** — SSH, nginx, and TURN jails with log volume mounts from containers
- **iptables** — INPUT DROP policy, rate-limited SSH, DOCKER-USER WebSocket flood protection
- **Generic scripts** — All setup scripts now auto-detect hostname/paths, no hardcoded values

### v1.7 (2026-04-26)
- **Gravatar support** — Hashed client-side, broadcast peer-to-peer
- **Nickname persistence** — Saved to localStorage, auto-filled on return
- **Video quality selector** — 480p / 720p / 1080p, persists across sessions
- **Options menu consolidation** — Invite, DEFCON, bug report moved into options panel
- **Room name in tab title**
- **Dual coturn relay** — Replaced Metered.ca dependency with second self-hosted coturn

### v1.6 (2026-04-01)
- **Per-participant hide video** — Disables inbound track decoding to save CPU/GPU
- **DEFCON button** — Kill all video feeds at once
- **Screen share audio mixer** — Independent mic/desktop audio sliders
- **Hardware codec preference** — H.264 → VP9 → AV1 → VP8
- **Corporate theme**
- **AI Noise Suppression off by default**
- **PBKDF2 password hashing** — PBKDF2-HMAC-SHA256, 260k iterations
- **XSS hardening** — All user strings sanitized before DOM insertion

### v1.5 (2026-03-25)
- **Low Bandwidth Mode** — 480p/15fps, capped bitrates
- **Moderator succession** — Auto-transfers on mod disconnect
- **iOS/Safari fix** — Zero relay candidate fallback to P2P
- **WebSocket reconnect** — Preserves already-connected peers

### v1.4 (2026-03-25)
- **ICE restart on disconnect** — Triggers after 6s, fixes silent dead connections
- **WebSocket auto-reconnect** — Exponential backoff (2s → 30s)
- **Cache-busting** — Git commit hash stamped on asset URLs

### v1.3 (2026-02-18)
- **Microphone device selector** — Switch live, supports NVIDIA Broadcast / RTX Voice
- Fixed scratchy audio from `Math.exp` in audio worklet hot path
- Fixed outgoing audio distortion and mobile glitchy audio

### v1.2 (2026-02)
- **AI Noise Suppression** — Adjustable noise gate with mic level viz
- **Per-user volume controls**
- **Theme selector** — 5 themes
- **Screen share with audio**
- **E2E encryption** — AES-GCM-256 (moderator-controlled)

### v1.1 (2026-02)
- Multi-domain SSL certificate auto-discovery
- On-demand IRC bridge
- Dynamic hostname detection in update script

### v1.0 (2026-01)
- Initial release — multi-participant video, TURN server, IRC bridge, Matrix UI

---

[GitHub](https://github.com/s4turns/BroFerence) · [Issues](https://github.com/s4turns/BroFerence/issues)
