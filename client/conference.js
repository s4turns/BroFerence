// Multi-Participant WebRTC Conference Client with IRC Bridge

class ConferenceClient {
    constructor() {
        // WebSocket connection
        this.ws = null;
        this.clientId = this.generateId();
        this.username = null;
        this.currentRoom = null;
        this.isModerator = false;
        this.moderatorId = null;

        // WebRTC - multiple peer connections
        this.peerConnections = new Map(); // Map<clientId, RTCPeerConnection>
        this.pendingUsernames = new Map(); // Map<clientId, username> for users who haven't established peer connection yet
        this.pendingIceCandidates = new Map(); // Map<clientId, Array<candidate>> for ICE candidates that arrive before remote description
        this.remoteAudioControls = new Map(); // Map<clientId, {audioContext, gainNode, isMuted}>
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
        this.unreadMessageCount = 0;
        this.spotlightMode = false;
        this.spotlightPeerId = null;

        // Prejoin state
        this.prejoinStream = null;
        this.prejoinAudioEnabled = true;
        this.prejoinVideoEnabled = true;

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
        document.getElementById('joinBtn').addEventListener('click', () => this.showPrejoinScreen());
        document.getElementById('changeNameBtn').addEventListener('click', () => this.changeName());
        document.getElementById('leaveRoomBtn').addEventListener('click', () => this.leaveRoom());

        // Prejoin buttons
        document.getElementById('prejoinToggleAudioBtn').addEventListener('click', () => this.prejoinToggleAudio());
        document.getElementById('prejoinToggleVideoBtn').addEventListener('click', () => this.prejoinToggleVideo());
        document.getElementById('prejoinBackBtn').addEventListener('click', () => this.hidePrejoinScreen());
        document.getElementById('prejoinJoinBtn').addEventListener('click', () => this.joinRoom());
        document.getElementById('toggleAudioBtn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggleVideoBtn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('shareScreenBtn').addEventListener('click', () => this.toggleScreenShare());
        document.getElementById('fullscreenBtn').addEventListener('click', () => this.toggleFullscreen());
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
                this.isModerator = message.isModerator || false;
                this.moderatorId = message.moderatorId;
                this.updateRoomInfo(message.users.length + 1);

                // Show conference screen
                this.joinScreen.style.display = 'none';
                this.conferenceScreen.style.display = 'flex';

                // Show control buttons in header
                document.getElementById('bottomControls').style.display = 'flex';

                // Create peer connections for existing users
                for (const user of message.users) {
                    await this.createPeerConnection(user.id, user.username, true);
                }

                // Show IRC status if bridged
                if (message.ircChannel) {
                    document.getElementById('ircStatus').textContent =
                        `💬 Bridged to IRC: ${message.ircChannel}`;
                }

                // Show moderator status
                if (this.isModerator) {
                    this.addChatMessage('System', 'You are the moderator of this room', true);
                }
                break;

            case 'user-joined':
                // Store the username for when we receive their offer
                this.pendingUsernames.set(message.clientId, message.username);
                this.addChatMessage('System', `${message.username} joined the room`, true);
                // Wait for them to send offer
                break;

            case 'user-left':
                this.removePeerConnection(message.clientId);
                this.addChatMessage('System', `${message.username} left the room`, true);
                this.updateRoomInfo(this.peerConnections.size + 1);
                break;

            case 'name-changed':
                // Update the display name for a user
                const peer = this.peerConnections.get(message.clientId);
                if (peer) {
                    peer.username = message.newUsername;
                    // Update the video label
                    const label = document.querySelector(`#video-${message.clientId} .video-label`);
                    if (label) {
                        if (message.clientId === this.moderatorId) {
                            label.textContent = `👑 ${message.newUsername}`;
                        } else {
                            label.textContent = message.newUsername;
                        }
                    }
                }
                this.addChatMessage('System', `${message.oldUsername} changed their name to ${message.newUsername}`, true);
                break;

            case 'name-changed-by-moderator':
                // Your name was changed by moderator
                this.username = message.newUsername;
                this.addChatMessage('System', `Moderator changed your name to ${message.newUsername}`, true);
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

            case 'kicked':
                alert(message.message);
                this.cleanup();
                break;

            case 'banned':
                alert(message.message);
                this.cleanup();
                break;

            case 'error':
                alert('Error: ' + message.message);
                break;
        }
    }

