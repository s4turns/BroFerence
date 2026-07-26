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

The killer feature - seamlessly bridge your video conference chat with IRC channels!

**How it works:**
- When creating a room, enter an IRC channel (e.g., `#webrtc`)
- All chat messages from WebRTC users are sent to IRC
- All IRC messages are displayed in the WebRTC chat
- IRC users see: `<Username> message text`
- WebRTC users see: `Username (IRC): message text`

**IRC Server:** irc.blcknd.network:6697 (SSL)
**Bot Nickname:** webrtc

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
   - User enters room name, optional password, optional IRC channel
   - Server creates room object
   - If IRC channel specified, bot joins IRC channel
   - Room persists until last user leaves

2. **Join Room**
   - User provides room name (and password if required)
   - Server adds user to room
   - Server sends list of existing participants
   - User creates WebRTC connections to all participants

3. **Signaling**
   - New user sends WebRTC offers to existing users
   - Existing users respond with answers
   - ICE candidates are exchanged
   - Peer-to-peer connections established

4. **Chat Bridge**
   - WebRTC chat messages → Server → IRC channel
   - IRC channel messages → Server → All WebRTC users
   - IRC bot nickname: `webrtc`

5. **Leave Room**
   - User disconnects
   - Server notifies other participants
   - Peer connections are closed
   - If last user, room is deleted
   - If IRC bridged, bot leaves IRC channel

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

### IRC Connection

- Server: irc.blcknd.network
- Port: 6697 (SSL/TLS)
- Nickname: webrtc
- Realname: WebRTC Bridge Bot

### Message Format

**WebRTC → IRC:**
```
<Alice> Hello from the video conference!
```

**IRC → WebRTC:**
```
Alice (IRC): Hello from IRC!
```

**System messages:**
```
System: Alice joined the room
System: Bob left the room
```

### IRC Commands Support

Currently no IRC commands are supported. Future enhancements:
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
6. **IRC join/leave spam** - IRC bot joins/leaves with room lifecycle

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
