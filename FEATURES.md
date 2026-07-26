# WebRTC Conference Server - Features

## Overview

This is a Jitsi-like public video conferencing server with IRC chat bridge integration.

## Key Features

### 1. Multi-Participant Video Conferencing

- **Support for 3+ participants** in the same room
- **Automatic grid layout** that adapts based on number of participants
- **Mesh topology** - each peer connects directly to all others for low latency
- **No participant limit** (performance depends on client bandwidth)

### 2. IRC Chat Bridge

The killer feature - every conference room *is* an IRC channel.

**How it works:**
- Every room is bridged automatically. There is no setting, no channel field, no opt-out.
- The channel is derived from the room name: room `blcknd` → `#bro-blcknd`.
- Each participant gets **their own IRC connection and nick**, so they appear on the
  network as real users. IRC people can see them in `/names`, highlight them, and `/msg`
  them — a private message is delivered to that one participant in the conference chat.
- Presence is real: joining a room JOINs the channel, leaving PARTs it, renaming sends NICK.
- IRC messages appear inline in the main chat, tagged by origin rather than by a `(IRC)`
  suffix on the display name.
- The channel lives as long as the room does; when the last person leaves, the bot parts
  and the channel goes away with it.

**IRC Server:** irc.blcknd.network:6697 (SSL), configurable via `IRC_SERVER` / `IRC_PORT` / `IRC_SSL`
**Bot Nickname:** `webrtc` (`IRC_BOT_NICK`) — reads channel traffic and posts room notices
**Channel prefix:** `bro-` (`IRC_CHANNEL_PREFIX`)

**Encryption:** rooms with end-to-end encryption enabled are **not** bridged. Turning E2EE on
parts the channel and disconnects the user sessions; turning it off rejoins. Encrypted
messages never reach IRC.

**Use cases:**
- Bridge conference rooms with existing IRC communities
- Allow IRC users to participate in text chat without video
- Archive conference discussions in IRC logs
- Integrate with IRC bots and services

### 3. Screen Sharing

- Click the 🖥️ screen share button to share your screen
- Choose entire screen, window, or browser tab
- Your camera feed is replaced with screen share for all participants
- Click again to stop sharing and return to camera
- **Note:** Only one person can share screen at a time (mesh limitation)

### 4. Password-Protected Rooms

- **Public rooms** - Leave password empty, anyone can join
- **Protected rooms** - Set a password when creating room
- Password is hashed (SHA-256) on server
- Users joining protected room are prompted for password
- Invalid password shows error message

### 5. Audio/Video Controls

- **Mute/Unmute microphone** - 🎤 button
- **Camera on/off** - 📹 button
- **Leave room** - Cleanly disconnect and return to join screen
- Controls update in real-time
- Muted/disabled indicators on buttons

### 6. Real-Time Chat

- Text chat alongside video conference
- Toggle chat sidebar visibility
- Messages include username and timestamp
- System messages for joins/leaves
- IRC messages highlighted in yellow
- Auto-scroll to latest message
- Press Enter to send message

## Architecture

### Signaling Server

- **Technology:** Python 3.11, WebSockets
- **Framework:** websockets library
- **IRC Bridge:** Custom implementation
- **Features:**
  - Multi-room support
  - Password hashing
  - User session management
  - WebRTC signaling (offer/answer/ICE)
  - IRC message relay

### Client

- **Technology:** Vanilla JavaScript, WebRTC API
- **No frameworks** - lightweight and fast
- **Features:**
  - Multiple RTCPeerConnection management
  - Dynamic video grid
  - Screen capture API
  - Responsive design

### Connection Topology

**Mesh Network:**
- Each participant connects directly to every other participant
- Pros: Low latency, no server bandwidth cost
- Cons: Scales to ~10 participants (bandwidth-limited)
- Each connection uses: ~2Mbps upload + ~2Mbps download

**Future:** Can implement SFU (Selective Forwarding Unit) for better scaling

## Room Lifecycle

1. **Create Room**
   - User enters room name and optional password
   - Server creates room object
   - Server derives the IRC channel from the room name and the bot joins it
   - Room persists until last user leaves

2. **Join Room**
   - User provides room name (and password if required)
   - Server adds user to room
   - Server opens that user's own IRC connection, which JOINs the channel
   - Server sends list of existing participants
   - User creates WebRTC connections to all participants

3. **Signaling**
   - New user sends WebRTC offers to existing users
   - Existing users respond with answers
   - ICE candidates are exchanged
   - Peer-to-peer connections established

4. **Chat Bridge**
   - WebRTC chat messages → that user's own IRC connection → IRC channel
   - IRC channel messages → bot → All WebRTC users
   - IRC private messages → that participant only
   - Suspended entirely while the room has E2EE enabled

5. **Leave Room**
   - User disconnects
   - Server notifies other participants
   - That user's IRC connection quits, producing a real PART
   - Peer connections are closed
   - If last user, room is deleted and the bot parts the channel

## Security Considerations

### Current (Development)

