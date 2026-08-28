# Changelog

Versions match the number shown in the app footer and in `README.md`.

> **Note:** releases up to March 2026 were numbered v2.1–v2.3 in this file while the app and
> README used the v1.x line. Those entries have been folded into the v1.x versions they
> actually shipped in, so this file now follows one sequence: v1.0 → v1.9 → v2.0 → v2.1.

---

## v2.2 — 2026-08-28

Signaling gains a second transport. Media is deliberately untouched: audio and video still ride
WebRTC/SRTP through the coturn relays, and the relay-only privacy model is unchanged.

- **Signaling over QUIC, with WebSocket as the fallback.** The signaling channel can now run as
  WebTransport over HTTP/3 on UDP 8767, alongside the existing WSS listener on 8765. Both feed
  the same message router, so a QUIC peer and a WebSocket peer share a room with no difference
  in behaviour. Options &rarr; Signaling picks `Auto` (try QUIC, fall back), `QUIC` (force, and
  fail loudly rather than downgrade), or `WebSocket`. The status bar reports what is actually
  carrying the session, since Auto would otherwise be opaque.
- **Fallback is the common path, not an edge case.** Networks that block outbound UDP, and
  Safari and iOS which have no WebTransport at all, land on WebSocket — which is exactly the
  pre-existing behaviour. A failed QUIC attempt puts it on a five-minute cooldown so reconnects
  do not pay the handshake timeout every time, and a QUIC session that dies within ten seconds
  of opening is treated as unhealthy and pinned to WebSocket for the retry.
- **Transport-neutral server internals.** The signaling server keyed its client registry and
  room membership directly on the `websockets` protocol object and called `.send()` on it in 43
  places. Those now hold a `Peer` wrapper that both transports implement, so the message router,
  `broadcast_to_room`, and every handler are unchanged. Sends no longer raise, which removes the
  case where one dead socket aborted a whole room broadcast.
- **Fixed a signaling connection that could never reconnect.** `connectSignalingServer()`
  resolved only on a `registered` reply and rejected only on a socket error, so a channel that
  opened and then closed cleanly settled neither way. The `await` inside the reconnect loop
  waited forever and the client never came back without a manual refresh. It now also settles on
  an early close and on a timeout — which is what makes the QUIC fallback safe.
- **The message pump no longer swallows errors.** `JSON.parse` and the message switch ran
  unguarded inside an async handler, so any throw became an unhandled rejection that dropped the
  message after it had already mutated state. Both are now caught and logged.

Deploy note: UDP 8767 is optional. With it closed the app works exactly as it did in v2.1.

---

## v2.1 — 2026-08-19

Follow-up audit of the "never prompted for mic/cam" reports. v2.0 fixed one cause; these are
the rest, including a regression v2.0 introduced.

- **Safari and iOS were never prompted — caused by v2.0.** WebKit only surfaces the permission
  prompt while the click that opened the prejoin screen still counts as user activation, and
  any `await` before `getUserMedia` spends it. v2.0 awaited `enumerateDevices()` first to decide
  which kinds to ask for, which silently cost WebKit its prompt entirely. `getUserMedia` is now
  the first thing called, with nothing awaited ahead of it; the device probe moved to the
  failure path, where activation no longer matters. Chromium is unaffected either way, which is
  why Chrome-only testing missed it.
- **In-app browsers are detected.** Rooms travel by invite link, and a link opened inside
  Instagram, Facebook, TikTok, or WeChat gets camera and mic denied with no prompt and no way
  for the user to grant it. `isInAppBrowser()` recognises the common webview user agents and the
  prejoin screen explains to reopen in Safari or Chrome. Joining still works for listening.
- **Unanswered prompts now say where to look.** Chrome downgrades the prompt to a small
  address-bar icon for users who habitually block, and a dialog behind another window is easy to
  miss. If the request has not settled after four seconds the notice names the padlock/camera
  icon. The timer is cleared as soon as the request settles.