    async getLocalStream() {
        if (!this.localStream) {
            try {
                // Advanced audio constraints for crisp audio quality
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: {
                        width: { ideal: 1280 },
                        height: { ideal: 720 },
                        frameRate: { ideal: 30 }
                    },
                    audio: {
                        // Enable all browser-native noise suppression features
                        echoCancellation: { ideal: true },
                        noiseSuppression: { ideal: true },
                        autoGainControl: { ideal: true },

                        // Advanced audio settings for better quality
                        sampleRate: { ideal: 48000 },  // Higher sample rate for better audio quality
                        channelCount: { ideal: 1 },    // Mono for voice (reduces bandwidth)
                        latency: { ideal: 0.01 },      // Low latency for real-time feel

                        // Additional noise suppression settings (if supported by browser)
                        googEchoCancellation: { ideal: true },
                        googAutoGainControl: { ideal: true },
                        googNoiseSuppression: { ideal: true },
                        googHighpassFilter: { ideal: true },     // Remove low-frequency noise
                        googTypingNoiseDetection: { ideal: true }, // Reduce keyboard noise
                        googAudioMirroring: { ideal: false }
                    }
                });
                console.log('Advanced audio enhancements enabled: echo cancellation, noise suppression, auto gain, high-pass filter, typing noise detection');
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

    async showPrejoinScreen() {
        const username = this.usernameInput.value.trim();
        const roomId = this.roomInput.value.trim();

        if (!username || !roomId) {
            alert('Please enter your name and room name');
            return;
        }

        this.username = username;

        // Show prejoin screen
        document.getElementById('joinScreen').style.display = 'none';
        document.getElementById('prejoinScreen').style.display = 'flex';

        // Get media for preview
        try {
            // Use same advanced audio constraints as main stream
            this.prejoinStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                },
                audio: {
                    echoCancellation: { ideal: true },
                    noiseSuppression: { ideal: true },
                    autoGainControl: { ideal: true },
                    sampleRate: { ideal: 48000 },
                    channelCount: { ideal: 1 },
                    latency: { ideal: 0.01 },
                    googEchoCancellation: { ideal: true },
                    googAutoGainControl: { ideal: true },
                    googNoiseSuppression: { ideal: true },
                    googHighpassFilter: { ideal: true },
                    googTypingNoiseDetection: { ideal: true },
                    googAudioMirroring: { ideal: false }
                }
            });