- Passwords are hashed with SHA-256
- No rate limiting
- No authentication system
- Local deployment only
- HTTP/WS (not HTTPS/WSS)

### Production Recommendations

1. **HTTPS/WSS** - Required for WebRTC in production
2. **Authentication** - Add user registration/login
3. **Rate limiting** - Prevent abuse
4. **Room limits** - Limit participants per room
5. **Time limits** - Auto-close inactive rooms
6. **Moderation** - Add kick/ban functionality
7. **Recording** - Optional session recording
8. **Coturn authentication** - Time-limited TURN credentials
9. **CORS** - Restrict origins
10. **Input validation** - Sanitize all user inputs

## IRC Bridge Details

### IRC Connections

- Server: irc.blcknd.network, port 6697 (SSL/TLS)
- **Bot** (`webrtc`): joins every active room's channel, is the sole reader of channel
  traffic, and posts room notices (ownership changes, admin broadcasts).
- **One connection per participant**, nick derived from their conference username.
  Nick collisions on the network are resolved by the server's `433` reply — the
  connection retries as `name_`, `name__`, then a numeric suffix.

Because every participant holds a connection, the BroFerence server needs a raised
per-IP client limit on the ircd (a 16-person room is 17 connections from one IP).
`IRC_MAX_USER_CONNECTIONS` caps the total; participants over the cap still talk, relayed
through the bot as `<Alice> message` instead of appearing as their own nick.

All connections share a rate limiter (`IRC_SEND_RATE`, default one line per 0.6s) and
split long messages on UTF-8 boundaries, so neither a busy room nor a long paste trips
the network's flood protection.

### Message Format

**WebRTC → IRC:** the participant's own nick says it directly.
```
<Alice> Hello from the video conference!
```
(The `<Alice> ...` relay form only appears for participants over the connection cap.)

**IRC → WebRTC:** delivered into the main chat, tagged by origin and styled as IRC.

### IRC Commands Support

Private messages (`/msg <user>`) are routed to that participant. Not yet supported:
- `/me` action messages
- IRC user list synchronization
- Topic synchronization
- Kick/ban synchronization

## Performance

### Recommended Limits

- **Participants:** 3-10 per room (mesh topology)
- **Concurrent rooms:** Limited by server resources
- **Messages/second:** No hard limit, but ~10/sec recommended

### Resource Usage

**Per participant:**
- Upload: ~2Mbps (N-1 peer connections)
- Download: ~2Mbps (N-1 peer connections)
- Browser: ~100-200MB RAM

**Server (per 100 concurrent users):**
- CPU: ~10-20% (signaling only, no media)
- RAM: ~100MB
- Bandwidth: Minimal (signaling only)

### Scaling

To support 10+ participants:
1. Implement SFU (Selective Forwarding Unit)
2. Use media servers like Janus or mediasoup
3. Server forwards streams instead of peer-to-peer
4. Trade latency for scalability

## Browser Compatibility

- ✅ Chrome/Edge 90+
- ✅ Firefox 88+
- ✅ Safari 14.1+
- ✅ Opera 76+
- ❌ Internet Explorer (not supported)

**Required APIs:**
- WebRTC (RTCPeerConnection)
- WebSocket
- getUserMedia
- getDisplayMedia (for screen sharing)

## Future Enhancements

- [ ] Simulcast for better quality adaptation
- [ ] VP9/AV1 codec support
- [ ] Recording functionality
- [ ] Virtual backgrounds
- [ ] Noise suppression
- [ ] Breakout rooms
- [ ] Whiteboard/drawing
- [ ] File sharing
- [ ] Reactions/emojis
- [ ] Raise hand feature
- [ ] Speaker detection
- [ ] Active speaker layout
- [ ] Grid/spotlight layout toggle
- [ ] Mobile app (React Native)
- [ ] Desktop app (Electron)
- [ ] Persistent chat history
- [ ] User profiles/avatars
- [ ] Calendar integration
- [ ] YouTube live streaming

## Known Limitations

1. **No E2E encryption** - Traffic is encrypted in transit but server can access
2. **Mesh topology** - Doesn't scale beyond ~10 users
3. **No persistence** - Rooms disappear when empty
4. **Single screen share** - Only one person can share at a time
5. **No recording** - Can't record sessions
6. **IRC channels are not durable** - a channel exists only while its room does; when the
   last participant leaves, the bot parts and the channel is gone. Persisting one would
   need ChanServ registration.

## Troubleshooting

### Remote video not showing
- Check both users are in the same room
- Check console for errors (F12)
- Verify TURN server is running
- Check firewall allows UDP traffic

### IRC messages not appearing
- Verify IRC bridge connected (check signaling logs)
- Ensure IRC channel name starts with #
- Check IRC channel exists and allows external users
- Check IRC server is reachable

### Poor video quality
- Too many participants (reduce to 4-6)
- Slow internet connection
- Switch to audio-only mode
- Reduce video resolution in browser settings

### Can't join password-protected room
- Ensure password matches exactly (case-sensitive)
- Try creating a new room instead

## Contributing

See README.md for development setup and contribution guidelines.
