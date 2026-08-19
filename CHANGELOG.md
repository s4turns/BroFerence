# Changelog

Versions match the number shown in the app footer and in `README.md`.

> **Note:** releases up to March 2026 were numbered v2.1–v2.3 in this file while the
> app and README used the v1.x line. Those entries have been folded into the v1.x
> versions they shipped in; v1.x is the only numbering going forward.

---

## v1.9 — 2026-08-18

### Joining

- **Join without a mic or camera.** Devices are now requested individually instead of as a
  single `getUserMedia({video, audio})` call. That call is all-or-nothing: a missing or busy
  camera rejected the whole request, so a user with a working microphone got nothing — and
  because Chrome fails fast for a device that does not exist, no permission prompt ever
  appeared, which is why it looked like the app never asked. The client now probes which
  device kinds exist, tries `audio+video` → `audio` → `video`, and keeps whatever the browser
  hands over.
- **Joining with no devices actually works.** The old fallback claimed you could still join,
  then re-ran the same failing request and stopped at "Failed to join room". A participant
  with no tracks also produced an offer with zero m-lines, so they would have received
  nothing even if they had got in; receive-only transceivers are now added for any kind that
  cannot be sent.
- **Listeners are visible.** A peer who sends no media never fires `ontrack`, so nothing put
  them in the grid. They now get an avatar tile on connect and can be moderated like anyone
  else.
- **Prejoin explains itself.** Distinguishes a missing device, blocked permission, a device
  held by another app, and a non-HTTPS origin, and says how to fix each. Controls for absent
  devices are disabled and labelled rather than silently inert, and empty device dropdowns
  read "No microphone detected" instead of rendering blank.

### Screen sharing

- **A share gets its own tile.** It rides a dedicated send-only peer connection and joins the
  grid separately, so your camera keeps running alongside it.
- **Screen audio is independent.** Desktop audio travels with the screen tile and has its own
  volume and mute, so muting someone's screen no longer mutes their voice. This replaces the
  old mic/desktop mixer, which only existed because there was a single audio sender.
- **One presenter at a time**, tracked server-side and released automatically if the presenter
  leaves or crashes.
- **Late joiners see a share already in progress.**
- **End-to-end encryption covers screen connections**, not just the camera mesh.
- **Camera is throttled while presenting** — roughly 400 kbps at half resolution, since camera
  plus screen to every peer is a lot of relayed uplink.
- **Noise suppression stays active on your microphone while sharing.**
- Fixed screen-share audio feedback, low frame rates, and late joiners not hearing the share.

### Identity and moderation

- **Unique nicknames per room.** A duplicate name renames the newcomer, never the person
  already in the room.
- **Your own tile shows your nickname and role badge** instead of "You (Local)".
- **Soft mute** — moderators can mute someone who is then able to unmute themselves.
- **Admin panel** — global IP bans that survive page refreshes, plus remote rename, room
  lock/password, and room-wide broadcast.
- **The room owner is the sole E2EE key authority**; keys are regenerated when ownership
  changes.
- Peers who joined earlier now render an avatar for users who arrive later.

### Connectivity

- **Closest TURN relay per client.** Both relays are still offered for redundancy, but the
  ordering comes from a real latency probe run while the user is on the prejoin screen.
- **Relay-only with no P2P fallback**, so participant IPs are never exposed — if both relays
  are unreachable the call does not connect, by design.
- **Stalled inbound audio self-heals**: the element is re-played, then recovered with an ICE
  restart if that is not enough.
- **Fewer drops in large calls** — fixed client CPU overload causing audio dropouts, and
  raised WebSocket keepalive timeouts so a briefly pegged client is not disconnected.

### Interface

- **Tron is now the default theme** — animated grid floor, lightcycle ribbon, glass panels.
- **SVG icons throughout** — around 80 emoji replaced with inline stroke icons that inherit
  each theme's colour.
- **"AI Noise Suppression" renamed to "Noise suppression."** It never used a model; it is a
  DSP noise gate.
- Fixed invisible buttons and click handling on video tiles, and aligned the prejoin device
  dropdowns.

### Operations

- **Restart warning, then automatic reload.** A deploy broadcasts a 60-second countdown to
  everyone in a call before containers go down (`SIGUSR1` to the signaling server;
  `update-vps.sh` waits out the same grace period). When the countdown expires the client
  polls the origin and reloads the moment it answers again — reloading immediately would
  only land on a dead server, since the rebuild that follows takes a couple of minutes.
  After ten minutes without an answer it stops and says so rather than reloading into an
  error page.