            document.getElementById('prejoinVideo').srcObject = this.prejoinStream;
        } catch (error) {
            console.error('Error accessing media devices:', error);
            alert('Could not access camera/microphone. You can still join but others will not see or hear you.');
        }
    }

    hidePrejoinScreen() {
        // Stop prejoin stream
        if (this.prejoinStream) {
            this.prejoinStream.getTracks().forEach(track => track.stop());
            this.prejoinStream = null;
        }

        // Show join screen
        document.getElementById('prejoinScreen').style.display = 'none';
        document.getElementById('joinScreen').style.display = 'flex';
    }

    prejoinToggleAudio() {
        if (this.prejoinStream) {
            this.prejoinAudioEnabled = !this.prejoinAudioEnabled;
            this.prejoinStream.getAudioTracks().forEach(track => {
                track.enabled = this.prejoinAudioEnabled;
            });

            const btn = document.getElementById('prejoinToggleAudioBtn');
            btn.classList.toggle('active', !this.prejoinAudioEnabled);
            btn.querySelector('.icon').textContent = this.prejoinAudioEnabled ? '🎤' : '🔇';
        }
    }

    prejoinToggleVideo() {
        if (this.prejoinStream) {
            this.prejoinVideoEnabled = !this.prejoinVideoEnabled;
            this.prejoinStream.getVideoTracks().forEach(track => {
                track.enabled = this.prejoinVideoEnabled;
            });

            const btn = document.getElementById('prejoinToggleVideoBtn');
            btn.classList.toggle('active', !this.prejoinVideoEnabled);
            btn.querySelector('.icon').textContent = this.prejoinVideoEnabled ? '📹' : '📷';
        }
    }

    async joinRoom() {
        const roomId = this.roomInput.value.trim();
        const password = this.passwordInput.value.trim() || null;
        const ircChannel = this.ircChannelInput.value.trim() || null;

        try {
            // Hide prejoin screen
            document.getElementById('prejoinScreen').style.display = 'none';

            // Connect to signaling server
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                await this.connectSignalingServer();
            }

            // Use prejoin stream if available, otherwise get new stream
            if (this.prejoinStream) {
                this.localStream = this.prejoinStream;
                this.audioEnabled = this.prejoinAudioEnabled;
                this.videoEnabled = this.prejoinVideoEnabled;
                this.localVideo.srcObject = this.localStream;

                // Start monitoring for speaking indicator
                this.monitorAudioLevel(this.localStream, document.getElementById('localContainer'));

                // Clear prejoin stream reference (now it's localStream)
                this.prejoinStream = null;
            } else {
                // Get local media if not already obtained in prejoin
                await this.getLocalStream();
            }

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

        // Add local stream tracks with optimized RTP parameters
        this.localStream.getTracks().forEach(track => {
            const sender = pc.addTrack(track, this.localStream);

            // Optimize audio encoding parameters for voice
            if (track.kind === 'audio' && sender.getParameters) {
                const parameters = sender.getParameters();
                if (parameters.encodings && parameters.encodings.length > 0) {
                    // Optimize for voice: prioritize quality over bandwidth
                    parameters.encodings[0].priority = 'high';
                    parameters.encodings[0].networkPriority = 'high';

                    // Enable DTX (Discontinuous Transmission) to save bandwidth during silence
                    // This is especially useful with good noise suppression
                    if ('dtx' in parameters.encodings[0]) {
                        parameters.encodings[0].dtx = 'enabled';
                    }

                    sender.setParameters(parameters).catch(err => {
                        console.warn('Could not set audio encoding parameters:', err);
                    });
                }
            }
        });

        // Handle incoming tracks
        let streamAdded = false;
        pc.ontrack = (event) => {
            console.log('Received remote track from', peerId, 'kind:', event.track.kind);

            // Only add video element once (ontrack fires for each track)
            if (!streamAdded) {
                streamAdded = true;
                console.log('Remote stream:', event.streams[0]);
                console.log('Stream tracks:', event.streams[0].getTracks().map(t => `${t.kind}: ${t.enabled}`));
                this.addRemoteVideo(peerId, peerUsername, event.streams[0]);
            }
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
            console.log(`Connection state with ${peerId} (${peerUsername}):`, pc.connectionState);

            if (pc.connectionState === 'connected') {
                console.log(`Successfully connected to ${peerUsername}`);
            } else if (pc.connectionState === 'failed') {
                console.error(`Connection failed with ${peerUsername}, attempting to remove and reconnect`);
                this.removePeerConnection(peerId);
            } else if (pc.connectionState === 'disconnected') {
                console.warn(`Disconnected from ${peerUsername}`);
                // Give it a moment to potentially reconnect before removing
                setTimeout(() => {
                    if (pc.connectionState === 'disconnected') {
                        console.log(`Still disconnected from ${peerUsername}, removing connection`);
                        this.removePeerConnection(peerId);
                    }
                }, 5000);
            }
        };

        // ICE connection state changes (more detailed than connection state)
        pc.oniceconnectionstatechange = () => {
            console.log(`ICE connection state with ${peerId} (${peerUsername}):`, pc.iceConnectionState);
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
            // Get username from pending usernames or use default
            const username = this.pendingUsernames.get(senderId) || 'User';
            this.pendingUsernames.delete(senderId); // Remove from pending
            await this.createPeerConnection(senderId, username, false);
        }

        const peer = this.peerConnections.get(senderId);
        const pc = peer.connection;

        try {
            await pc.setRemoteDescription(new RTCSessionDescription(offer));

            // Process any pending ICE candidates
            if (this.pendingIceCandidates.has(senderId)) {
                const candidates = this.pendingIceCandidates.get(senderId);
                console.log(`Processing ${candidates.length} pending ICE candidates for ${senderId}`);
                for (const candidate of candidates) {
                    try {
                        await pc.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (err) {
                        console.error('Error adding pending ICE candidate:', err);
                    }
                }
                this.pendingIceCandidates.delete(senderId);
            }

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

            // Process any pending ICE candidates
            if (this.pendingIceCandidates.has(senderId)) {
                const candidates = this.pendingIceCandidates.get(senderId);
                console.log(`Processing ${candidates.length} pending ICE candidates for ${senderId}`);
                for (const candidate of candidates) {
                    try {
                        await peer.connection.addIceCandidate(new RTCIceCandidate(candidate));
                    } catch (err) {
                        console.error('Error adding pending ICE candidate:', err);
                    }
                }
                this.pendingIceCandidates.delete(senderId);
            }
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(senderId, candidate) {
        const peer = this.peerConnections.get(senderId);
        if (!peer) {
            console.warn(`Received ICE candidate for unknown peer ${senderId}, ignoring`);
            return;
        }

        const pc = peer.connection;

        // If remote description isn't set yet, queue the candidate
        if (!pc.remoteDescription || !pc.remoteDescription.type) {
            console.log(`Queueing ICE candidate for ${senderId} (remote description not set yet)`);
            if (!this.pendingIceCandidates.has(senderId)) {
                this.pendingIceCandidates.set(senderId, []);
            }
            this.pendingIceCandidates.get(senderId).push(candidate);
            return;
        }

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
            console.log(`Added ICE candidate for ${senderId}`);
        } catch (error) {
            console.error(`Error adding ICE candidate for ${senderId}:`, error);
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
        video.playsinline = true;  // Critical for iOS Safari
        video.muted = false;  // We want to hear remote audio
        video.setAttribute('playsinline', '');  // Additional attribute for iOS
        video.setAttribute('webkit-playsinline', '');  // For older iOS versions

        // Set srcObject
        video.srcObject = stream;

        const label = document.createElement('div');
        label.className = 'video-label';
        // Add moderator indicator if this user is the moderator
        if (peerId === this.moderatorId) {
            label.textContent = `👑 ${username}`;
        } else {
            label.textContent = username;
        }

        // Add audio controls for remote users
        const audioControls = this.createAudioControls(peerId, stream);
        container.appendChild(audioControls);

        container.appendChild(video);
        container.appendChild(label);
        this.videoGrid.appendChild(container);

        // Add click handler for spotlight mode
        container.addEventListener('click', (e) => {
            // Don't trigger spotlight if clicking on controls
            if (e.target.closest('.remote-audio-controls')) return;
            this.toggleSpotlight(peerId);
        });
        container.style.cursor = 'pointer';

        // Store video element reference for volume control
        this.remoteAudioControls.set(peerId, {
            videoElement: video,
            isMuted: false
        });

        // Try to play after adding to DOM - required for mobile
        // Use a slight delay to ensure DOM is ready
        setTimeout(() => {
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        console.log(`Video playing for ${username}`);
                    })
                    .catch(err => {
                        console.warn(`Video autoplay failed for ${username}:`, err);
                        // On mobile, may need user interaction - add a play button overlay
                        this.addPlayButtonOverlay(container, video, username);
                    });
            }
        }, 100);

        // Start monitoring for speaking indicator
        this.monitorAudioLevel(stream, container);

        this.updateRoomInfo(this.peerConnections.size + 1);
    }

    createAudioControls(peerId, stream) {
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'remote-audio-controls';

        // Mute button
        const muteBtn = document.createElement('button');
        muteBtn.textContent = '🔊';
        muteBtn.title = 'Mute/Unmute';
        muteBtn.onclick = () => this.toggleRemoteMute(peerId, muteBtn);

        // Volume slider
        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.title = 'Volume';
        volumeSlider.oninput = (e) => this.setRemoteVolume(peerId, e.target.value / 100);

        controlsDiv.appendChild(muteBtn);
        controlsDiv.appendChild(volumeSlider);

        // Add moderator controls if user is moderator
        if (this.isModerator) {
            const renameBtn = document.createElement('button');
            renameBtn.textContent = '✏️';
            renameBtn.title = 'Change user name';
            renameBtn.onclick = () => this.moderatorChangeName(peerId);

            const kickBtn = document.createElement('button');
            kickBtn.textContent = '👢';
            kickBtn.title = 'Kick user';
            kickBtn.onclick = () => this.kickUser(peerId);

            const banBtn = document.createElement('button');
            banBtn.textContent = '🚫';
            banBtn.title = 'Ban user';
            banBtn.onclick = () => this.banUser(peerId);

            controlsDiv.appendChild(renameBtn);
            controlsDiv.appendChild(kickBtn);
            controlsDiv.appendChild(banBtn);
        }

        return controlsDiv;
    }

    kickUser(targetId) {
        if (!this.isModerator) {
            alert('Only moderator can kick users');
            return;
        }

        if (confirm('Are you sure you want to kick this user?')) {
            this.sendMessage({
                type: 'kick-user',
                targetId: targetId
            });
        }
    }

    banUser(targetId) {
        if (!this.isModerator) {
            alert('Only moderator can ban users');
            return;
        }

        if (confirm('Are you sure you want to ban this user? They will not be able to rejoin this room.')) {
            this.sendMessage({
                type: 'ban-user',
                targetId: targetId
            });
        }
    }

    moderatorChangeName(targetId) {
        if (!this.isModerator) {
            alert('Only moderator can change user names');
            return;
        }

        const peer = this.peerConnections.get(targetId);
        if (!peer) return;

        const currentName = peer.username;
        const newName = prompt(`Change username for ${currentName}:`, currentName);

        if (newName && newName.trim() && newName !== currentName) {
            this.sendMessage({
                type: 'moderator-change-name',
                targetId: targetId,
                newUsername: newName.trim()
            });
        }
    }

    toggleRemoteMute(peerId, button) {
        const controls = this.remoteAudioControls.get(peerId);
        if (!controls || !controls.videoElement) return;

        controls.isMuted = !controls.isMuted;
        controls.videoElement.muted = controls.isMuted;

        if (controls.isMuted) {
            button.textContent = '🔇';
            button.classList.add('muted');
        } else {
            button.textContent = '🔊';
            button.classList.remove('muted');
        }
    }

    setRemoteVolume(peerId, volume) {
        const controls = this.remoteAudioControls.get(peerId);
        if (!controls || !controls.videoElement) return;

        // Only set volume if not muted
        if (!controls.isMuted) {
            controls.videoElement.volume = volume;
        }
    }

    addPlayButtonOverlay(container, video, username) {
        // Check if overlay already exists
        if (container.querySelector('.play-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'play-overlay';
        overlay.innerHTML = '▶️ Tap to play';
        overlay.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.7);
            color: white;
            padding: 15px 25px;
            border-radius: 8px;
            cursor: pointer;
            z-index: 10;
            font-size: 16px;
        `;

        overlay.onclick = async () => {
            try {
                await video.play();
                overlay.remove();
                console.log(`Video playing for ${username} after user interaction`);
            } catch (err) {
                console.error(`Still cannot play video for ${username}:`, err);
            }
        };

        container.style.position = 'relative';
        container.appendChild(overlay);
    }

    removePeerConnection(peerId) {
        const peer = this.peerConnections.get(peerId);
        if (peer) {
            peer.connection.close();
            this.peerConnections.delete(peerId);
        }

        // Clean up audio controls
        this.remoteAudioControls.delete(peerId);

        // Clean up pending data
        this.pendingUsernames.delete(peerId);
        this.pendingIceCandidates.delete(peerId);

        const videoElement = document.getElementById(`video-${peerId}`);
        if (videoElement) {
            videoElement.remove();
        }

        this.updateRoomInfo(this.peerConnections.size + 1);
    }

    async toggleScreenShare() {
        if (!this.isScreenSharing) {
            try {
                // Request screen sharing with system audio
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        cursor: "always"
                    },
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        sampleRate: 44100
                    }
                });

                // Replace video track in all peer connections
                const screenVideoTrack = this.screenStream.getVideoTracks()[0];
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) {
                        sender.replaceTrack(screenVideoTrack);
                    }
                });

                // If screen audio is available, add it as an additional audio track
                const screenAudioTracks = this.screenStream.getAudioTracks();
                if (screenAudioTracks.length > 0) {
                    console.log('Screen audio available, adding as additional track');
                    this.peerConnections.forEach(peer => {
                        // Add screen audio track (doesn't replace mic audio)
                        peer.connection.addTrack(screenAudioTracks[0], this.screenStream);
                    });
                } else {
                    console.log('No screen audio available (user may have denied audio or system does not support it)');
                }

                // Update local video to show screen
                this.localVideo.srcObject = this.screenStream;

                // Handle stream end (user clicks "Stop sharing" in browser UI)
                screenVideoTrack.onended = () => {
                    this.toggleScreenShare();
                };

                this.isScreenSharing = true;
                document.getElementById('shareScreenBtn').classList.add('active');
                console.log('Screen sharing started');

            } catch (error) {
                console.error('Error sharing screen:', error);
                alert('Could not start screen sharing. Please try again.');
            }
        } else {
            // Stop screen sharing
            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
            }

            // Restore camera video track
            const cameraVideoTrack = this.localStream.getVideoTracks()[0];
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(cameraVideoTrack);
                }
            });

            // Note: We don't need to restore audio track since we kept the mic audio throughout
            // We just need to remove any screen audio tracks that were added
            if (this.screenStream && this.screenStream.getAudioTracks().length > 0) {
                this.peerConnections.forEach(peer => {
                    const senders = peer.connection.getSenders();
                    senders.forEach(sender => {
                        if (sender.track && sender.track.kind === 'audio' && sender.track.id === this.screenStream.getAudioTracks()[0].id) {
                            peer.connection.removeTrack(sender);
                        }
                    });
                });
            }

            this.localVideo.srcObject = this.localStream;
            this.isScreenSharing = false;
            document.getElementById('shareScreenBtn').classList.remove('active');
            console.log('Screen sharing stopped');
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

        // Clear unread count when opening chat
        if (this.chatVisible) {
            this.unreadMessageCount = 0;
            this.updateChatNotification();
        }
    }

    updateChatNotification() {
        const badge = document.getElementById('chatNotificationBadge');
        if (this.unreadMessageCount > 0 && !this.chatVisible) {
            badge.textContent = this.unreadMessageCount > 99 ? '99+' : this.unreadMessageCount;
            badge.style.display = 'flex';
        } else {
            badge.style.display = 'none';
        }
    }

    toggleSpotlight(peerId) {
        if (this.spotlightMode && this.spotlightPeerId === peerId) {
            // Exit spotlight mode
            this.exitSpotlightMode();
        } else {
            // Enter spotlight mode for this peer
            this.enterSpotlightMode(peerId);
        }
    }

    enterSpotlightMode(peerId) {
        this.spotlightMode = true;
        this.spotlightPeerId = peerId;

        // Hide all other video containers
        const allContainers = this.videoGrid.querySelectorAll('.video-container');
        allContainers.forEach(container => {
            if (container.id === `video-${peerId}` || container.id === 'localContainer') {
                container.classList.remove('spotlight-hidden');
            } else {
                container.classList.add('spotlight-hidden');
            }
        });

        // Make the selected video larger
        const spotlightContainer = document.getElementById(`video-${peerId}`);
        if (spotlightContainer) {
            spotlightContainer.classList.add('spotlight-active');
        }

        // Add exit spotlight button
        this.addExitSpotlightButton();

        // Change grid layout for spotlight
        this.videoGrid.classList.add('spotlight-mode');
    }

    exitSpotlightMode() {
        this.spotlightMode = false;
        this.spotlightPeerId = null;

        // Show all video containers
        const allContainers = this.videoGrid.querySelectorAll('.video-container');
        allContainers.forEach(container => {
            container.classList.remove('spotlight-hidden');
            container.classList.remove('spotlight-active');
        });

        // Remove exit button
        const exitBtn = document.getElementById('exitSpotlightBtn');
        if (exitBtn) exitBtn.remove();

        // Restore grid layout
        this.videoGrid.classList.remove('spotlight-mode');
    }

    addExitSpotlightButton() {
        // Remove existing button if any
        const existing = document.getElementById('exitSpotlightBtn');
        if (existing) existing.remove();

        const exitBtn = document.createElement('button');
        exitBtn.id = 'exitSpotlightBtn';
        exitBtn.className = 'btn btn-secondary exit-spotlight-btn';
        exitBtn.innerHTML = '⬅️ Back to Grid';
        exitBtn.onclick = () => this.exitSpotlightMode();

        this.videoGrid.appendChild(exitBtn);
    }

    toggleFullscreen() {
        const videoGrid = this.videoGrid;
        const fullscreenBtn = document.getElementById('fullscreenBtn');

        if (!document.fullscreenElement) {
            // Enter fullscreen - just the video grid
            if (videoGrid.requestFullscreen) {
                videoGrid.requestFullscreen();
            } else if (videoGrid.webkitRequestFullscreen) {
                videoGrid.webkitRequestFullscreen(); // Safari
            } else if (videoGrid.msRequestFullscreen) {
                videoGrid.msRequestFullscreen(); // IE11
            }
            fullscreenBtn.classList.add('active');
            fullscreenBtn.querySelector('.icon').textContent = '⛶';
        } else {
            // Exit fullscreen
            if (document.exitFullscreen) {
                document.exitFullscreen();
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen(); // Safari
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen(); // IE11
            }
            fullscreenBtn.classList.remove('active');
            fullscreenBtn.querySelector('.icon').textContent = '⛶';
        }

        // Listen for fullscreen changes (for when user presses ESC)
        document.addEventListener('fullscreenchange', () => {
            if (!document.fullscreenElement) {
                fullscreenBtn.classList.remove('active');
            }
        });
        document.addEventListener('webkitfullscreenchange', () => {
            if (!document.webkitFullscreenElement) {
                fullscreenBtn.classList.remove('active');
            }
        });
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

    linkifyText(text) {
        // URL regex pattern that matches http://, https://, and www. URLs
        const urlPattern = /(\b(https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]])/gi;

        // Replace URLs with anchor tags
        return text.replace(urlPattern, (url) => {
            let href = url;
            // Add https:// if the URL starts with www.
            if (url.startsWith('www.')) {
                href = 'https://' + url;
            }
            return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>`;
        });
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

        // Linkify the text if it's not a system message
        if (!isSystem) {
            textSpan.innerHTML = this.linkifyText(text);
        } else {
            textSpan.textContent = text;
        }

        const timestamp = document.createElement('div');
        timestamp.className = 'timestamp';
        timestamp.textContent = new Date().toLocaleTimeString();

        messageDiv.appendChild(usernameSpan);
        messageDiv.appendChild(textSpan);
        messageDiv.appendChild(timestamp);

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

        // Increment unread count if chat is hidden and not a system message from self
        if (!this.chatVisible && !isOwn) {
            this.unreadMessageCount++;
            this.updateChatNotification();
        }
    }

    updateRoomInfo(participantCount) {
        document.getElementById('roomName').textContent = `Room: ${this.currentRoom}`;
        document.getElementById('participantCount').textContent = `${participantCount} participant${participantCount !== 1 ? 's' : ''}`;
        document.getElementById('roomInfo').style.display = 'flex';
    }

    changeName() {
        const newName = prompt('Enter your new name:', this.username);
        if (newName && newName.trim() && newName !== this.username) {
            const oldName = this.username;
            this.username = newName.trim();

            // Update local video label
            const localLabel = document.querySelector('#localContainer .video-label');
            if (localLabel) {
                localLabel.textContent = 'You (Local)';
            }

            // Notify server and other users
            this.sendMessage({
                type: 'change-name',
                newUsername: this.username,
                oldUsername: oldName
            });

            this.addChatMessage('System', `You changed your name to ${this.username}`, true);
        }
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
        this.pendingUsernames.clear();
        this.pendingIceCandidates.clear();
        this.remoteAudioControls.clear();

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
        this.isModerator = false;
        this.moderatorId = null;

        // Reset button states
        document.getElementById('shareScreenBtn').classList.remove('active');
        document.getElementById('toggleAudioBtn').classList.remove('active');
        document.getElementById('toggleVideoBtn').classList.remove('active');
        document.getElementById('fullscreenBtn').classList.remove('active');

        // Reset UI
        this.joinScreen.style.display = 'flex';
        this.conferenceScreen.style.display = 'none';
        document.getElementById('roomInfo').style.display = 'none';
        document.getElementById('bottomControls').style.display = 'none';
        this.chatMessages.innerHTML = '';

        // Reset audio/video enabled states
        this.audioEnabled = true;
        this.videoEnabled = true;

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
