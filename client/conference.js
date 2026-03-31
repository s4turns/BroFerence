// Multi-Participant WebRTC Conference Client with IRC Bridge
// Version: 2.0 - Signal bars update

class ConferenceClient {
    constructor() {
        // WebSocket connection
        this.ws = null;
        this.clientId = this.generateId();
        this.username = null;
        this.currentRoom = null;
        this.isModerator = false;
        this.moderatorId = null;

        // WebSocket reconnection
        this.wsReconnectAttempts = 0;
        this.wsReconnecting = false;
        this.isIntentionalDisconnect = false;
        this.roomPassword = null;

        // WebRTC - multiple peer connections
        this.peerConnections = new Map(); // Map<clientId, RTCPeerConnection>
        this.pendingUsernames = new Map(); // Map<clientId, username> for users who haven't established peer connection yet
        this.pendingIceCandidates = new Map(); // Map<clientId, Array<candidate>> for ICE candidates that arrive before remote description
        this.turnFailedPeers = new Set(); // Peers whose TURN relay has failed; use P2P fallback on next connect
        this.knownUsernames = new Map(); // Persists across peer connection teardowns for reconnection display
        this.remoteAudioControls = new Map(); // Map<clientId, {audioContext, gainNode, isMuted}>
        this.statsIntervals = new Map(); // Map<clientId, intervalId> for stats monitoring cleanup
        this.localStatsInterval = null; // Interval for local connection stats
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
        this.clearedMessages = [];
        this.moderatorUsername = null;
        // Prejoin state
        this.prejoinStream = null;
        this.prejoinAudioEnabled = true;
        this.prejoinVideoEnabled = false;
        this.lowBandwidthMode = this.isMobileDevice() || localStorage.getItem('broference-low-bandwidth') === 'true';

        // Noise suppression state
        this.noiseSuppressionEnabled = false;
        this.audioContext = null;
        this.noiseSuppressionNode = null;
        this.processedStream = null;

        // Noise gate configuration
        this.noiseGateThreshold = this.loadNoiseGateSetting('threshold', 15); // Default 15% (half of max 30)
        this.micConstantlyActiveCount = 0;
        this.micConstantlyActiveThreshold = 300; // ~5 seconds of constant activity (60fps * 5)
        this.micActiveWarningShown = false;

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

        const turnConfig = {
            urls: [
                `turn:${turnServer}:3479`,
                `turn:${turnServer}:3479?transport=tcp`
            ],
            username: 'webrtc',
            credential: 'hLBTE9M6osBZuOWy7FQHTVIpZIvISo3'
        };

        // Use all candidate types (host, srflx, relay). iceTransportPolicy:'relay'
        // is not used because RFC 5766 §9.2 mandates 403 when both peers create
        // permissions for the same TURN server's own IP — hairpin relay on a single
        // TURN server is impossible by spec. With all candidates, TURN still relays
        // for peers that need it; ICE selects the best working pair automatically.
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                turnConfig
            ]
        };

        // Fallback kept for reconnect logic compatibility
        this.iceServersFallback = this.iceServers;

        console.log('ICE servers configured (STUN + TURN, all candidate types)');
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
        document.getElementById('changeNameBtn').addEventListener('click', () => { this.toggleOptionsMenu(); this.changeName(); });
        document.getElementById('leaveRoomBtn').addEventListener('click', () => { this.toggleOptionsMenu(); this.leaveRoom(); });

        // Prejoin buttons
        document.getElementById('prejoinToggleAudioBtn').addEventListener('click', () => this.prejoinToggleAudio());
        document.getElementById('prejoinToggleVideoBtn').addEventListener('click', () => this.prejoinToggleVideo());
        document.getElementById('prejoinLowBandwidthBtn').addEventListener('click', () => this.toggleLowBandwidth());
        document.getElementById('prejoinBackBtn').addEventListener('click', () => this.hidePrejoinScreen());
        document.getElementById('prejoinJoinBtn').addEventListener('click', () => this.joinRoom());
        document.getElementById('toggleAudioBtn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggleVideoBtn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('shareScreenBtn').addEventListener('click', () => this.toggleScreenShare());
        document.getElementById('watchTogetherBtn').addEventListener('click', () => this.toggleWatchTogether());
        document.getElementById('closeWatchBtn').addEventListener('click', () => this.toggleWatchTogether());
        document.getElementById('loadVideoBtn').addEventListener('click', () => this.loadWatchVideo());
        document.getElementById('shareYouTubeWindowBtn').addEventListener('click', () => this.shareYouTubeWindow());
        document.getElementById('stopStreamBtn').addEventListener('click', () => this.stopVideoStream());
        document.getElementById('videoUrlInput').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.loadWatchVideo();
        });
        document.getElementById('chatToggleBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('toggleChatBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('sendMessageBtn').addEventListener('click', () => this.sendChatMessage());
        document.getElementById('inviteLinkBtn').addEventListener('click', () => this.copyInviteLink());
        document.getElementById('defconBtn').addEventListener('click', () => this.toggleDefcon());
        document.getElementById('optionsBtn').addEventListener('click', () => this.toggleOptionsMenu());
        document.getElementById('closeOptionsBtn').addEventListener('click', () => this.toggleOptionsMenu());
        document.getElementById('optionsOverlay').addEventListener('click', () => this.toggleOptionsMenu());

        // Hide noise suppression on mobile (causes issues)
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const noiseBtn = document.getElementById('noiseSuppressionBtn');
        const noiseGateSettings = document.getElementById('noiseGateSettings');
        if (isMobile) {
            noiseBtn.style.display = 'none';
            noiseGateSettings.style.display = 'none';
        } else {
            noiseBtn.addEventListener('click', () => this.toggleNoiseSuppression());

            // Mic device selector
            const micSelect = document.getElementById('micDeviceSelect');
            micSelect.addEventListener('change', (e) => {
                if (e.target.value) this.switchMicrophone(e.target.value);
            });

            // Noise gate threshold slider
            const gateSlider = document.getElementById('gateThresholdSlider');
            const gateValue = document.getElementById('gateThresholdValue');
            const thresholdLine = document.getElementById('gateThresholdLine');

            // Initialize from saved setting
            gateSlider.value = this.noiseGateThreshold;
            gateValue.textContent = `${this.noiseGateThreshold}%`;
            thresholdLine.style.left = `${this.noiseGateThreshold}%`;

            gateSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                this.noiseGateThreshold = value;
                gateValue.textContent = `${value}%`;
                thresholdLine.style.left = `${value}%`;
                this.saveNoiseGateSetting('threshold', value);
                this.updateNoiseGateThreshold(value);

                // Reset warning state when user adjusts threshold
                this.micConstantlyActiveCount = 0;
                this.hideMicActiveWarning();
            });

        }

        // Low bandwidth mode toggle (options menu)
        const lowBandwidthBtn = document.getElementById('lowBandwidthBtn');
        if (lowBandwidthBtn) {
            lowBandwidthBtn.setAttribute('data-enabled', String(this.lowBandwidthMode));
            lowBandwidthBtn.querySelector('.toggle-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
            lowBandwidthBtn.addEventListener('click', () => this.toggleLowBandwidth());
        }

        // Chat input enter key
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendChatMessage();
        });

        // Click channel name to focus input
        document.querySelector('.chat-header h3').addEventListener('click', () => this.chatInput.focus());


        // Theme selector
        const themeSelect = document.getElementById('themeSelect');
        if (themeSelect) {
            // Load saved theme
            const savedTheme = localStorage.getItem('broference-theme') || 'matrix';
            this.setTheme(savedTheme);
            themeSelect.value = savedTheme;

            themeSelect.addEventListener('change', (e) => {
                this.setTheme(e.target.value);
                localStorage.setItem('broference-theme', e.target.value);
            });
        }

        // Set default username
        this.usernameInput.value = `User_${this.clientId.substr(-4)}`;

        // Check for URL parameters (invite links)
        this.handleInviteLink();

    }

    handleInviteLink() {
        const urlParams = new URLSearchParams(window.location.search);
        const room = urlParams.get('room');
        const name = urlParams.get('name');

        if (room) {
            this.roomInput.value = room;
            console.log(`Invite link detected - room: ${room}`);
        }

        if (name) {
            this.usernameInput.value = name;
        }
    }

    getInviteLink() {
        if (!this.currentRoom) return null;
        const baseUrl = window.location.origin + window.location.pathname;
        return `${baseUrl}?room=${encodeURIComponent(this.currentRoom)}`;
    }

    copyInviteLink() {
        const link = this.getInviteLink();
        if (link) {
            navigator.clipboard.writeText(link).then(() => {
                this.addChatMessage('System', 'Invite link copied to clipboard!', true);
            }).catch(err => {
                console.error('Failed to copy:', err);
                prompt('Copy this invite link:', link);
            });
        }
    }

    toggleRemoteVideo(peerId, btn) {
        const container = document.getElementById(`video-${peerId}`);
        if (!container) return;
        const hidden = container.classList.toggle('video-hidden');
        btn.textContent = hidden ? '🙈' : '📹';
        btn.title = hidden ? 'Show Video' : 'Hide Video';
    }

    toggleDefcon() {
        this.defconActive = !this.defconActive;
        const btn = document.getElementById('defconBtn');

        // Hide or restore all remote video elements
        document.querySelectorAll('.video-container:not(#localContainer)').forEach(container => {
            const video = container.querySelector('video');
            if (video) video.style.display = this.defconActive ? 'none' : '';
        });

        // Hide or restore local video
        const localVideo = document.querySelector('#localContainer video');
        if (localVideo) localVideo.style.display = this.defconActive ? 'none' : '';

        btn.textContent = this.defconActive ? '📺 DEFCON' : '📵 DEFCON';
        btn.classList.toggle('active', this.defconActive);
    }

    setTheme(themeName) {
        if (themeName === 'matrix') {
            document.documentElement.removeAttribute('data-theme');
        } else {
            document.documentElement.setAttribute('data-theme', themeName);
        }
        console.log(`Theme set to: ${themeName}`);
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
                if (!this.isIntentionalDisconnect && this.currentRoom) {
                    this.scheduleWsReconnect();
                } else {
                    this.cleanup();
                }
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

    scheduleWsReconnect() {
        if (this.wsReconnecting) return;
        this.wsReconnecting = true;

        const delay = Math.min(2000 * Math.pow(2, this.wsReconnectAttempts), 30000);
        this.wsReconnectAttempts++;
        console.log(`WebSocket reconnect attempt ${this.wsReconnectAttempts} in ${delay}ms`);
        this.updateStatus(`Reconnecting... (attempt ${this.wsReconnectAttempts})`, 'error');

        setTimeout(async () => {
            this.wsReconnecting = false;

            if (!this.currentRoom) return; // Left the room while waiting

            // Only close peer connections that are not connected.
            // Established WebRTC connections survive without the signaling channel,
            // so tearing them down on a brief WS blip breaks working audio/video.
            const stale = [];
            this.peerConnections.forEach((peer, peerId) => {
                if (peer.connection.connectionState !== 'connected') {
                    stale.push(peerId);
                }
            });
            stale.forEach(peerId => this.removePeerConnection(peerId));

            this.pendingUsernames.clear();
            this.pendingIceCandidates.clear();

            try {
                await this.connectSignalingServer();
                // Re-join the room after successful reconnection
                this.sendMessage({
                    type: 'create-room',
                    roomId: this.currentRoom,
                    password: this.roomPassword
                });
                this.wsReconnectAttempts = 0;
                console.log('WebSocket reconnected, re-joining room:', this.currentRoom);
            } catch (err) {
                console.error('WebSocket reconnect failed:', err);
                this.scheduleWsReconnect();
            }
        }, delay);
    }

    async handleSignalingMessage(message) {
        console.log('Received:', message);

        switch (message.type) {
            case 'room-joined':
                this.currentRoom = message.roomId;
                this.isModerator = message.isModerator || false;
                this.moderatorId = message.moderatorId;
                this.moderatorUsername = this.isModerator
                    ? this.username
                    : (message.users.find(u => u.id === this.moderatorId)?.username || null);
                this.updateRoomInfo(message.users.length + 1);

                // Show conference screen
                this.joinScreen.style.display = 'none';
                this.conferenceScreen.style.display = 'flex';

                // Show control buttons in header
                document.getElementById('bottomControls').style.display = 'flex';

                // Create peer connections for existing users.
                // Skip peers that are already connected (e.g. after a WS reconnect —
                // established WebRTC connections survive without the signaling channel).
                for (const user of message.users) {
                    const existing = this.peerConnections.get(user.id);
                    if (existing && existing.connection.connectionState === 'connected') {
                        console.log('Skipping already-connected peer on room-joined:', user.username);
                        continue;
                    }
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

                // Send initial video and audio state to other users
                setTimeout(() => {
                    this.sendMessage({
                        type: 'video-state',
                        videoEnabled: this.videoEnabled
                    });
                    this.sendMessage({
                        type: 'audio-state',
                        audioEnabled: this.audioEnabled
                    });
                }, 500);
                break;

            case 'user-joined':
                // Store the username for when we receive their offer
                this.pendingUsernames.set(message.clientId, message.username);
                this.addChatMessage('System', `${message.username} joined the room`, true);
                // Wait for them to send offer
                break;

            case 'user-left':
                this.turnFailedPeers.delete(message.clientId);
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
                    // Update the avatar
                    const avatar = document.querySelector(`#video-${message.clientId} .video-avatar`);
                    if (avatar) {
                        avatar.textContent = message.newUsername.charAt(0).toUpperCase();
                    }
                }
                this.addChatMessage('System', `${message.oldUsername} changed their name to ${message.newUsername}`, true);
                break;

            case 'name-changed-by-moderator':
                // Your name was changed by moderator
                this.username = message.newUsername;
                // Update local avatar and label
                const localAvatarMod = document.getElementById('localAvatar');
                if (localAvatarMod) {
                    localAvatarMod.textContent = this.username.charAt(0).toUpperCase();
                }
                const localLabelMod = document.querySelector('#localContainer .video-label');
                if (localLabelMod) {
                    localLabelMod.textContent = this.username;
                }
                this.addChatMessage('System', `Moderator changed your name to ${message.newUsername}`, true);
                break;

            case 'moderator-promoted':
                // Update moderator status for a user
                this.moderatorId = message.moderatorId;
                this.moderatorUsername = message.username;
                // If WE were the moderator, we no longer are
                if (this.isModerator && message.moderatorId !== this.clientId) {
                    this.isModerator = false;
                    // Remove all mod controls from existing containers
                    document.querySelectorAll('[data-mod-control]').forEach(el => el.remove());
                }
                // Add crown to the new moderator's label
                const modLabel = document.querySelector(`#video-${message.moderatorId} .video-label`);
                if (modLabel && !modLabel.querySelector('.mod-crown')) {
                    modLabel.textContent = '';
                    const crownSpan = document.createElement('span');
                    crownSpan.className = 'mod-crown';
                    crownSpan.textContent = '👑';
                    modLabel.appendChild(crownSpan);
                    modLabel.appendChild(document.createTextNode(' ' + message.username));
                }
                // Remove crown from any other label that had it
                document.querySelectorAll('.video-label .mod-crown').forEach(crown => {
                    const label = crown.closest('.video-label');
                    if (label && !label.closest(`#video-${message.moderatorId}`)) {
                        label.textContent = label.textContent.replace('👑 ', '').trim();
                    }
                });
                this.addChatMessage('System', `${message.username} is now a moderator`, true);
                break;

            case 'you-are-moderator':
                // You have been promoted to moderator
                this.isModerator = true;
                this.moderatorUsername = this.username;
                this.addChatMessage('System', 'You are now a moderator! Hover over users to see moderator controls.', true);
                this.refreshModeratorControls();
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
                const isOwn = message.username === this.username;
                this.addChatMessage(message.username, message.message, false, isIRC, isOwn);
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
                this.isIntentionalDisconnect = true;
                alert(message.message);
                this.cleanup();
                break;

            case 'banned':
                this.isIntentionalDisconnect = true;
                alert(message.message);
                this.cleanup();
                break;

            case 'error':
                alert('Error: ' + message.message);
                break;

            case 'video-state':
                // Update remote user's video container based on their video state
                console.log('Received video-state:', message.clientId, 'enabled:', message.videoEnabled);
                const remoteContainer = document.getElementById(`video-${message.clientId}`);
                if (remoteContainer) {
                    console.log('Found container, toggling no-video class');
                    remoteContainer.classList.toggle('no-video', !message.videoEnabled);
                } else {
                    console.log('Container not found for', message.clientId);
                }
                break;

            case 'audio-state':
                // Show/hide muted indicator for remote user
                const audioContainer = document.getElementById(`video-${message.clientId}`);
                if (audioContainer) {
                    let mutedIndicator = audioContainer.querySelector('.muted-indicator');
                    if (!message.audioEnabled) {
                        // Show muted indicator
                        if (!mutedIndicator) {
                            mutedIndicator = document.createElement('div');
                            mutedIndicator.className = 'muted-indicator';
                            mutedIndicator.textContent = '🔇';
                            audioContainer.appendChild(mutedIndicator);
                        }
                    } else {
                        // Hide muted indicator
                        if (mutedIndicator) {
                            mutedIndicator.remove();
                        }
                    }
                }
                break;
        }
    }

    isMobileDevice() {
        return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    }

    getVideoConstraints() {
        if (this.lowBandwidthMode) {
            const c = { width: { ideal: 480, max: 640 }, height: { ideal: 360, max: 480 }, frameRate: { ideal: 15, max: 15 } };
            if (this.isMobileDevice()) c.facingMode = 'user';
            return c;
        }
        return this.isMobileDevice() ? {
            facingMode: 'user',
            width: { ideal: 640, max: 1280 },
            height: { ideal: 480, max: 720 }
        } : {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 24, max: 30 }
        };
    }

    getAudioConstraints() {
        if (this.isMobileDevice() || this.lowBandwidthMode) {
            return { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        }
        return {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            sampleRate: { ideal: 48000 },
            channelCount: { ideal: 1 },
            latency: { ideal: 0.01 },
            googEchoCancellation: true,
            googAutoGainControl: true,
            googNoiseSuppression: true,
            googHighpassFilter: true,
            googTypingNoiseDetection: true,
            googNoiseReduction: true,
            googAudioMirroring: false
        };
    }

    async getLocalStream() {
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: this.getVideoConstraints(),
                    audio: this.getAudioConstraints()
                });
                console.log(`Media stream acquired (${this.isMobileDevice() ? 'mobile' : 'desktop'}${this.lowBandwidthMode ? ', low-bandwidth' : ''} mode)`);
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

    getSharedAudioContext() {
        if (!this._sharedAudioCtx || this._sharedAudioCtx.state === 'closed') {
            this._sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this._sharedAudioCtx;
    }

    monitorAudioLevel(stream, containerElement) {
        // Disconnect any existing analyser nodes for this container
        if (containerElement._monitorSource) {
            containerElement._monitorSource.disconnect();
            containerElement._monitorSource = null;
        }

        // Increment generation so old loops self-terminate when they next fire
        containerElement._monitorGen = (containerElement._monitorGen || 0) + 1;
        const myGen = containerElement._monitorGen;

        try {
            const audioContext = this.getSharedAudioContext();

            const audioSource = audioContext.createMediaStreamSource(stream);
            containerElement._monitorSource = audioSource;
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 64;
            audioSource.connect(analyser);

            const bufferLength = analyser.frequencyBinCount;
            const dataArray = new Uint8Array(bufferLength);

            const checkAudioLevel = () => {
                // If a newer monitor has started, stop this loop
                if (containerElement._monitorGen !== myGen) return;

                analyser.getByteFrequencyData(dataArray);

                let sum = 0;
                for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
                const average = sum / bufferLength;

                const SPEAKING_THRESHOLD = 20;
                if (average > SPEAKING_THRESHOLD) {
                    containerElement.classList.add('speaking');
                } else {
                    containerElement.classList.remove('speaking');
                }

                setTimeout(checkAudioLevel, 250);
            };

            checkAudioLevel();
        } catch (error) {
            console.warn('Could not monitor audio level:', error);
        }
    }

    startStatsMonitoring(peerId, pc, container) {
        // Clear any existing interval for this peer before starting a new one
        this.stopStatsMonitoring(peerId);

        console.log('Starting stats monitoring for peer:', peerId);

        // Create signal bars element
        const signalBars = document.createElement('div');
        signalBars.className = 'signal-bars';
        signalBars.innerHTML = `
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="signal-tooltip">
                <div class="stat-row">
                    <span class="stat-label">RTT:</span>
                    <span class="stat-value rtt-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Loss:</span>
                    <span class="stat-value loss-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Res:</span>
                    <span class="stat-value res-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">FPS:</span>
                    <span class="stat-value fps-value">--</span>
                </div>
            </div>
        `;
        container.appendChild(signalBars);

        const rttSpan = signalBars.querySelector('.rtt-value');
        const lossSpan = signalBars.querySelector('.loss-value');
        const resSpan = signalBars.querySelector('.res-value');
        const fpsSpan = signalBars.querySelector('.fps-value');

        // Track previous values for packet loss calculation
        let prevPacketsReceived = 0;
        let prevPacketsLost = 0;

        const updateStats = async () => {
            try {
                const stats = await pc.getStats();
                let rtt = null;
                let packetsReceived = 0;
                let packetsLost = 0;
                let frameWidth = null;
                let frameHeight = null;
                let fps = null;

                stats.forEach(report => {
                    // Get RTT from candidate-pair
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        if (report.currentRoundTripTime !== undefined) {
                            rtt = report.currentRoundTripTime * 1000; // Convert to ms
                        }
                    }

                    // Get packet loss, resolution, and FPS from inbound-rtp
                    if (report.type === 'inbound-rtp' && report.kind === 'video') {
                        packetsReceived = report.packetsReceived || 0;
                        packetsLost = report.packetsLost || 0;
                        if (report.frameWidth) frameWidth = report.frameWidth;
                        if (report.frameHeight) frameHeight = report.frameHeight;
                        if (report.framesPerSecond !== undefined) fps = Math.round(report.framesPerSecond);
                    }
                });

                // Calculate packet loss percentage (delta since last check)
                const deltaReceived = packetsReceived - prevPacketsReceived;
                const deltaLost = packetsLost - prevPacketsLost;
                const totalDelta = deltaReceived + deltaLost;
                let lossPercent = 0;

                if (totalDelta > 0) {
                    lossPercent = (deltaLost / totalDelta) * 100;
                }

                prevPacketsReceived = packetsReceived;
                prevPacketsLost = packetsLost;

                // Determine signal quality (4=excellent, 3=good, 2=fair, 1=poor)
                let signalQuality = 4; // Start with excellent

                if (rtt !== null) {
                    const rttMs = Math.round(rtt);
                    rttSpan.textContent = `${rttMs}ms`;

                    // RTT color coding
                    rttSpan.className = 'stat-value rtt-value';
                    if (rttMs < 100) {
                        rttSpan.classList.add('stat-good');
                    } else if (rttMs < 200) {
                        rttSpan.classList.add('stat-warning');
                        signalQuality = Math.min(signalQuality, 3);
                    } else if (rttMs < 400) {
                        rttSpan.classList.add('stat-warning');
                        signalQuality = Math.min(signalQuality, 2);
                    } else {
                        rttSpan.classList.add('stat-bad');
                        signalQuality = Math.min(signalQuality, 1);
                    }
                }

                // Update loss display
                lossSpan.textContent = `${lossPercent.toFixed(1)}%`;
                lossSpan.className = 'stat-value loss-value';
                if (lossPercent < 1) {
                    lossSpan.classList.add('stat-good');
                } else if (lossPercent < 3) {
                    lossSpan.classList.add('stat-warning');
                    signalQuality = Math.min(signalQuality, 3);
                } else if (lossPercent < 8) {
                    lossSpan.classList.add('stat-warning');
                    signalQuality = Math.min(signalQuality, 2);
                } else {
                    lossSpan.classList.add('stat-bad');
                    signalQuality = Math.min(signalQuality, 1);
                }

                // Update resolution and FPS
                resSpan.textContent = (frameWidth && frameHeight) ? `${frameWidth}×${frameHeight}` : '--';
                fpsSpan.textContent = fps !== null ? `${fps}` : '--';

                // Update signal bars appearance
                signalBars.className = 'signal-bars';
                if (signalQuality === 4) {
                    signalBars.classList.add('signal-excellent');
                } else if (signalQuality === 3) {
                    signalBars.classList.add('signal-good');
                } else if (signalQuality === 2) {
                    signalBars.classList.add('signal-fair');
                } else {
                    signalBars.classList.add('signal-poor');
                }

            } catch (error) {
                console.warn('Error getting stats:', error);
            }
        };

        // Poll stats every 5 seconds
        const intervalId = setInterval(updateStats, 5000);
        this.statsIntervals.set(peerId, intervalId);

        // Initial update
        updateStats();
    }

    stopStatsMonitoring(peerId) {
        const intervalId = this.statsIntervals.get(peerId);
        if (intervalId) {
            clearInterval(intervalId);
            this.statsIntervals.delete(peerId);
        }
    }

    startLocalStatsMonitoring() {
        const localContainer = document.getElementById('localContainer');
        if (!localContainer) return;

        // Create signal bars element for local
        const signalBars = document.createElement('div');
        signalBars.className = 'signal-bars';
        signalBars.id = 'localSignalBars';
        signalBars.innerHTML = `
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="bar"></div>
            <div class="signal-tooltip">
                <div class="stat-row">
                    <span class="stat-label">RTT:</span>
                    <span class="stat-value rtt-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Loss:</span>
                    <span class="stat-value loss-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Res:</span>
                    <span class="stat-value res-value">--</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">FPS:</span>
                    <span class="stat-value fps-value">--</span>
                </div>
            </div>
        `;
        localContainer.appendChild(signalBars);

        const rttSpan = signalBars.querySelector('.rtt-value');
        const lossSpan = signalBars.querySelector('.loss-value');
        const resSpan = signalBars.querySelector('.res-value');
        const fpsSpan = signalBars.querySelector('.fps-value');

        const updateLocalStats = async () => {
            if (this.peerConnections.size === 0) {
                signalBars.style.display = 'none';
                return;
            }
            signalBars.style.display = 'flex';

            let totalRtt = 0;
            let rttCount = 0;
            let totalPacketsSent = 0;
            let totalPacketsLost = 0;
            let frameWidth = null;
            let frameHeight = null;
            let fps = null;

            for (const [_peerId, peer] of this.peerConnections) {
                try {
                    const stats = await peer.connection.getStats();
                    stats.forEach(report => {
                        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                            if (report.currentRoundTripTime !== undefined) {
                                totalRtt += report.currentRoundTripTime * 1000;
                                rttCount++;
                            }
                        }
                        if (report.type === 'outbound-rtp' && report.kind === 'video') {
                            totalPacketsSent += report.packetsSent || 0;
                            if (report.frameWidth) frameWidth = report.frameWidth;
                            if (report.frameHeight) frameHeight = report.frameHeight;
                            if (report.framesPerSecond !== undefined) fps = Math.round(report.framesPerSecond);
                        }
                        if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                            totalPacketsLost += report.packetsLost || 0;
                        }
                    });
                } catch (_e) {
                    // Peer connection might be closed
                }
            }

            const avgRtt = rttCount > 0 ? Math.round(totalRtt / rttCount) : null;
            const lossPercent = totalPacketsSent > 0 ? (totalPacketsLost / totalPacketsSent) * 100 : 0;

            // Determine signal quality
            let signalQuality = 4;

            if (avgRtt !== null) {
                rttSpan.textContent = `${avgRtt}ms`;
                rttSpan.className = 'stat-value rtt-value';
                if (avgRtt < 100) {
                    rttSpan.classList.add('stat-good');
                } else if (avgRtt < 200) {
                    rttSpan.classList.add('stat-warning');
                    signalQuality = Math.min(signalQuality, 3);
                } else if (avgRtt < 400) {
                    rttSpan.classList.add('stat-warning');
                    signalQuality = Math.min(signalQuality, 2);
                } else {
                    rttSpan.classList.add('stat-bad');
                    signalQuality = Math.min(signalQuality, 1);
                }
            }

            lossSpan.textContent = `${lossPercent.toFixed(1)}%`;
            lossSpan.className = 'stat-value loss-value';
            if (lossPercent < 1) {
                lossSpan.classList.add('stat-good');
            } else if (lossPercent < 3) {
                lossSpan.classList.add('stat-warning');
                signalQuality = Math.min(signalQuality, 3);
            } else if (lossPercent < 8) {
                lossSpan.classList.add('stat-warning');
                signalQuality = Math.min(signalQuality, 2);
            } else {
                lossSpan.classList.add('stat-bad');
                signalQuality = Math.min(signalQuality, 1);
            }

            // Update resolution and FPS
            resSpan.textContent = (frameWidth && frameHeight) ? `${frameWidth}×${frameHeight}` : '--';
            fpsSpan.textContent = fps !== null ? `${fps}` : '--';

            // Update signal bars
            signalBars.className = 'signal-bars';
            if (signalQuality === 4) {
                signalBars.classList.add('signal-excellent');
            } else if (signalQuality === 3) {
                signalBars.classList.add('signal-good');
            } else if (signalQuality === 2) {
                signalBars.classList.add('signal-fair');
            } else {
                signalBars.classList.add('signal-poor');
            }
        };

        // Poll every 5 seconds
        this.localStatsInterval = setInterval(updateLocalStats, 5000);
        updateLocalStats();
    }

    stopLocalStatsMonitoring() {
        if (this.localStatsInterval) {
            clearInterval(this.localStatsInterval);
            this.localStatsInterval = null;
        }
        const localSignalBars = document.getElementById('localSignalBars');
        if (localSignalBars) localSignalBars.remove();
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
            this.prejoinStream = await navigator.mediaDevices.getUserMedia({
                video: this.getVideoConstraints(),
                audio: this.getAudioConstraints()
            });

            // Default: mic ON, camera OFF
            this.prejoinAudioEnabled = true;
            this.prejoinVideoEnabled = false;
            this.prejoinStream.getVideoTracks().forEach(t => { t.enabled = false; });

            document.getElementById('prejoinVideo').srcObject = this.prejoinStream;

            // Sync button states
            const audioBtn = document.getElementById('prejoinToggleAudioBtn');
            audioBtn.classList.remove('active');
            audioBtn.querySelector('.icon').textContent = '🎤';
            audioBtn.querySelector('.btn-status').textContent = 'ON';

            const videoBtn = document.getElementById('prejoinToggleVideoBtn');
            videoBtn.classList.add('active');
            videoBtn.querySelector('.icon').textContent = '📷';
            videoBtn.querySelector('.btn-status').textContent = 'OFF';

            const lwBtn = document.getElementById('prejoinLowBandwidthBtn');
            if (lwBtn) {
                lwBtn.classList.toggle('active', this.lowBandwidthMode);
                lwBtn.querySelector('.icon').textContent = this.lowBandwidthMode ? '📶' : '📡';
                lwBtn.querySelector('.btn-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
            }
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
            btn.querySelector('.btn-status').textContent = this.prejoinAudioEnabled ? 'ON' : 'OFF';
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
            btn.querySelector('.btn-status').textContent = this.prejoinVideoEnabled ? 'ON' : 'OFF';
        }
    }

    toggleLowBandwidth() {
        this.lowBandwidthMode = !this.lowBandwidthMode;
        localStorage.setItem('broference-low-bandwidth', String(this.lowBandwidthMode));

        // Update options menu button
        const optBtn = document.getElementById('lowBandwidthBtn');
        if (optBtn) {
            optBtn.setAttribute('data-enabled', String(this.lowBandwidthMode));
            optBtn.querySelector('.toggle-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
        }

        // Update prejoin button if on prejoin screen
        const prejoinBtn = document.getElementById('prejoinLowBandwidthBtn');
        if (prejoinBtn) {
            prejoinBtn.classList.toggle('active', this.lowBandwidthMode);
            prejoinBtn.querySelector('.icon').textContent = this.lowBandwidthMode ? '📶' : '📡';
            prejoinBtn.querySelector('.btn-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
        }

        // Re-apply constraints to the active video track
        const stream = this.localStream || this.prejoinStream;
        if (stream) {
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.applyConstraints(this.getVideoConstraints()).catch(err => {
                    console.warn('Could not apply video constraints:', err);
                });
            }
        }

        // Apply or remove bitrate caps on all existing peer connections
        this.applyBandwidthToSenders();

        console.log('Low bandwidth mode:', this.lowBandwidthMode ? 'ON' : 'OFF');
    }

    setPreferredCodecs(pc) {
        // Prefer H.264 for video — it has the widest hardware decoder support
        // (iOS, Android, and most desktop GPUs). VP9/VP8 are often software-decoded.
        if (!RTCRtpSender.getCapabilities || !RTCRtpReceiver.getCapabilities) return;

        const videoSend = RTCRtpSender.getCapabilities('video');
        const audioSend = RTCRtpSender.getCapabilities('audio');
        if (!videoSend || !audioSend) return;

        const videoOrder = ['H264', 'VP9', 'AV1', 'VP8'];
        const sortedVideo = [...videoSend.codecs].sort((a, b) => {
            const ai = videoOrder.findIndex(c => a.mimeType.toUpperCase().includes(c));
            const bi = videoOrder.findIndex(c => b.mimeType.toUpperCase().includes(c));
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        // Prefer Opus with stereo + high bitrate for audio
        const audioOrder = ['OPUS'];
        const sortedAudio = [...audioSend.codecs].sort((a, b) => {
            const ai = audioOrder.findIndex(c => a.mimeType.toUpperCase().includes(c));
            const bi = audioOrder.findIndex(c => b.mimeType.toUpperCase().includes(c));
            return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
        });

        pc.getTransceivers().forEach(transceiver => {
            try {
                const kind = transceiver.sender.track?.kind;
                if (kind === 'video') transceiver.setCodecPreferences(sortedVideo);
                else if (kind === 'audio') transceiver.setCodecPreferences(sortedAudio);
            } catch (e) {
                console.warn('Could not set codec preferences:', e);
            }
        });
    }

    applyBandwidthToSenders() {
        const videoBitrate = this.lowBandwidthMode ? 200000 : undefined; // 200kbps or uncapped
        const audioBitrate = this.lowBandwidthMode ? 32000 : undefined;  // 32kbps or uncapped

        this.peerConnections.forEach((peer) => {
            peer.connection.getSenders().forEach(sender => {
                if (!sender.track || !sender.getParameters) return;
                try {
                    const params = sender.getParameters();
                    if (!params.encodings || params.encodings.length === 0) return;
                    if (sender.track.kind === 'video') {
                        params.encodings[0].maxBitrate = videoBitrate;
                    } else if (sender.track.kind === 'audio') {
                        params.encodings[0].maxBitrate = audioBitrate;
                    }
                    sender.setParameters(params).catch(err => {
                        console.warn('Could not apply bandwidth limit:', err);
                    });
                } catch (err) {
                    console.warn('Error applying bandwidth limits:', err);
                }
            });
        });
    }

    async joinRoom() {
        const roomId = this.roomInput.value.trim();
        const password = this.passwordInput.value.trim() || null;
        this.roomPassword = password; // Store for WebSocket reconnection
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

            // Set local avatar and label
            const localAvatar = document.getElementById('localAvatar');
            if (localAvatar && this.username) {
                localAvatar.textContent = this.username.charAt(0).toUpperCase();
            }
            const localLabel = document.querySelector('#localContainer .video-label');
            if (localLabel && this.username) {
                localLabel.textContent = this.username;
            }

            // Set initial video state for local container
            const localContainer = document.getElementById('localContainer');
            if (!this.videoEnabled) {
                localContainer.classList.add('no-video');
            }

            // Click local tile to spotlight it
            localContainer.addEventListener('click', (e) => {
                if (e.target.closest('.video-controls')) return;
                this.toggleSpotlight('localContainer');
            });

            // Initialize video grid layout for 1 participant (local)
            this.updateVideoGridLayout();

            // Update main control buttons to match prejoin state
            const audioBtn = document.getElementById('toggleAudioBtn');
            audioBtn.classList.toggle('active', !this.audioEnabled);
            audioBtn.querySelector('.icon').textContent = this.audioEnabled ? '🎤' : '🔇';

            const videoBtn = document.getElementById('toggleVideoBtn');
            videoBtn.classList.toggle('active', !this.videoEnabled);
            videoBtn.querySelector('.icon').textContent = this.videoEnabled ? '📹' : '📷';

            // Start local connection stats monitoring
            this.startLocalStatsMonitoring();

            // Enable AI noise suppression by default (desktop only - can cause issues on mobile)
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            if (!isMobile) {
                this.toggleNoiseSuppression().catch(err => {
                    console.warn('Noise suppression not available:', err);
                });
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

    async createPeerConnection(peerId, peerUsername, createOffer = false, iceConfig = null) {
        console.log('Creating peer connection for', peerId, '(' + peerUsername + ')');

        const config = iceConfig || this.iceServers;
        const usingFallback = iceConfig === this.iceServersFallback;
        if (usingFallback) {
            console.warn('Using P2P fallback ICE config for', peerId);
        }

        const pc = new RTCPeerConnection(config);
        this.peerConnections.set(peerId, {
            connection: pc,
            username: peerUsername,
            isInitiator: createOffer,
            usingFallback,
            iceRestartCount: 0,
            lastIceRestartTime: 0
        });
        // Persist username across reconnections
        if (peerUsername && peerUsername !== 'User') {
            this.knownUsernames.set(peerId, peerUsername);
        }

        // Add local stream tracks with optimized RTP parameters
        // Use screenStream tracks if currently streaming video
        const activeStream = this.isScreenSharing && this.screenStream ? this.screenStream : this.localStream;
        activeStream.getTracks().forEach(track => {
            // Use processed audio track if noise suppression is enabled (only for mic audio)
            let trackToAdd = track;
            if (track.kind === 'audio' && !this.isScreenSharing && this.noiseSuppressionEnabled && this.processedStream) {
                const processedAudioTrack = this.processedStream.getAudioTracks()[0];
                if (processedAudioTrack) {
                    trackToAdd = processedAudioTrack;
                }
            }
            const sender = pc.addTrack(trackToAdd, activeStream);

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

                    if (this.lowBandwidthMode) {
                        parameters.encodings[0].maxBitrate = 32000; // 32kbps audio cap
                    }

                    sender.setParameters(parameters).catch(err => {
                        console.warn('Could not set audio encoding parameters:', err);
                    });
                }
            }

            // Cap video bitrate in low bandwidth mode
            if (track.kind === 'video' && this.lowBandwidthMode && sender.getParameters) {
                const parameters = sender.getParameters();
                if (parameters.encodings && parameters.encodings.length > 0) {
                    parameters.encodings[0].maxBitrate = 200000; // 200kbps video cap
                    sender.setParameters(parameters).catch(err => {
                        console.warn('Could not set video encoding parameters:', err);
                    });
                }
            }
        });

        // Prefer hardware-accelerated codecs (H.264 > VP9 > AV1 > VP8)
        this.setPreferredCodecs(pc);

        // Handle incoming tracks
        let streamAdded = false;
        pc.ontrack = (event) => {
            console.log('Received remote track from', peerId, 'kind:', event.track.kind);

            const stream = (event.streams && event.streams.length > 0) ? event.streams[0] : null;

            if (!streamAdded) {
                streamAdded = true;
                console.log('Remote stream:', stream);
                // Fall back to building a stream from the track if browser omits streams[]
                this.addRemoteVideo(peerId, peerUsername, stream || new MediaStream([event.track]));
            } else {
                // Subsequent track arrived (e.g. video after audio)
                const videoEl = document.querySelector(`#video-${peerId} video`);
                if (stream) {
                    // Browser provided the full stream — update srcObject if it changed
                    if (videoEl && videoEl.srcObject !== stream) {
                        console.log('Updating video srcObject for', peerId, 'with new stream containing', stream.getTracks().length, 'tracks');
                        videoEl.srcObject = stream;
                    }
                } else if (videoEl && videoEl.srcObject) {
                    // No stream on event — add track directly to the existing MediaStream
                    console.log('Adding', event.track.kind, 'track directly to existing stream for', peerId);
                    videoEl.srcObject.addTrack(event.track);
                }
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

        pc.onicegatheringstatechange = () => {
            console.log('ICE gathering state for', peerUsername, ':', pc.iceGatheringState);
        };

        // Connection state changes
        pc.onconnectionstatechange = () => {
            console.log('Connection state with', peerId, '(' + peerUsername + '):', pc.connectionState);

            if (pc.connectionState === 'connected') {
                console.log('Successfully connected to', peerUsername);
                // Reset restart counter on successful connection
                const peerData = this.peerConnections.get(peerId);
                if (peerData) {
                    peerData.iceRestartCount = 0;
                    peerData.lastIceRestartTime = 0;
                }
                // Clear TURN failure flag so TURN is retried if they disconnect and reconnect
                this.turnFailedPeers.delete(peerId);
            } else if (pc.connectionState === 'failed') {
                console.error('Connection failed with', peerUsername, '- attempting ICE restart');
                this.turnFailedPeers.add(peerId);
                this.attemptIceRestart(peerId).catch(() => {});
                // If still failed after giving ICE restart time to work, remove.
                // 20 s gives enough time for a new offer/answer + ICE candidate exchange to complete.
                setTimeout(() => {
                    const current = this.peerConnections.get(peerId);
                    if (current && current.connection === pc && pc.connectionState === 'failed') {
                        console.warn('ICE restart did not recover connection to', peerUsername, ', removing');
                        this.removePeerConnection(peerId);
                    }
                }, 20000);
            } else if (pc.connectionState === 'disconnected') {
                console.warn('Disconnected from', peerUsername);
                // Some browsers never transition disconnected→failed; attempt ICE restart after a short delay
                setTimeout(() => {
                    const current = this.peerConnections.get(peerId);
                    if (current && current.connection === pc && pc.connectionState === 'disconnected') {
                        console.log('Still disconnected from', peerUsername, 'after 6s, attempting ICE restart');
                        this.attemptIceRestart(peerId).catch(() => {});
                    }
                }, 6000);
                // Remove if still disconnected after 30s (ICE restart had ~24s to work)
                setTimeout(() => {
                    const current = this.peerConnections.get(peerId);
                    if (current && current.connection === pc && pc.connectionState === 'disconnected') {
                        console.log('Still disconnected from', peerUsername, 'after 30s, removing connection');
                        this.removePeerConnection(peerId);
                    }
                }, 30000);
            }
        };

        // ICE connection state changes (more detailed than connection state)
        pc.oniceconnectionstatechange = () => {
            console.log('ICE connection state with', peerId, '(' + peerUsername + '):', pc.iceConnectionState);
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

        const useFallback = this.turnFailedPeers.has(senderId);

        // If peer exists but PC is dead, tear it down so we recreate below
        if (this.peerConnections.has(senderId)) {
            const existingPeer = this.peerConnections.get(senderId);
            const state = existingPeer.connection.connectionState;
            if (state === 'failed' || state === 'closed') {
                this.removePeerConnection(senderId);
            }
        }

        // Create peer connection if it doesn't exist
        if (!this.peerConnections.has(senderId)) {
            const username = this.pendingUsernames.get(senderId) || this.knownUsernames.get(senderId) || 'User';
            this.pendingUsernames.delete(senderId);
            const iceConfig = useFallback ? this.iceServersFallback : null;
            await this.createPeerConnection(senderId, username, false, iceConfig);
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

        if (peer.connection.signalingState !== 'have-local-offer') {
            console.warn('Dropping stale answer from', senderId, '- signalingState:', peer.connection.signalingState);
            return;
        }

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
            // Peer connection doesn't exist yet — queue for when it's created
            console.log(`Queueing ICE candidate for ${senderId} (peer connection not yet created)`);
            if (!this.pendingIceCandidates.has(senderId)) {
                this.pendingIceCandidates.set(senderId, []);
            }
            this.pendingIceCandidates.get(senderId).push(candidate);
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
            console.error('Error adding ICE candidate for', senderId, error);
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
        video.setAttribute('playsinline', '');  // Additional attribute for iOS
        video.setAttribute('webkit-playsinline', '');  // For older iOS versions

        // Start muted to ensure autoplay works, will auto-unmute after playback starts
        video.muted = true;

        // Set srcObject
        video.srcObject = stream;

        const label = document.createElement('div');
        label.className = 'video-label';
        // Add crown for moderator
        if (peerId === this.moderatorId) {
            const crownSpan = document.createElement('span');
            crownSpan.className = 'mod-crown';
            crownSpan.textContent = '👑';
            label.appendChild(crownSpan);
            label.appendChild(document.createTextNode(' ' + username));
        } else {
            label.textContent = username;
        }

        // Add avatar for when video is off
        const avatar = document.createElement('div');
        avatar.className = 'video-avatar';
        avatar.textContent = username.charAt(0).toUpperCase();
        container.appendChild(avatar);

        // Monitor video track to show/hide avatar
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            // Check initial state
            if (!videoTrack.enabled || videoTrack.muted) {
                container.classList.add('no-video');
            }

            // Listen for track state changes
            videoTrack.onmute = () => {
                console.log(`Video track muted for ${username}`);
                container.classList.add('no-video');
            };
            videoTrack.onunmute = () => {
                console.log(`Video track unmuted for ${username}`);
                container.classList.remove('no-video');
            };
            videoTrack.onended = () => {
                console.warn(`Video track ended for ${username}`);
                container.classList.add('no-video');
            };

            // Periodic health check for frozen video
            const healthCheckInterval = setInterval(() => {
                const peer = this.peerConnections.get(peerId);
                if (!peer) {
                    clearInterval(healthCheckInterval);
                    return;
                }

                // Check if video element is actually receiving frames
                if (video.videoWidth === 0 && video.videoHeight === 0 && !container.classList.contains('no-video')) {
                    console.warn(`Video frozen for ${username}, no frames received`);
                    // Don't immediately show avatar, peer might have camera off intentionally
                }
            }, 5000);

            // Store interval for cleanup
            container.dataset.healthCheckInterval = healthCheckInterval;
        } else {
            container.classList.add('no-video');
        }

        // Add audio controls for remote users
        const audioControls = this.createAudioControls(peerId);
        container.appendChild(audioControls);

        container.appendChild(video);
        container.appendChild(label);
        this.videoGrid.appendChild(container);

        // Update grid layout for new participant count
        this.updateVideoGridLayout();

        // Add click handler for spotlight mode
        container.addEventListener('click', (e) => {
            // Don't trigger spotlight if clicking on controls
            if (e.target.closest('.remote-audio-controls')) return;
            this.toggleSpotlight(`video-${peerId}`);
        });
        container.style.cursor = 'pointer';

        // Store video element reference for volume control
        this.remoteAudioControls.set(peerId, {
            videoElement: video,
            isMuted: false
        });

        // FIREFOX FIX: Wait for loadedmetadata before playing
        // This ensures the video element is ready, especially important for Firefox
        video.addEventListener('loadedmetadata', () => {
            console.log(`Video metadata loaded for ${username}, attempting playback`);

            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise
                    .then(() => {
                        console.log(`Video playing for ${username}, muted: ${video.muted}`);
                        // Auto-unmute after successful playback
                        video.muted = false;
                        console.log(`Audio auto-unmuted for ${username}`);

                        // Update the mute button state
                        const muteBtn = container.querySelector('.remote-audio-controls button');
                        if (muteBtn) {
                            muteBtn.textContent = '🔊';
                            muteBtn.classList.remove('muted');
                        }
                    })
                    .catch(err => {
                        console.warn('Video autoplay failed for', username, err);
                        // If muted autoplay still fails, show play button
                        this.addPlayButtonOverlay(container, video, username);
                    });
            }
        }, { once: true });

        // Start monitoring for speaking indicator
        this.monitorAudioLevel(stream, container);

        // Start connection stats monitoring
        console.log('About to start stats monitoring for:', peerId);
        const peer = this.peerConnections.get(peerId);
        console.log('Peer found:', !!peer, 'Connection:', peer ? !!peer.connection : 'N/A');
        if (peer && peer.connection) {
            this.startStatsMonitoring(peerId, peer.connection, container);
        } else {
            console.warn('Could not start stats monitoring - peer not found');
        }

        // Re-broadcast our audio/video state so the new peer knows our current state
        this.sendMessage({
            type: 'audio-state',
            audioEnabled: this.audioEnabled
        });
        this.sendMessage({
            type: 'video-state',
            videoEnabled: this.videoEnabled
        });

        this.updateRoomInfo(this.peerConnections.size + 1);

        // Ensure all containers still have mod controls after a new peer was added
        this.refreshModeratorControls();
    }

    createAudioControls(peerId) {
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'remote-audio-controls';

        // Mute button
        const muteBtn = document.createElement('button');
        muteBtn.textContent = '🔊';
        muteBtn.title = 'Mute/Unmute';
        muteBtn.onclick = () => this.toggleRemoteMute(peerId, muteBtn);

        // Hide video button
        const hideVideoBtn = document.createElement('button');
        hideVideoBtn.textContent = '📹';
        hideVideoBtn.title = 'Hide/Show Video';
        hideVideoBtn.onclick = () => this.toggleRemoteVideo(peerId, hideVideoBtn);

        // Volume slider
        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.title = 'Volume';
        volumeSlider.oninput = (e) => this.setRemoteVolume(peerId, e.target.value / 100);

        controlsDiv.appendChild(muteBtn);
        controlsDiv.appendChild(hideVideoBtn);
        controlsDiv.appendChild(volumeSlider);

        // Moderator controls are added by refreshModeratorControls() after the
        // container is in the DOM, so they are always up-to-date on join/leave.
        return controlsDiv;
    }

    // Add/ensure moderator controls on every remote video container.
    // Safe to call multiple times — skips containers that already have them.
    refreshModeratorControls() {
        if (!this.isModerator) return;

        this.peerConnections.forEach((peer, peerId) => {
            const audioControls = document.querySelector(`#video-${peerId} .remote-audio-controls`);
            if (!audioControls) return;

            // Skip if mod controls already present
            if (audioControls.querySelector('[data-mod-control]')) return;

            if (peerId !== this.moderatorId) {
                const promoteBtn = document.createElement('button');
                promoteBtn.textContent = '👑';
                promoteBtn.title = 'Promote to moderator';
                promoteBtn.dataset.modControl = 'promote';
                promoteBtn.onclick = () => this.promoteToModerator(peerId);
                audioControls.appendChild(promoteBtn);
            }

            const renameBtn = document.createElement('button');
            renameBtn.textContent = '✏️';
            renameBtn.title = 'Change user name';
            renameBtn.dataset.modControl = 'rename';
            renameBtn.onclick = () => this.moderatorChangeName(peerId);

            const kickBtn = document.createElement('button');
            kickBtn.textContent = '👢';
            kickBtn.title = 'Kick user';
            kickBtn.dataset.modControl = 'kick';
            kickBtn.onclick = () => this.kickUser(peerId);

            const banBtn = document.createElement('button');
            banBtn.textContent = '🚫';
            banBtn.title = 'Ban user';
            banBtn.dataset.modControl = 'ban';
            banBtn.onclick = () => this.banUser(peerId);

            audioControls.appendChild(renameBtn);
            audioControls.appendChild(kickBtn);
            audioControls.appendChild(banBtn);
        });
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

    promoteToModerator(targetId) {
        if (!this.isModerator) {
            alert('Only moderator can promote users');
            return;
        }

        const peer = this.peerConnections.get(targetId);
        if (!peer) return;

        if (confirm(`Promote ${peer.username} to moderator?`)) {
            this.sendMessage({
                type: 'promote-moderator',
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
                video.muted = false;
                await video.play();
                overlay.remove();
                console.log(`Video playing for ${username} after user interaction`);
            } catch (err) {
                console.error('Still cannot play video for', username, err);
            }
        };

        container.style.position = 'relative';
        container.appendChild(overlay);
    }

    addUnmuteOverlay(container, video, username) {
        // Check if overlay already exists
        if (container.querySelector('.unmute-overlay')) return;

        const overlay = document.createElement('div');
        overlay.className = 'unmute-overlay';
        overlay.innerHTML = '🔇 Tap to unmute';
        overlay.style.cssText = `
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 0, 0, 0.8);
            color: #00ff41;
            padding: 15px 25px;
            border: 2px solid #00ff41;
            cursor: pointer;
            z-index: 10;
            font-size: 16px;
            font-family: 'Courier New', monospace;
            text-transform: uppercase;
            letter-spacing: 1px;
        `;

        overlay.onclick = () => {
            video.muted = false;
            overlay.remove();
            console.log(`Audio unmuted for ${username}`);

            // Update the mute button state in remote audio controls
            const controls = container.querySelector('.remote-audio-controls button');
            if (controls) {
                controls.textContent = '🔊';
                controls.classList.remove('muted');
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

        // Clean up stats monitoring
        this.stopStatsMonitoring(peerId);

        // Clean up pending data
        this.pendingUsernames.delete(peerId);
        this.pendingIceCandidates.delete(peerId);

        const container = document.getElementById(`video-${peerId}`);
        if (container) {
            // Clean up health check interval
            if (container.dataset.healthCheckInterval) {
                clearInterval(parseInt(container.dataset.healthCheckInterval));
            }
            container.remove();
        }

        this.updateRoomInfo(this.peerConnections.size + 1);

        // After a peer leaves, verify remaining containers still have mod controls
        this.refreshModeratorControls();
    }

    async attemptIceRestart(peerId) {
        const peer = this.peerConnections.get(peerId);
        if (!peer) {
            console.warn('Cannot restart ICE for peer', peerId, '- peer not found');
            return;
        }

        // Only the original offer initiator sends ICE restarts.
        // The responder just answers incoming offers — this prevents glare.
        if (!peer.isInitiator) {
            console.log('Not initiator for peer', peerId, '- skipping ICE restart, waiting for their offer');
            return;
        }

        const MAX_RESTARTS = 2;
        const MIN_RESTART_INTERVAL_MS = 4000;

        const now = Date.now();
        const timeSinceLast = now - (peer.lastIceRestartTime || 0);

        if (peer.iceRestartCount >= MAX_RESTARTS) {
            if (!peer.usingFallback) {
                console.warn('TURN relay failed for peer', peerId, '- falling back to P2P');
                this.reconnectWithFallback(peerId);
            } else {
                console.warn('ICE restart limit reached for peer', peerId, '(already on P2P fallback) - giving up');
            }
            return;
        }

        if (timeSinceLast < MIN_RESTART_INTERVAL_MS) {
            const delay = MIN_RESTART_INTERVAL_MS - timeSinceLast;
            console.log(`ICE restart for ${peerId} throttled, retrying in ${delay}ms`);
            const pcAtQueueTime = peer.connection;
            setTimeout(() => {
                // Abort if the PC was replaced (e.g. by reconnectWithFallback) while we waited
                const currentPeer = this.peerConnections.get(peerId);
                if (!currentPeer || currentPeer.connection !== pcAtQueueTime) return;
                this.attemptIceRestart(peerId);
            }, delay);
            return;
        }

        peer.iceRestartCount = (peer.iceRestartCount || 0) + 1;
        peer.lastIceRestartTime = now;

        console.log(`Attempting ICE restart #${peer.iceRestartCount} for peer`, peerId);
        try {
            const offer = await peer.connection.createOffer({ iceRestart: true });
            await peer.connection.setLocalDescription(offer);
            this.sendMessage({
                type: 'offer',
                targetId: peerId,
                data: offer
            });
            console.log('ICE restart offer sent to peer', peerId);
        } catch (err) {
            console.error('ICE restart failed for peer', peerId, ':', err);
        }
    }

    async reconnectWithFallback(peerId) {
        const peer = this.peerConnections.get(peerId);
        if (!peer || !peer.isInitiator) return;

        const username = peer.username;
        console.log('Reconnecting to', peerId, 'with P2P fallback ICE config');

        this.removePeerConnection(peerId);
        await this.createPeerConnection(peerId, username, true, this.iceServersFallback);
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

                // If screen audio is available, mix it with mic and replace audio track
                this.mixScreenAudio(this.screenStream);

                // Update local video to show screen
                this.localVideo.srcObject = this.screenStream;

                // Handle stream end (user clicks "Stop sharing" in browser UI)
                screenVideoTrack.onended = () => {
                    this.toggleScreenShare();
                };

                this.isScreenSharing = true;
                document.getElementById('shareScreenBtn').classList.add('active');

                // Hide avatar when screen sharing (screen is visible content)
                document.getElementById('localContainer').classList.remove('no-video');

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

            // Restore original mic audio (unmix screen audio)
            this.unmixScreenAudio();

            // Remove YouTube window tile if present
            const ytTile = document.getElementById('yt-share-tile');
            if (ytTile) {
                ytTile.remove();
                this.updateVideoGridLayout();
            }

            this.localVideo.srcObject = this.localStream;
            this.isScreenSharing = false;
            document.getElementById('shareScreenBtn').classList.remove('active');
            document.getElementById('shareTabBtn').classList.remove('active');

            // Restore avatar if video is off
            if (!this.videoEnabled) {
                document.getElementById('localContainer').classList.add('no-video');
            }

            console.log('Screen sharing stopped');
        }
    }

    async shareYouTubeWindow() {
        // If already sharing, stop
        if (this.isScreenSharing) {
            await this.toggleScreenShare();
            return;
        }

        const inputUrl = document.getElementById('videoUrlInput').value.trim();
        const openUrl = inputUrl || 'https://www.youtube.com';

        // Open YouTube in a popup — popup windows allow audio capture unlike embedded tabs
        const popup = window.open(openUrl, 'yt_share', 'width=1280,height=720,menubar=no,toolbar=no,location=yes');
        if (!popup) {
            this.addChatMessage('System', '⚠️ Popup blocked. Allow popups for this site and try again.', true);
            return;
        }

        this.addChatMessage('System', '🎬 YouTube window opened. In the picker: select the YouTube window and enable "Share audio".', true);

        try {
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: { displaySurface: 'window', cursor: 'always' },
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000 },
                systemAudio: 'include'
            });

            const screenVideoTrack = this.screenStream.getVideoTracks()[0];
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(screenVideoTrack);
            });

            this.mixScreenAudio(this.screenStream);
            this.addScreenShareTile('yt-share-tile', '📺 YouTube Share', this.screenStream);
            screenVideoTrack.onended = () => this.toggleScreenShare();

            this.isScreenSharing = true;
            document.getElementById('shareScreenBtn').classList.add('active');
            document.getElementById('watchTogetherPanel').classList.add('hidden');

            const audioTracks = this.screenStream.getAudioTracks();
            if (audioTracks.length === 0) {
                this.addChatMessage('System', '⚠️ No audio captured — make sure to check "Share audio" in the picker.', true);
            } else {
                this.addChatMessage('System', '✅ YouTube window sharing with audio active.', true);
            }

        } catch (error) {
            if (error.name !== 'NotAllowedError') {
                console.error('Error sharing YouTube window:', error);
            }
        }
    }

    async shareTabWithAudio() {
        // If already sharing, stop it
        if (this.isScreenSharing) {
            await this.toggleScreenShare();
            return;
        }

        try {
            // Request tab capture specifically with audio
            // preferCurrentTab hints to browser to show current tab option first
            this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: {
                    displaySurface: 'browser', // Prefer browser tab
                    cursor: 'always'
                },
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                    sampleRate: 48000
                },
                preferCurrentTab: true, // Chrome 94+ - prefer current tab
                selfBrowserSurface: 'include', // Chrome 107+ - include current tab
                systemAudio: 'include' // Include system audio
            });

            // Check if we got audio
            const audioTracks = this.screenStream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('No audio captured - user may need to check "Share audio" option');
                this.addChatMessage('System', '⚠️ No audio captured. When sharing, check "Share tab audio" or "Share system audio" option.', true);
            } else {
                console.log('Tab audio captured successfully');
                this.addChatMessage('System', '🎬 Sharing tab with audio', true);
            }

            // Replace video track in all peer connections
            const screenVideoTrack = this.screenStream.getVideoTracks()[0];
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(screenVideoTrack);
                }
            });

            // Mix tab audio with mic audio and replace audio track (no renegotiation needed)
            this.mixScreenAudio(this.screenStream);

            // Update local video
            this.localVideo.srcObject = this.screenStream;

            // Handle stream end
            screenVideoTrack.onended = () => {
                this.toggleScreenShare(); // Use existing cleanup logic
            };

            this.isScreenSharing = true;
            document.getElementById('shareTabBtn').classList.add('active');
            document.getElementById('localContainer').classList.remove('no-video');

            console.log('Tab sharing with audio started');

        } catch (error) {
            console.error('Error sharing tab:', error);
            if (error.name === 'NotAllowedError') {
                // User cancelled
            } else {
                alert('Could not share tab. Try using "Share Screen" instead.');
            }
        }
    }

    mixScreenAudio(screenStream) {
        const screenAudioTracks = screenStream.getAudioTracks();
        if (screenAudioTracks.length === 0) {
            console.log('No screen audio available to mix');
            return;
        }

        try {
            // Mix mic + screen audio into a single track using Web Audio API
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

            // Get current mic track (handles noise suppression)
            const currentMicTrack = (this.noiseSuppressionEnabled && this.processedStream)
                ? this.processedStream.getAudioTracks()[0]
                : this.localStream.getAudioTracks()[0];

            const micSource = audioCtx.createMediaStreamSource(new MediaStream([currentMicTrack]));
            const screenSource = audioCtx.createMediaStreamSource(new MediaStream([screenAudioTracks[0]]));
            const dest = audioCtx.createMediaStreamDestination();

            // Connect both sources to the destination (mixes them)
            micSource.connect(dest);
            screenSource.connect(dest);

            const mixedTrack = dest.stream.getAudioTracks()[0];

            // Replace audio track with mixed track in all peers (no renegotiation needed)
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    sender.replaceTrack(mixedTrack);
                }
            });

            this.screenAudioContext = audioCtx;
            this.screenMixedTrack = mixedTrack;
            console.log('Screen audio mixed with mic audio');
        } catch (error) {
            console.error('Error mixing screen audio:', error);
        }
    }

    unmixScreenAudio() {
        if (!this.screenAudioContext) return;

        // Restore original mic track
        const micTrack = (this.noiseSuppressionEnabled && this.processedStream)
            ? this.processedStream.getAudioTracks()[0]
            : this.localStream.getAudioTracks()[0];

        this.peerConnections.forEach(peer => {
            const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
            if (sender) {
                sender.replaceTrack(micTrack);
            }
        });

        this.screenAudioContext.close();
        this.screenAudioContext = null;
        this.screenMixedTrack = null;
        console.log('Restored original mic audio');
    }

    toggleWatchTogether() {
        const panel = document.getElementById('watchTogetherPanel');
        const btn = document.getElementById('watchTogetherBtn');
        panel.classList.toggle('hidden');
        btn.classList.toggle('active');
    }

    async loadWatchVideo() {
        const urlInput = document.getElementById('videoUrlInput');
        const url = urlInput.value.trim();

        if (!url) return;

        // Check if it's a YouTube URL - need to convert to embed
        const youtubeId = this.extractYouTubeId(url);

        if (youtubeId) {
            // For YouTube, we need to use an iframe in a hidden container and capture via canvas
            this.streamYouTubeVideo(youtubeId);
        } else {
            // Direct video URL - load in video element and capture
            this.streamDirectVideo(url);
        }
    }

    extractYouTubeId(url) {
        const patterns = [
            /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\s?]+)/,
            /youtube\.com\/shorts\/([^&\s?]+)/
        ];
        for (const pattern of patterns) {
            const match = url.match(pattern);
            if (match) return match[1];
        }
        return null;
    }

    async streamDirectVideo(url) {
        // Only allow relative paths or http/https URLs
        if (!/^(https?:\/\/|\/)/.test(url)) {
            console.warn('streamDirectVideo: rejected URL with unsafe scheme');
            return;
        }
        try {
            // Remove any existing stream container
            const existingContainer = document.getElementById('streamVideoContainer');
            if (existingContainer) existingContainer.remove();

            // Clean up previous stream audio context
            if (this.streamAudioContext) {
                this.streamAudioContext.close();
                this.streamAudioContext = null;
                this.streamGainNode = null;
            }

            // Create hidden container for video element (must be in DOM for captureStream)
            const container = document.createElement('div');
            container.id = 'streamVideoContainer';
            container.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;';

            const video = document.createElement('video');
            video.src = url;
            video.loop = true;
            video.muted = true; // Start muted to allow autoplay
            video.playsInline = true;
            video.crossOrigin = 'anonymous';

            container.appendChild(video);
            document.body.appendChild(container);

            // Wait for video to be ready
            await new Promise((resolve, reject) => {
                video.onloadedmetadata = resolve;
                video.onerror = () => reject(new Error('Failed to load video'));
                setTimeout(() => reject(new Error('Video load timeout')), 15000);
            });

            await video.play();

            // Use Web Audio API to route audio properly:
            // - createMediaElementSource captures decoded audio
            // - GainNode provides local volume control
            // - MediaStreamDestination provides full-volume audio track for peers
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            if (audioCtx.state === 'suspended') {
                await audioCtx.resume();
            }
            const mediaSource = audioCtx.createMediaElementSource(video);
            // After createMediaElementSource, the video element no longer outputs audio directly
            // so unmuting is safe (no double audio) and required for the audio decoder to run
            video.muted = false;

            // Local playback with volume control
            const gainNode = audioCtx.createGain();
            mediaSource.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            // Audio track for peer connections (full volume, unaffected by local slider)
            const peerDest = audioCtx.createMediaStreamDestination();
            mediaSource.connect(peerDest);
            const peerAudioTrack = peerDest.stream.getAudioTracks()[0];

            // Capture video track from element
            const capturedStream = video.captureStream();
            const videoTrack = capturedStream.getVideoTracks()[0];

            // Combine video track with peer audio track
            const stream = new MediaStream();
            if (videoTrack) stream.addTrack(videoTrack);
            if (peerAudioTrack) stream.addTrack(peerAudioTrack);

            // Debug: log what tracks we have
            console.log('Stream tracks - Video:', stream.getVideoTracks().length, 'Audio:', stream.getAudioTracks().length);
            if (peerAudioTrack) {
                console.log('Audio track:', peerAudioTrack.label, 'enabled:', peerAudioTrack.enabled);
            } else {
                console.warn('NO AUDIO TRACK! Video might not have audio or CORS issue.');
            }

            // Store audio context and gain node for volume control
            this.streamAudioContext = audioCtx;
            this.streamGainNode = gainNode;

            this.startVideoStream(stream, video);
            this.toggleWatchTogether();
            this.addChatMessage('System', '📺 Streaming video to room', true);

        } catch (error) {
            console.error('Error streaming video:', error);
            this.updateWatchStatus('Failed - ' + error.message);
            // Clean up on error
            const container = document.getElementById('streamVideoContainer');
            if (container) container.remove();
            if (this.streamAudioContext) {
                this.streamAudioContext.close();
                this.streamAudioContext = null;
                this.streamGainNode = null;
            }
        }
    }

    async streamYouTubeVideo(videoId) {
        this.updateWatchStatus('Fetching video stream...');

        try {
            // Call backend proxy through nginx
            const response = await fetch('/api/youtube', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` })
            });

            const data = await response.json();

            if (data.error) {
                console.error('Proxy error:', data.error);
                this.updateWatchStatus('Error: ' + data.error);
                return;
            }

            // Got proxied URL, stream it through nginx
            const streamUrl = data.url.replace('/stream?', '/api/stream?');
            await this.streamDirectVideo(streamUrl);

        } catch (error) {
            console.error('Error fetching video:', error);
            this.updateWatchStatus('Failed to fetch video');
        }
    }

    startVideoStream(stream, sourceElement = null) {
        // Store for cleanup
        this.streamSourceElement = sourceElement;
        this.screenStream = stream;

        // Log stream tracks for debugging
        console.log('Starting video stream with tracks:', stream.getTracks().map(t => `${t.kind}: ${t.label}, enabled: ${t.enabled}`));

        // Replace video track in all peer connections
        const videoTrack = stream.getVideoTracks()[0];
        this.peerConnections.forEach(peer => {
            const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
        });

        // Replace audio track if stream has audio
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) {
            console.log('Stream has audio track, replacing in peers');
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) {
                    sender.replaceTrack(audioTrack);
                    console.log('Replaced audio track for peer');
                } else {
                    console.warn('No audio sender found for peer');
                }
            });
        } else {
            console.warn('Stream has no audio track!');
        }

        // Update local video
        this.localVideo.srcObject = stream;
        this.isScreenSharing = true;
        document.getElementById('watchTogetherBtn').classList.add('active');
        document.getElementById('localContainer').classList.remove('no-video');
        document.getElementById('stopStreamBtn').classList.remove('hidden');

        // Show volume controls for sharer
        this.showStreamVolumeControls(sourceElement);

        // Handle stream end
        videoTrack.onended = () => this.stopVideoStream();
    }

    stopVideoStream() {
        // Find senders BEFORE stopping tracks
        const senderUpdates = [];
        const cameraTrack = this.localStream.getVideoTracks()[0];
        // Use processed audio if noise suppression is on, otherwise use raw mic
        const micTrack = (this.noiseSuppressionEnabled && this.processedStream)
            ? this.processedStream.getAudioTracks()[0]
            : this.localStream.getAudioTracks()[0];

        this.peerConnections.forEach(peer => {
            const senders = peer.connection.getSenders();
            const videoSender = senders.find(s => s.track && s.track.kind === 'video');
            const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
            senderUpdates.push({ videoSender, audioSender });
        });

        // Now stop the stream tracks
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
        }
        if (this.streamSourceElement) {
            this.streamSourceElement.pause();
            this.streamSourceElement = null;
        }

        // Restore camera and mic using cached senders
        senderUpdates.forEach(({ videoSender, audioSender }) => {
            if (videoSender && cameraTrack) videoSender.replaceTrack(cameraTrack);
            if (audioSender && micTrack) audioSender.replaceTrack(micTrack);
        });
        console.log('Restored camera and mic tracks');

        this.localVideo.srcObject = this.localStream;
        this.isScreenSharing = false;
        this.screenStream = null;
        document.getElementById('watchTogetherBtn').classList.remove('active');
        document.getElementById('stopStreamBtn').classList.add('hidden');
        this.updateWatchStatus('');

        if (!this.videoEnabled) {
            document.getElementById('localContainer').classList.add('no-video');
        }

        // Clean up stream audio context
        if (this.streamAudioContext) {
            this.streamAudioContext.close();
            this.streamAudioContext = null;
            this.streamGainNode = null;
        }

        // Clean up video containers and volume controls
        const ytContainer = document.getElementById('ytStreamContainer');
        if (ytContainer) ytContainer.remove();
        const streamContainer = document.getElementById('streamVideoContainer');
        if (streamContainer) streamContainer.remove();
        this.hideStreamVolumeControls();
    }

    showStreamVolumeControls(sourceElement) {
        // Remove existing controls
        this.hideStreamVolumeControls();

        if (!sourceElement && !this.streamGainNode) {
            console.warn('No source element or gain node for volume controls');
            return;
        }

        // Store reference
        this.streamVolumeElement = sourceElement;
        const currentVolume = this.streamGainNode ? Math.round(this.streamGainNode.gain.value * 100) : 100;
        console.log('Setting up volume controls, using GainNode:', !!this.streamGainNode, 'volume:', currentVolume);

        const controls = document.createElement('div');
        controls.id = 'streamVolumeControls';
        controls.innerHTML = `
            <span>🔊</span>
            <input type="range" id="streamVolumeSlider" min="0" max="100" value="${currentVolume}">
            <span id="streamVolumeValue">${currentVolume}%</span>
        `;

        // Insert inside local video container
        const localContainer = document.getElementById('localContainer');
        localContainer.appendChild(controls);

        // Wire up slider to GainNode for reliable volume control
        const slider = document.getElementById('streamVolumeSlider');
        const valueDisplay = document.getElementById('streamVolumeValue');
        const self = this;
        slider.oninput = function() {
            const volume = this.value / 100;
            if (self.streamGainNode) {
                self.streamGainNode.gain.value = volume;
            }
            valueDisplay.textContent = this.value + '%';
        };
    }

    hideStreamVolumeControls() {
        const controls = document.getElementById('streamVolumeControls');
        if (controls) controls.remove();
    }

    updateWatchStatus(msg) {
        const status = document.getElementById('watchStatus');
        if (status) status.textContent = msg;
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

            // Notify other users of audio state change
            this.sendMessage({
                type: 'audio-state',
                audioEnabled: this.audioEnabled
            });
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

            // Show/hide avatar when video is toggled
            const localContainer = document.getElementById('localContainer');
            localContainer.classList.toggle('no-video', !this.videoEnabled);

            // Notify other users of video state change
            this.sendMessage({
                type: 'video-state',
                videoEnabled: this.videoEnabled
            });
        }
    }

    toggleChat() {
        this.chatVisible = !this.chatVisible;
        this.chatSidebar.classList.toggle('hidden', !this.chatVisible);

        // Clear unread count when opening chat
        if (this.chatVisible) {
            this.unreadMessageCount = 0;
            this.updateChatNotification();
            setTimeout(() => this.chatInput.focus(), 50);
        }
    }

    toggleOptionsMenu() {
        const optionsMenu = document.getElementById('optionsMenu');
        const optionsOverlay = document.getElementById('optionsOverlay');
        optionsMenu.classList.toggle('hidden');
        optionsOverlay.classList.toggle('hidden');
    }

    async toggleNoiseSuppression() {
        const btn = document.getElementById('noiseSuppressionBtn');
        const noiseGateSettings = document.getElementById('noiseGateSettings');

        if (!this.noiseSuppressionEnabled) {
            try {
                // Initialize audio context
                if (!this.audioContext) {
                    this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                    // Use simple noise gate processor (RNNoise WASM has loading issues in AudioWorklet)
                    await this.audioContext.audioWorklet.addModule('noise-processor.js');
                }

                // Resume context if suspended
                if (this.audioContext.state === 'suspended') {
                    await this.audioContext.resume();
                }

                // Create the noise suppression processor node
                this.noiseSuppressionNode = new AudioWorkletNode(this.audioContext, 'noise-suppression-processor');

                // Set up audio level reporting from the processor
                this.noiseSuppressionNode.port.onmessage = (event) => {
                    if (event.data.type === 'audioLevel') {
                        this.handleAudioLevelUpdate(event.data);
                    }
                };

                // Start the port
                this.noiseSuppressionNode.port.start();

                // Apply saved threshold setting
                this.updateNoiseGateThreshold(this.noiseGateThreshold);

                // Get the current audio track
                const audioTrack = this.localStream.getAudioTracks()[0];
                if (!audioTrack) {
                    throw new Error('No audio track available');
                }

                // Create a new stream from the audio track
                const sourceStream = new MediaStream([audioTrack]);
                const source = this.audioContext.createMediaStreamSource(sourceStream);
                const destination = this.audioContext.createMediaStreamDestination();

                // Connect: source -> noise suppression -> destination
                source.connect(this.noiseSuppressionNode);
                this.noiseSuppressionNode.connect(destination);

                // Get the processed audio track
                const processedAudioTrack = destination.stream.getAudioTracks()[0];

                // Replace audio track in all peer connections
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        sender.replaceTrack(processedAudioTrack);
                    }
                });

                // Store for later cleanup
                this.processedStream = destination.stream;
                this.originalAudioTrack = audioTrack;

                this.noiseSuppressionEnabled = true;
                btn.setAttribute('data-enabled', 'true');
                btn.querySelector('.toggle-status').textContent = 'ON';

                // Show noise gate settings
                noiseGateSettings.classList.remove('hidden');

                // Display the mic device name
                this.updateMicDeviceList();

                // Reset warning state
                this.micConstantlyActiveCount = 0;
                this.hideMicActiveWarning();

                console.log('AI Noise Suppression enabled');

            } catch (error) {
                console.error('Error enabling noise suppression:', error);
                // Don't alert - just log the error. Noise suppression is optional.
                throw error; // Re-throw so caller knows it failed
            }
        } else {
            // Disable noise suppression
            try {
                // Restore original audio track in all peer connections
                if (this.originalAudioTrack) {
                    this.peerConnections.forEach(peer => {
                        const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                        if (sender) {
                            sender.replaceTrack(this.originalAudioTrack);
                        }
                    });
                }

                // Cleanup
                if (this.noiseSuppressionNode) {
                    this.noiseSuppressionNode.disconnect();
                    this.noiseSuppressionNode = null;
                }

                this.noiseSuppressionEnabled = false;
                btn.setAttribute('data-enabled', 'false');
                btn.querySelector('.toggle-status').textContent = 'OFF';

                // Hide noise gate settings
                noiseGateSettings.classList.add('hidden');
                this.hideMicActiveWarning();

                console.log('AI Noise Suppression disabled');

            } catch (error) {
                console.error('Error disabling noise suppression:', error);
            }
        }
    }

    // Handle audio level updates from the noise processor
    handleAudioLevelUpdate(data) {
        const micLevelIndicator = document.getElementById('micLevelIndicator');
        const micLevelDebug = document.getElementById('micLevelDebug');

        // Use smoothedLevel for stable display, scale for visibility
        // Audio levels are typically 0-0.1 for normal speech, scale up significantly
        const level = Math.max(data.level, data.smoothedLevel);
        const levelPercent = Math.min(100, level * 1000);

        if (micLevelIndicator) {
            micLevelIndicator.style.width = `${levelPercent}%`;
        }
        if (micLevelDebug) {
            micLevelDebug.textContent = `${levelPercent.toFixed(0)}%`;
        }

        // Track if mic is constantly active (gate always open)
        if (data.gateOpen) {
            this.micConstantlyActiveCount++;
            if (this.micConstantlyActiveCount > this.micConstantlyActiveThreshold && !this.micActiveWarningShown) {
                this.showMicActiveWarning();
            }
        } else {
            // Reset counter when gate closes
            this.micConstantlyActiveCount = 0;
            if (this.micActiveWarningShown) {
                this.hideMicActiveWarning();
            }
        }
    }

    showMicActiveWarning() {
        const warning = document.getElementById('micActiveWarning');
        if (warning) {
            warning.classList.remove('hidden');
            this.micActiveWarningShown = true;
        }
    }

    hideMicActiveWarning() {
        const warning = document.getElementById('micActiveWarning');
        if (warning) {
            warning.classList.add('hidden');
            this.micActiveWarningShown = false;
        }
    }

    updateNoiseGateThreshold(percentValue) {
        if (this.noiseSuppressionNode) {
            // Convert percentage (1-30) to actual threshold value (0.002 - 0.06)
            const threshold = (percentValue / 100) * 0.2;
            this.noiseSuppressionNode.port.postMessage({
                type: 'setThreshold',
                threshold: threshold
            });
        }
    }

    async updateMicDeviceList() {
        const select = document.getElementById('micDeviceSelect');
        if (!select) return;

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');

            // Get current device ID
            const audioTrack = this.localStream?.getAudioTracks()[0];
            const currentDeviceId = audioTrack ? audioTrack.getSettings().deviceId : null;

            select.innerHTML = '';
            audioInputs.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${i + 1}`;
                if (device.deviceId === currentDeviceId) {
                    option.selected = true;
                }
                select.appendChild(option);
            });
        } catch (error) {
            console.warn('Could not enumerate mic devices:', error);
        }
    }

    async switchMicrophone(deviceId) {
        try {
            const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

            const audioConstraints = isMobile ? {
                deviceId: { exact: deviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            } : {
                deviceId: { exact: deviceId },
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: { ideal: 48000 },
                channelCount: { ideal: 1 },
                latency: { ideal: 0.01 },
                googEchoCancellation: true,
                googAutoGainControl: true,
                googNoiseSuppression: true,
                googHighpassFilter: true,
                googTypingNoiseDetection: true,
                googNoiseReduction: true,
                googAudioMirroring: false
            };

            // Get new audio stream
            const newStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
            const newAudioTrack = newStream.getAudioTracks()[0];

            // Stop old audio track
            const oldAudioTrack = this.localStream.getAudioTracks()[0];
            if (oldAudioTrack) {
                oldAudioTrack.stop();
                this.localStream.removeTrack(oldAudioTrack);
            }

            // Add new track to local stream
            this.localStream.addTrack(newAudioTrack);

            // If noise suppression is active, re-route through the processor
            if (this.noiseSuppressionEnabled && this.audioContext && this.noiseSuppressionNode) {
                const sourceStream = new MediaStream([newAudioTrack]);
                const source = this.audioContext.createMediaStreamSource(sourceStream);
                const destination = this.audioContext.createMediaStreamDestination();

                // Disconnect old source (node stays connected)
                this.noiseSuppressionNode.disconnect();
                source.connect(this.noiseSuppressionNode);
                this.noiseSuppressionNode.connect(destination);

                const processedTrack = destination.stream.getAudioTracks()[0];
                this.processedStream = destination.stream;
                this.originalAudioTrack = newAudioTrack;

                // Replace in all peer connections
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) sender.replaceTrack(processedTrack);
                });
            } else {
                // Replace raw track in all peer connections
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) sender.replaceTrack(newAudioTrack);
                });
            }

            // Save preference
            this.saveNoiseGateSetting('preferredMic', deviceId);
            console.log('Switched microphone to:', newAudioTrack.label);

            // Restart speaking-glow monitor with the new stream
            const localContainer = document.getElementById('localContainer');
            if (localContainer) {
                this.monitorAudioLevel(this.localStream, localContainer);
            }
        } catch (error) {
            console.error('Error switching microphone:', error);
        }
    }

    loadNoiseGateSetting(key, defaultValue) {
        try {
            const stored = localStorage.getItem(`noiseGate_${key}`);
            return stored !== null ? JSON.parse(stored) : defaultValue;
        } catch {
            return defaultValue;
        }
    }

    saveNoiseGateSetting(key, value) {
        try {
            localStorage.setItem(`noiseGate_${key}`, JSON.stringify(value));
        } catch {
            // localStorage not available
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

        // Hide all other video containers (including local)
        const allContainers = this.videoGrid.querySelectorAll('.video-container');
        allContainers.forEach(container => {
            if (container.id === `video-${peerId}`) {
                container.classList.remove('spotlight-hidden');
                container.classList.add('spotlight-active');
            } else {
                container.classList.add('spotlight-hidden');
                container.classList.remove('spotlight-active');
            }
        });

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

        if (message.startsWith('/')) {
            this.handleChatCommand(message);
            this.chatInput.value = '';
            return;
        }

        this.sendMessage({
            type: 'chat-message',
            message: message
        });

        this.chatInput.value = '';
    }

    handleChatCommand(command) {
        const cmd = command.toLowerCase().split(' ')[0];
        if (cmd === '/clear') {
            const children = Array.from(this.chatMessages.children);
            this.clearedMessages = children.filter(el => !el.classList.contains('load-more-btn'));
            this.chatMessages.innerHTML = '';
            if (this.clearedMessages.length > 0) {
                const btn = document.createElement('button');
                btn.className = 'load-more-btn';
                btn.textContent = '↑ Load older messages';
                btn.addEventListener('click', () => {
                    btn.remove();
                    this.clearedMessages.forEach(el => this.chatMessages.insertBefore(el, this.chatMessages.firstChild));
                    this.clearedMessages = [];
                    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
                });
                this.chatMessages.prepend(btn);
            }
        }
    }

    escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    linkifyText(text) {
        const urlPattern = /(\b(https?:\/\/|www\.)[^\s<]+[^\s<.,:;"')\]])/gi;
        const result = [];
        let lastIndex = 0;
        let match;

        while ((match = urlPattern.exec(text)) !== null) {
            // Escape plain text before this URL
            if (match.index > lastIndex) {
                result.push(this.escapeHtml(text.slice(lastIndex, match.index)));
            }
            let href = match[0];
            if (href.startsWith('www.')) href = 'https://' + href;
            result.push(`<a href="${this.escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(match[0])}</a>`);
            lastIndex = match.index + match[0].length;
        }

        result.push(this.escapeHtml(text.slice(lastIndex)));
        return result.join('');
    }

    getNickPrefix(username, isOwn) {
        if (isOwn && this.isModerator) return '@';
        if (this.moderatorUsername && username === this.moderatorUsername) return '@';
        return '';
    }

    addChatMessage(username, text, isSystem = false, isIRC = false, isOwn = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';

        if (isOwn) messageDiv.classList.add('own');
        if (isIRC) messageDiv.classList.add('irc');

        const usernameSpan = document.createElement('div');
        usernameSpan.className = 'username';
        const prefix = !isSystem ? this.getNickPrefix(username, isOwn) : '';
        usernameSpan.textContent = prefix + username;

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
        this.updateVideoGridLayout();
    }

    updateVideoGridLayout() {
        // Count actual video containers in the grid
        const videoContainers = this.videoGrid.querySelectorAll('.video-container');
        const count = videoContainers.length;
        this.videoGrid.setAttribute('data-participants', Math.min(count, 16));
    }

    toggleSpotlight(containerId) {
        const grid = this.videoGrid;
        const target = document.getElementById(containerId);
        if (!target) return;

        const alreadySpotlit = grid.classList.contains('spotlight-mode') &&
            target.classList.contains('spotlight-active');

        if (alreadySpotlit) {
            // Click same tile again → exit spotlight
            grid.classList.remove('spotlight-mode');
            grid.querySelectorAll('.video-container').forEach(c => {
                c.classList.remove('spotlight-active', 'spotlight-hidden');
            });
            this.updateVideoGridLayout();
            return;
        }

        // Enter spotlight: expand target, hide others
        grid.classList.add('spotlight-mode');
        grid.querySelectorAll('.video-container').forEach(c => {
            if (c === target) {
                c.classList.add('spotlight-active');
                c.classList.remove('spotlight-hidden');
            } else {
                c.classList.add('spotlight-hidden');
                c.classList.remove('spotlight-active');
            }
        });
    }

    addScreenShareTile(id, label, stream) {
        const existing = document.getElementById(id);
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'video-container';
        container.id = id;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsinline = true;
        video.muted = true;
        video.srcObject = stream;

        const labelEl = document.createElement('div');
        labelEl.className = 'video-label';
        labelEl.textContent = label;

        container.appendChild(video);
        container.appendChild(labelEl);
        this.videoGrid.appendChild(container);
        this.updateVideoGridLayout();
    }

    changeName() {
        const newName = prompt('Enter your new name:', this.username);
        if (newName && newName.trim() && newName !== this.username) {
            const oldName = this.username;
            this.username = newName.trim();

            // Update local video label
            const localLabel = document.querySelector('#localContainer .video-label');
            if (localLabel) {
                localLabel.textContent = this.username;
            }

            // Update local avatar
            const localAvatar = document.getElementById('localAvatar');
            if (localAvatar) {
                localAvatar.textContent = this.username.charAt(0).toUpperCase();
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
        this.isIntentionalDisconnect = true;
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
        this.turnFailedPeers.clear();

        // Clean up all stats monitoring intervals
        this.statsIntervals.forEach((intervalId) => {
            clearInterval(intervalId);
        });
        this.statsIntervals.clear();
        this.stopLocalStatsMonitoring();

        // Stop local streams
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }

        // Clean up noise suppression
        if (this.noiseSuppressionNode) {
            this.noiseSuppressionNode.disconnect();
            this.noiseSuppressionNode = null;
        }
        if (this.audioContext) {
            this.audioContext.close();
            this.audioContext = null;
        }
        this.noiseSuppressionEnabled = false;
        const noiseBtn = document.getElementById('noiseSuppressionBtn');
        if (noiseBtn) {
            noiseBtn.setAttribute('data-enabled', 'false');
            noiseBtn.querySelector('.toggle-status').textContent = 'OFF';
        }

        // Close WebSocket connection
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
            this.ws = null;
        }

        this.localVideo.srcObject = null;
        this.currentRoom = null;
        this.roomPassword = null;
        this.isScreenSharing = false;
        this.isModerator = false;
        this.moderatorId = null;
        this.moderatorUsername = null;
        this.clearedMessages = [];
        this.knownUsernames.clear();
        this.isIntentionalDisconnect = false;
        this.wsReconnectAttempts = 0;
        this.wsReconnecting = false;

        // Reset button states
        document.getElementById('shareScreenBtn').classList.remove('active');
        document.getElementById('toggleAudioBtn').classList.remove('active');
        document.getElementById('toggleVideoBtn').classList.remove('active');

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

// Initialize the conference client (constructor has side effects - sets up event listeners)
const _client = new ConferenceClient();
