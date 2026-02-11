// WebRTC Client
class WebRTCClient {
    constructor() {
        // WebSocket connection
        this.ws = null;
        this.clientId = this.generateId();
        this.currentRoom = null;

        // WebRTC
        this.peerConnection = null;
        this.localStream = null;
        this.remoteClientId = null;

        // ICE servers (STUN/TURN)
        this.iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' },
                // Local TURN server (configure after setup)
                {
                    urls: 'turn:localhost:3479',
                    username: 'webrtc',
                    credential: 'webrtc123'
                }
            ]
        };

        // UI elements
        this.statusEl = document.getElementById('status');
        this.localVideo = document.getElementById('localVideo');
        this.remoteVideo = document.getElementById('remoteVideo');
        this.roomIdInput = document.getElementById('roomId');
        this.joinBtn = document.getElementById('joinBtn');
        this.leaveBtn = document.getElementById('leaveBtn');
        this.toggleAudioBtn = document.getElementById('toggleAudioBtn');
        this.toggleVideoBtn = document.getElementById('toggleVideoBtn');
        this.usersListEl = document.getElementById('usersList');
        this.usersContainer = document.getElementById('usersContainer');

        // State
        this.audioEnabled = true;
        this.videoEnabled = true;
        this.usersInRoom = [];

        this.setupEventListeners();
    }

    generateId() {
        return 'client_' + Math.random().toString(36).substr(2, 9);
    }

    setupEventListeners() {
        this.joinBtn.addEventListener('click', () => this.joinRoom());
        this.leaveBtn.addEventListener('click', () => this.leaveRoom());
        this.toggleAudioBtn.addEventListener('click', () => this.toggleAudio());
        this.toggleVideoBtn.addEventListener('click', () => this.toggleVideo());
    }

    updateStatus(message, className) {
        this.statusEl.textContent = message;
        this.statusEl.className = className;
    }

    async connectSignalingServer() {
        return new Promise((resolve, reject) => {
            this.updateStatus('Connecting to signaling server...', 'status-connecting');

            this.ws = new WebSocket('wss://ts.interdo.me:8765');

            this.ws.onopen = () => {
                console.log('WebSocket connected');

                // Register with server
                this.sendMessage({
                    type: 'register',
                    clientId: this.clientId
                });
            };

            this.ws.onmessage = async (event) => {
                const message = JSON.parse(event.data);
                await this.handleSignalingMessage(message);
            };

            this.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                this.updateStatus('Connection error', 'status-disconnected');
                reject(error);
            };

            this.ws.onclose = () => {
                console.log('WebSocket disconnected');
                this.updateStatus('Disconnected', 'status-disconnected');
                this.cleanup();
            };

            // Resolve when registered
            const checkRegistered = (event) => {
                const msg = JSON.parse(event.data);
                if (msg.type === 'registered') {
                    this.ws.removeEventListener('message', checkRegistered);
                    this.updateStatus('Connected', 'status-connected');
                    resolve();
                }
            };
            this.ws.addEventListener('message', checkRegistered);
        });
    }

    async handleSignalingMessage(message) {
        console.log('Received signaling message:', message);

        switch (message.type) {
            case 'room-joined':
                this.currentRoom = message.roomId;
                this.usersInRoom = message.users;
                this.updateUsersList();
                this.joinBtn.disabled = true;
                this.leaveBtn.disabled = false;
                this.toggleAudioBtn.disabled = false;
                this.toggleVideoBtn.disabled = false;
                this.updateStatus(`In room: ${this.currentRoom}`, 'status-connected');
                break;

            case 'user-joined':
                console.log('User joined:', message.clientId);
                if (!this.usersInRoom.includes(message.clientId)) {
                    this.usersInRoom.push(message.clientId);
                    this.updateUsersList();
                }
                break;

            case 'user-left':
                console.log('User left:', message.clientId);
                this.usersInRoom = this.usersInRoom.filter(id => id !== message.clientId);
                this.updateUsersList();

                if (message.clientId === this.remoteClientId) {
                    this.closePeerConnection();
                }
                break;

            case 'offer':
                await this.handleOffer(message.senderId, message.data);
                break;

            case 'answer':
                await this.handleAnswer(message.data);
                break;

            case 'ice-candidate':
                await this.handleIceCandidate(message.data);
                break;
        }
    }

    updateUsersList() {
        if (this.usersInRoom.length === 0) {
            this.usersListEl.style.display = 'none';
            return;
        }

        this.usersListEl.style.display = 'block';
        this.usersContainer.innerHTML = this.usersInRoom.map(userId => `
            <div class="user-item">
                <span>${userId}</span>
                <button class="call-button" onclick="client.callUser('${userId}')">Call</button>
            </div>
        `).join('');
    }

    async getLocalStream() {
        if (!this.localStream) {
            try {
                this.localStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: true
                });
                this.localVideo.srcObject = this.localStream;
                console.log('Got local stream');
            } catch (error) {
                console.error('Error accessing media devices:', error);
                alert('Could not access camera/microphone. Please grant permissions.');
                throw error;
            }
        }
        return this.localStream;
    }

    async joinRoom() {
        const roomId = this.roomIdInput.value.trim();
        if (!roomId) {
            alert('Please enter a room ID');
            return;
        }

        try {
            // Connect to signaling server if not connected
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                await this.connectSignalingServer();
            }

            // Get local media
            await this.getLocalStream();

            // Join room
            this.sendMessage({
                type: 'join-room',
                roomId: roomId
            });
        } catch (error) {
            console.error('Error joining room:', error);
            this.updateStatus('Failed to join room', 'status-disconnected');
        }
    }

    leaveRoom() {
        if (this.currentRoom) {
            this.sendMessage({
                type: 'leave-room'
            });
        }

        this.cleanup();
    }

    async callUser(targetId) {
        console.log('Calling user:', targetId);
        this.remoteClientId = targetId;

        // Create peer connection
        this.createPeerConnection();

        // Create and send offer
        try {
            const offer = await this.peerConnection.createOffer();
            await this.peerConnection.setLocalDescription(offer);

            this.sendMessage({
                type: 'offer',
                targetId: targetId,
                data: offer
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    createPeerConnection() {
        if (this.peerConnection) {
            this.closePeerConnection();
        }

        this.peerConnection = new RTCPeerConnection(this.iceServers);

        // Add local stream tracks
        this.localStream.getTracks().forEach(track => {
            this.peerConnection.addTrack(track, this.localStream);
        });

        // Handle incoming tracks
        this.peerConnection.ontrack = (event) => {
            console.log('Received remote track');
            this.remoteVideo.srcObject = event.streams[0];
        };

        // Handle ICE candidates
        this.peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendMessage({
                    type: 'ice-candidate',
                    targetId: this.remoteClientId,
                    data: event.candidate
                });
            }
        };

        // Connection state changes
        this.peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', this.peerConnection.connectionState);
        };

        console.log('Peer connection created');
    }

    async handleOffer(senderId, offer) {
        console.log('Received offer from:', senderId);
        this.remoteClientId = senderId;

        this.createPeerConnection();

        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            this.sendMessage({
                type: 'answer',
                targetId: senderId,
                data: answer
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    }

    async handleAnswer(answer) {
        console.log('Received answer');

        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(candidate) {
        console.log('Received ICE candidate');

        try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding ICE candidate:', error);
        }
    }

    toggleAudio() {
        if (this.localStream) {
            this.audioEnabled = !this.audioEnabled;
            this.localStream.getAudioTracks().forEach(track => {
                track.enabled = this.audioEnabled;
            });
            this.toggleAudioBtn.textContent = this.audioEnabled ? 'Mute Audio' : 'Unmute Audio';
        }
    }

    toggleVideo() {
        if (this.localStream) {
            this.videoEnabled = !this.videoEnabled;
            this.localStream.getVideoTracks().forEach(track => {
                track.enabled = this.videoEnabled;
            });
            this.toggleVideoBtn.textContent = this.videoEnabled ? 'Stop Video' : 'Start Video';
        }
    }

    closePeerConnection() {
        if (this.peerConnection) {
            this.peerConnection.close();
            this.peerConnection = null;
        }
        this.remoteVideo.srcObject = null;
        this.remoteClientId = null;
    }

    cleanup() {
        // Close peer connection
        this.closePeerConnection();

        // Stop local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }

        this.localVideo.srcObject = null;
        this.currentRoom = null;
        this.usersInRoom = [];
        this.updateUsersList();

        this.joinBtn.disabled = false;
        this.leaveBtn.disabled = true;
        this.toggleAudioBtn.disabled = true;
        this.toggleVideoBtn.disabled = true;

        this.updateStatus('Disconnected', 'status-disconnected');
    }

    sendMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    }
}

// Initialize client (constructor has side effects - sets up event listeners)
const _client = new WebRTCClient();
