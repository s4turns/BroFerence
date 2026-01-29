// Multi-Participant WebRTC Conference Client with IRC Bridge

class ConferenceClient {
    constructor() {
        // WebSocket connection
        this.ws = null;
        this.clientId = this.generateId();
        this.username = null;
        this.currentRoom = null;

        // WebRTC - multiple peer connections
        this.peerConnections = new Map(); // Map<clientId, RTCPeerConnection>
        this.localStream = null;
        this.screenStream = null;
        this.isScreenSharing = false;

        // ICE servers - will be set dynamically in initICEServers()
        this.iceServers = null;
        this.initICEServers();

        // UI state
        this.audioEnabled = true;
        this.videoEnabled = true;
        this.chatVisible = false;

        this.initUI();
    }

    generateId() {
        return 'client_' + Math.random().toString(36).substr(2, 9);
    }

    initICEServers() {
        // Dynamic ICE server configuration based on hostname
        const hostname = window.location.hostname;
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

        // Use localhost for local development, actual hostname for production
        const turnServer = isLocalhost ? 'localhost' : hostname;

        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                {
                    urls: `turn:${turnServer}:3479`,
                    username: 'webrtc',
                    credential: 'vt*5JQ!InQ$qlKg'
                }
            ]
        };

        console.log('ICE servers configured:', this.iceServers);
    }

    initUI() {
        // Get UI elements
        this.joinScreen = document.getElementById('joinScreen');
        this.conferenceScreen = document.getElementById('conferenceScreen');
        this.videoGrid = document.getElementById('videoGrid');
        this.localVideo = document.getElementById('localVideo');
        this.chatSidebar = document.getElementById('chatSidebar');
        this.chatMessages = document.getElementById('chatMessages');
        this.statusBar = document.getElementById('statusBar');
        this.statusText = document.getElementById('statusText');

        // Input elements
        this.usernameInput = document.getElementById('usernameInput');
        this.roomInput = document.getElementById('roomInput');
        this.ircChannelInput = document.getElementById('ircChannelInput');
        this.passwordInput = document.getElementById('passwordInput');
        this.chatInput = document.getElementById('chatInput');

        // Buttons
        document.getElementById('joinBtn').addEventListener('click', () => this.joinRoom());
        document.getElementById('leaveRoomBtn').addEventListener('click', () => this.leaveRoom());
        document.getElementById('toggleAudioBtn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggleVideoBtn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('shareScreenBtn').addEventListener('click', () => this.toggleScreenShare());
        document.getElementById('chatToggleBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('toggleChatBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('sendMessageBtn').addEventListener('click', () => this.sendChatMessage());

        // Chat input enter key
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendChatMessage();
        });

        // Set default username
        this.usernameInput.value = `User_${this.clientId.substr(-4)}`;
    }

    updateStatus(message, type = 'info') {
        this.statusText.textContent = message;
        this.statusBar.className = 'status-bar';
        if (type === 'connected') {
            this.statusBar.classList.add('connected');
        } else if (type === 'error') {
            this.statusBar.classList.add('error');
        }
    }

    async connectSignalingServer() {
        return new Promise((resolve, reject) => {
            this.updateStatus('Connecting to server...', 'info');

            // Dynamic WebSocket URL based on hostname
            const hostname = window.location.hostname;
            const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';

            // Use ws:// for localhost, wss:// for production
            const protocol = isLocalhost ? 'ws' : 'wss';
            const wsUrl = `${protocol}://${hostname}:8765`;

            console.log(`Connecting to signaling server: ${wsUrl}`);
            this.ws = new WebSocket(wsUrl);

            this.ws.onopen = () => {
                console.log('WebSocket connected');

                // Register with server
                this.sendMessage({
                    type: 'register',
                    clientId: this.clientId,
                    username: this.username
                });
            };

            this.ws.onmessage = async (event) => {
                const message = JSON.parse(event.data);
                await this.handleSignalingMessage(message);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateStatus('Connection error', 'error');
                reject(error);
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.updateStatus('Disconnected', 'error');
                this.cleanup();
            };

            // Resolve when registered
            const checkRegistered = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'registered') {
                    this.ws.removeEventListener('message', checkRegistered);
                    this.updateStatus('Connected', 'connected');
                    resolve();
                }
            };
            this.ws.addEventListener('message', checkRegistered);
        });
    }

    async handleSignalingMessage(message) {
        console.log('Received:', message);

        switch (message.type) {
            case 'room-joined':
                this.currentRoom = message.roomId;
                this.updateRoomInfo(message.users.length + 1);

                // Show conference screen
                this.joinScreen.style.display = 'none';
                this.conferenceScreen.style.display = 'flex';

                // Create peer connections for existing users
                for (const user of message.users) {
                    await this.createPeerConnection(user.id, user.username, true);
                }

                // Show IRC status if bridged
                if (message.ircChannel) {
                    document.getElementById('ircStatus').textContent =
                        `💬 Bridged to IRC: ${message.ircChannel}`;
                }
                break;

            case 'user-joined':
                this.addChatMessage('System', `${message.username} joined the room`, true);
                // Wait for them to send offer
                break;

            case 'user-left':
                this.removePeerConnection(message.clientId);
                this.addChatMessage('System', `${message.username} left the room`, true);
                this.updateRoomInfo(this.peerConnections.size + 1);
                break;

            case 'offer':
                await this.handleOffer(message.senderId, message.data);
                break;

            case 'answer':
                await this.handleAnswer(message.senderId, message.data);
                break;

            case 'ice-candidate':
                await this.handleIceCandidate(message.senderId, message.data);
                break;

            case 'chat-message':
                const isIRC = message.username.includes('(IRC)');
                this.addChatMessage(message.username, message.message, false, isIRC);
                break;

            case 'password-required':
                const password = prompt('This room requires a password:');
                if (password) {
                    this.sendMessage({
                        type: 'join-room',
                        roomId: message.roomId,
                        password: password
                    });
                }
                break;

            case 'error':
                alert('Error: ' + message.message);
                break;
        }
    }

    async getLocalStream() {
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true
                });
                this.localVideo.srcObject = this.localStream;

                // Start monitoring for speaking indicator
                this.monitorAudioLevel(this.localStream, document.getElementById('localContainer'));

                console.log('Got local stream');
            } catch (error) {
                console.error('Error accessing media devices:', error);
                alert('Could not access camera/microphone. Please grant permissions.');
                throw error;
            }
        }
        return this.localStream;
    }

    monitorAudioLevel(stream, containerElement) {
        try {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const audioSource = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            audioSource.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            const checkAudioLevel = () => {
                analyser.getByteFrequencyData(dataArray);

                // Calculate average volume
                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    sum += dataArray[i];
                }
                const average = sum / bufferLength;

                // Threshold for "speaking" (adjust as needed)
                const SPEAKING_THRESHOLD = 20;

                if (average > SPEAKING_THRESHOLD) {
                    containerElement.classList.add('speaking');
                } else {
                    containerElement.classList.remove('speaking');
                }

                requestAnimationFrame(checkAudioLevel);
            };

            checkAudioLevel();
        } catch (error) {
            console.warn('Could not monitor audio level:', error);
        }
    }

    async joinRoom() {
        const username = this.usernameInput.value.trim();
        const roomId = this.roomInput.value.trim();
        const password = this.passwordInput.value.trim() || null;
        const ircChannel = this.ircChannelInput.value.trim() || null;

        if (!username || !roomId) {
            alert('Please enter your name and room name');
            return;
        }

        this.username = username;

        try {
            // Connect to signaling server
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                await this.connectSignalingServer();
            }

            // Get local media
            await this.getLocalStream();

            // Create or join room
            this.sendMessage({
                type: 'create-room',
                roomId: roomId,
                password: password,
                ircChannel: ircChannel
            });

        } catch (error) {
            console.error('Error joining room:', error);
            this.updateStatus('Failed to join room', 'error');
        }
    }

    async createPeerConnection(peerId, peerUsername, createOffer = false) {
        console.log(`Creating peer connection for ${peerId} (${peerUsername})`);

        const pc = new RTCPeerConnection(this.iceServers);
        this.peerConnections.set(peerId, {
            connection: pc,
            username: peerUsername
        });

        // Add local stream tracks
        this.localStream.getTracks().forEach(track => {
            pc.addTrack(track, this.localStream);
        });

        // Handle incoming tracks
        pc.ontrack = (event) => {
            console.log('Received remote track from', peerId, 'kind:', event.track.kind);
            console.log('Remote stream:', event.streams[0]);
            console.log('Stream tracks:', event.streams[0].getTracks().map(t => `${t.kind}: ${t.enabled}`));
            this.addRemoteVideo(peerId, peerUsername, event.streams[0]);
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendMessage({
                    type: 'ice-candidate',
                    targetId: peerId,
                    data: event.candidate
                });
            }
        };

        // Connection state changes
        pc.onconnectionstatechange = () => {
            console.log(`Connection state with ${peerId}:`, pc.connectionState);
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this.removePeerConnection(peerId);
            }
        };

        // Create offer if we're the initiator
        if (createOffer) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                this.sendMessage({
                    type: 'offer',
                    targetId: peerId,
                    data: offer
                });
            } catch (error) {
                console.error('Error creating offer:', error);
            }
        }
    }

    async handleOffer(senderId, offer) {
        console.log('Received offer from:', senderId);

        // Create peer connection if it doesn't exist
        if (!this.peerConnections.has(senderId)) {
            await this.createPeerConnection(senderId, 'User', false);
        }

        const peer = this.peerConnections.get(senderId);
        const pc = peer.connection;

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            this.sendMessage({
                type: 'answer',
                targetId: senderId,
                data: answer
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(senderId, answer) {
        console.log('Received answer from:', senderId);

        const peer = this.peerConnections.get(senderId);
        if (!peer) return;

        try {
            await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(senderId, candidate) {
        const peer = this.peerConnections.get(senderId);
        if (!peer) return;

        try {
            await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    addRemoteVideo(peerId, username, stream) {
        // Remove existing video if any
        const existing = document.getElementById(`video-${peerId}`);
        if (existing) existing.remove();

        // Create video container
        const container = document.createElement('div');
        container.className = 'video-container';
        container.id = `video-${peerId}`;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsinline = true;
        video.srcObject = stream;

        // Try to play, handling autoplay restrictions
        video.play().catch(err => {
            console.warn('Video autoplay failed, user interaction required:', err);
        });

        const label = document.createElement('div');
        label.className = 'video-label';
        label.textContent = username;

        container.appendChild(video);
        container.appendChild(label);
        this.videoGrid.appendChild(container);

        // Start monitoring for speaking indicator
        this.monitorAudioLevel(stream, container);

        this.updateRoomInfo(this.peerConnections.size + 1);
    }

    removePeerConnection(peerId) {
        const peer = this.peerConnections.get(peerId);
        if (peer) {
            peer.connection.close();
            this.peerConnections.delete(peerId);
        }

        const videoElement = document.getElementById(`video-${peerId}`);
        if (videoElement) {
            videoElement.remove();
        }

        this.updateRoomInfo(this.peerConnections.size + 1);
    }

    async toggleScreenShare() {
        if (!this.isScreenSharing) {
            try {
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });

                // Replace video track in all peer connections
                const videoTrack = this.screenStream.getVideoTracks()[0];
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) {
                        sender.replaceTrack(videoTrack);
                    }
                });

                // Update local video
                this.localVideo.srcObject = this.screenStream;

                // Handle stream end
                videoTrack.onended = () => {
                    this.toggleScreenShare();
                };

                this.isScreenSharing = true;
                document.getElementById('shareScreenBtn').classList.add('active');

            } catch (error) {
                console.error('Error sharing screen:', error);
            }
        } else {
            // Stop screen sharing
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
            }

            // Restore camera
            const videoTrack = this.localStream.getVideoTracks()[0];
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
            });

            this.localVideo.srcObject = this.localStream;
            this.isScreenSharing = false;
            document.getElementById('shareScreenBtn').classList.remove('active');
        }
    }

    toggleAudio() {
        if (this.localStream) {
            this.audioEnabled = !this.audioEnabled;
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = this.audioEnabled;
            });

            const btn = document.getElementById('toggleAudioBtn');
            btn.classList.toggle('active', !this.audioEnabled);
            btn.querySelector('.icon').textContent = this.audioEnabled ? '🎤' : '🔇';
        }
    }

    toggleVideo() {
        if (this.localStream) {
            this.videoEnabled = !this.videoEnabled;
            this.localStream.getVideoTracks().forEach(track => {
                track.enabled = this.videoEnabled;
            });

            const btn = document.getElementById('toggleVideoBtn');
            btn.classList.toggle('active', !this.videoEnabled);
            btn.querySelector('.icon').textContent = this.videoEnabled ? '📹' : '📷';
        }
    }

    toggleChat() {
        this.chatVisible = !this.chatVisible;
        this.chatSidebar.classList.toggle('hidden', !this.chatVisible);
    }

    sendChatMessage() {
        const message = this.chatInput.value.trim();
        if (!message) return;

        this.sendMessage({
            type: 'chat-message',
            message: message
        });

        this.addChatMessage(this.username + ' (You)', message, false, false, true);
        this.chatInput.value = '';
    }

    addChatMessage(username, text, isSystem = false, isIRC = false, isOwn = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';

        if (isOwn) messageDiv.classList.add('own');
        if (isIRC) messageDiv.classList.add('irc');

        const usernameSpan = document.createElement('div');
        usernameSpan.className = 'username';
        usernameSpan.textContent = username;

        const textSpan = document.createElement('div');
        textSpan.className = 'text';
        textSpan.textContent = text;

        const timestamp = document.createElement('div');
        timestamp.className = 'timestamp';
        timestamp.textContent = new Date().toLocaleTimeString();

        messageDiv.appendChild(usernameSpan);
        messageDiv.appendChild(textSpan);
        messageDiv.appendChild(timestamp);

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    updateRoomInfo(participantCount) {
        document.getElementById('roomName').textContent = `Room: ${this.currentRoom}`;
        document.getElementById('participantCount').textContent = `${participantCount} participant${participantCount !== 1 ? 's' : ''}`;
        document.getElementById('roomInfo').style.display = 'flex';
    }

    leaveRoom() {
        if (this.currentRoom) {
            this.sendMessage({ type: 'leave-room' });
        }
        this.cleanup();
    }

    cleanup() {
        // Close all peer connections
        this.peerConnections.forEach((peer, peerId) => {
            peer.connection.close();
            const videoElement = document.getElementById(`video-${peerId}`);
            if (videoElement) videoElement.remove();
        });
        this.peerConnections.clear();

        // Stop local streams
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }

        this.localVideo.srcObject = null;
        this.currentRoom = null;
        this.isScreenSharing = false;

        // Reset UI
        this.joinScreen.style.display = 'flex';
        this.conferenceScreen.style.display = 'none';
        document.getElementById('roomInfo').style.display = 'none';
        this.chatMessages.innerHTML = '';

        this.updateStatus('Disconnected', 'error');
    }

    sendMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }
}

// Initialize the conference client
const client = new ConferenceClient();