- **Fixed stale pages after a deploy.** nginx sent no cache headers for HTML, so browsers
  heuristically cached `app.html` and kept showing the previous build — including the old
  version number in the corner — even after a successful update. The `?v=<commit>`
  cache-busting only ever covered the assets *referenced by* app.html, never app.html
  itself. HTML is now served `no-cache`.
- **Dev environment** — `update-dev.sh` plus a dev compose stack, kept in lockstep with the
  TURN credential prod rotates on every deploy.
- **IRC bridge reconnects reliably** — connects to the hostname its certificate covers,
  registers under a nickname the network accepts, and handles PONG cookie echo and
  nick-in-use retries.
- Secondary TURN credential moved out of git into `.env`; cross-TURN relay peers allowed so
  calls spanning both relays are not blocked; `external-ip` no longer set on the primary
  coturn (it silently 403'd same-server relay paths).
- Dependency security bumps (`qs`, `follow-redirects`, `brace-expansion`).

---

## v1.8 — 2026-05

- Migrated to broference.cam; TURN realm updated to match
- fail2ban jails for SSH, nginx, and TURN, with log volumes mounted from the containers
- iptables hardening — INPUT DROP policy, rate-limited SSH, DOCKER-USER WebSocket flood
  protection
- Setup scripts genericised — hostname and paths auto-detected, no hardcoded values

---

## v1.7 — 2026-04-26

- Gravatar support, hashed client-side and broadcast peer-to-peer
- Nickname persistence in localStorage, auto-filled on return
- Video quality selector (480p / 720p / 1080p), persisted across sessions
- Options menu consolidation — invite, DEFCON, and bug report moved into the options panel
- Room name shown in the tab title
- Dual coturn relay, replacing the Metered.ca dependency with a second self-hosted server

---

## v1.6 — 2026-04-01

- Per-participant hide video, disabling inbound track decoding to save CPU/GPU
- DEFCON button to kill all video feeds at once
- Screen share audio mixer with independent mic and desktop sliders
- Hardware codec preference — H.264 → VP9 → AV1 → VP8
- Corporate theme
- Noise suppression off by default
- PBKDF2-HMAC-SHA256 room password hashing, 260k iterations
- XSS hardening — all user strings sanitized before DOM insertion
- Fixed stats monitoring interval leak on reconnect
- Fixed null crash when stopping screen share from the browser's own UI

---

## v1.5 — 2026-03-25

- Low Bandwidth Mode — 480p/15fps with capped bitrates, auto-enabled on mobile
- Moderator succession — the role transfers automatically when a moderator leaves
- iOS/Safari fix — zero relay candidates now falls back to direct P2P
- WebSocket reconnect no longer drops healthy peers
- Prejoin defaults — microphone on, camera off
- Prejoin ON/OFF labels on the mic, camera, and low bandwidth buttons
- UI cleanup — chat, invite, and bug report moved to the header

---

## v1.4 — 2026-03-25

- **ICE restart on disconnect.** WebRTC `connectionState: disconnected` was never recovered —
  Firefox, Safari, and mobile often stay there rather than moving to `failed`, so a restart
  was never triggered and calls silently died after long sessions. A restart is now attempted
  after 6 seconds, with removal only after 30 seconds if recovery fails.
- **WebSocket auto-reconnect** with exponential backoff (2s → 4s → 8s, capped at 30s). The
  local camera/mic stream is preserved and peer connections are re-established after
  rejoining. Intentional disconnects (leave, kick, ban) still fully clean up.
- **Fixed username showing as "User" after reconnect** — a persistent `knownUsernames` map now
  survives peer teardown.
- **Cache-busting for static assets** — `update-vps.sh` stamps the git commit hash onto asset
  URLs on every deploy.
- Signal bars with RTT and packet-loss stats on each video tile
- TURN relay-first ICE strategy with P2P fallback; fixed the responder not switching off
  relay-only after TURN failure
- Fixed ICE restart storm with throttle, backoff, and a retry limit
- Fixed moderator promotion so the role is actually transferred

---

## v1.3 — 2026-02-18

- Microphone device selector, switchable live, supporting NVIDIA Broadcast / RTX Voice
- Fixed scratchy audio caused by `Math.exp` in the audio worklet hot path
- Fixed outgoing audio distortion and glitchy mobile audio

---

## v1.2 — 2026-02

- Noise suppression — adjustable noise gate with live mic level visualization
- Per-user volume controls
- Theme selector — five themes
- Screen share with audio
- End-to-end encryption — AES-GCM-256, moderator-controlled

---

## v1.1 — 2026-02

- Multi-domain SSL certificate auto-discovery
- On-demand IRC bridge
- Dynamic hostname detection in the update script

---

## v1.0 — 2026-01

- Initial release — multi-participant video, TURN server, IRC bridge, Matrix UI
