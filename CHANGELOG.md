# Changelog

## v2.4 — 2026-03-31

### Performance
- **Fix extreme CPU usage from body-wide flicker animation** — the terminal flicker effect was animating opacity on the entire `<body>` every 150 ms, forcing full-page repaints over every video element. Moved the effect to a GPU-composited `::after` pseudo-element with `will-change: opacity` so it no longer triggers layout or paint on child nodes.
- **Replace box-shadow speaking animation with GPU-friendly transform** — the speaking-pulse keyframes were animating multi-layer `box-shadow`, which cannot be composited and forces repaints per frame. Replaced with a `transform: scale()` animation that runs entirely on the compositor thread.
- **Reduce audio-level monitoring overhead** — all per-stream audio monitors now share a single `AudioContext` instead of creating one each, and the polling interval was increased from 100 ms to 250 ms (60 % fewer FFT operations per second).
- **Default video to 720p / 24 fps** — desktop capture constraints changed from 1080p / 30 fps to 720p / 24 fps (`max` still allows 1080p / 30 fps). Significantly reduces encode/decode CPU load in multi-party calls.
- **Prefer H.264 codec for hardware acceleration** — video transceivers now call `setCodecPreferences()` to favour H.264, which has hardware encode/decode on Apple Silicon. VP8/VP9 fall back to software-only decoding on macOS.

---

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