- **Blocked is distinguished from dismissed** via `navigator.permissions.query()`, called only
  *after* a refusal so it can never reintroduce the activation bug. A standing block gets
  unblock instructions; a dismissed prompt is told to reload. Firefox and Safari throw on the
  descriptor, so it degrades to the block wording.
- **Insecure origins are named** as the reason devices are unavailable, rather than presenting
  as a silent failure.

---

## v2.0 — 2026-08-19

- **Fixed invisible tile buttons.** Volume and hide controls on video tiles render and respond
  correctly.
- **Dev environment matches prod**, serving on 443/8765 instead of 8443/8766.
- **Screen share waits for the presenter slot** before broadcasting, instead of sending into a
  slot the server has not granted.
- **Restart warning.** A deploy broadcasts a 60-second countdown to everyone in a call before
  containers go down (`SIGUSR1` to the signaling server; `update-vps.sh` waits out the same
  grace period). The dev redeploy does the same.
- **The room owner is the sole E2EE key authority**; keys are regenerated when ownership
  changes.
- **IRC bridge reconnects reliably** — connects to the hostname its certificate covers, and
  registers under a nickname and realname the network's bot check accepts.
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
  cannot be sent. A peer who sends no media never fires `ontrack` either, so nothing put them
  in the grid — they now get an avatar tile on connect and can be moderated like anyone else.
- **Prejoin explains itself.** Distinguishes a missing device, blocked permission, a device
  held by another app, and a non-HTTPS origin, and says how to fix each. Controls for absent
  devices are disabled and labelled rather than silently inert, and empty device dropdowns
  read "No microphone detected" instead of rendering blank.
- **Automatic reload after a restart.** When the countdown expires the client polls the origin
  and reloads the moment it answers again. It cannot reload on the spot: the containers are
  going down as the countdown ends and the rebuild takes a couple of minutes, so an immediate
  reload only lands on a connection error. Previously the countdown just left everyone on a
  dead socket with a banner telling them to rejoin by hand. After ten minutes without an
  answer the client stops and says so, rather than reloading into an error page and hiding a
  broken deploy.
- **Fixed stale pages after a deploy.** nginx sent no cache headers for HTML, so browsers
  heuristically cached `app.html` and kept showing the previous build — including the old
  version number in the corner — even after a successful update. The `?v=<commit>`
  cache-busting only ever covered the assets *referenced by* app.html, never app.html itself.
  HTML is now served `no-cache`, which also stops the auto-reload from picking a cached page
  back up.
- **Chat button no longer boxes its own icon.** `.room-info span` was written for bare spans
  sitting directly in the header, but `.room-info` now holds only the chat button, so the rule
  was giving the icon wrapper the button's own border, padding, and background — a second box
  inside the button. It also squared off the notification badge's border radius. Scoped to
  `.room-info > span`, in the base rule and both breakpoint overrides.

---

## v1.9 — 2026-08-18

- **Screen share gets its own tile.** A share no longer replaces the sharer's camera. It rides
  a dedicated send-only peer connection and joins the grid as a separate tile, so people see
  the face and the screen at once.
- **Screen audio is separate.** Desktop audio travels with the screen tile and has its own
  volume and mute, so muting someone's screen no longer mutes their voice. Replaces the old
  mic/desktop mixer, which only existed because there was a single audio sender.
- **One presenter at a time**, tracked server-side and released automatically if the presenter
  leaves or crashes.
- **End-to-end encryption covers screen connections**, not just the camera mesh.
- **Camera is throttled while presenting** — roughly 400 kbps at half resolution, since camera
  plus screen to every peer is a lot of relayed uplink.
- **SVG icons throughout** — around 80 emoji replaced with inline stroke icons that inherit
  each theme's colour.
- **"AI Noise Suppression" renamed to "Noise suppression."** It never used a model; it is a
  DSP noise gate.

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
