# Changelog

## v2.3 — 2026-03-25

### Bug Fixes
- **Fix intermittent "can't see/hear" after extended sessions** — the root cause was that WebRTC `connectionState: disconnected` was never recovered. Some browsers (Firefox, Safari, mobile) stay in `disconnected` rather than transitioning to `failed`, so ICE restart was never triggered. Now an ICE restart is attempted after 6 seconds of `disconnected`, with removal only after 30 seconds if recovery fails.
- **Add WebSocket auto-reconnect** — if the signaling server connection drops (proxy timeout, brief server restart, network blip), the client now automatically reconnects with exponential backoff (2 s → 4 s → 8 s, capped at 30 s). The local camera/mic stream is preserved; peer connections are re-established automatically after rejoining the room. Intentional disconnects (Leave Room, kicked, banned) still perform a full cleanup.
- **Fix username showing as "User" after reconnect** — when a peer connection was torn down and re-established, the display name was lost. A persistent `knownUsernames` map now ensures the correct name is used when a reconnection offer arrives.

### Other Changes
- **Cache-busting for static assets** — `app.html` now includes `?v=DEV` on CSS/JS links; `update-vps.sh` replaces this with the actual git commit hash on each VPS deploy, ensuring browsers always load the latest client files after an update.

---

## v2.2

- Signal bars with RTT / packet-loss stats overlay on each video tile
- Fix moderator promotion: actually transfer mod role
- Fix P2P fallback: responder also switches off relay-only after TURN failure
- TURN relay-first with P2P fallback ICE strategy
- Fix ICE restart storm: add throttle, backoff, and limit
- Force relay-only ICE transport to prevent IP leakage

## v2.1

- Multi-participant support (mesh topology)
- IRC chat bridge
- Password-protected rooms
- Moderator controls (kick, ban, rename, promote)
- AI noise suppression (RNNoise)
- Noise gate with threshold slider
- Keyboard / mouse click suppression
- Spotlight mode (click any tile to enlarge)
- Remote volume / mute per participant
- Screen sharing with system audio mixing
- Watch Together (YouTube / video URL streaming)
- Theme selector (Matrix, Cyberpunk, Ocean, Sunset, Amber)
- Debug console panel with connection/ICE/peer state
- Mobile responsive layout
