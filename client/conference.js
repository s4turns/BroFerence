// Multi-Participant WebRTC Conference Client with IRC Bridge
// Version: 1.6

class ConferenceClient {
    constructor() {
        // WebSocket connection
        this.ws = null;
        this.clientId = this.generateId();
        this.username = null;
        this.currentRoom = null;
        this.isModerator = false;
        this.isOwner = false;
        this.moderatorId = null;
        this.coModIds = new Set();
        this.roomLocked = false;

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

        // E2EE state
        this.e2eeEnabled = false;
        this.e2eeKeyPair = null;          // CryptoKeyPair { privateKey, publicKey }
        this.e2eeRoomKey = null;          // CryptoKey (AES-GCM-256) — shared room key
        this.peerPublicKeys = new Map();  // Map<clientId, CryptoKey>
        this.peerSharedKeys = new Map();  // Map<clientId, CryptoKey> per-pair AES-GCM
        this.pendingRoomKeyData = null;   // { peerId, data } queued if room key arrives before shared key is ready
        this.e2eeWorker = null;           // Web Worker for media frame encryption
        this.e2eeRawKey = null;           // ArrayBuffer of room key — posted to worker
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
        this.clearedMessages = [];
        this.moderatorUsername = null;
        // Prejoin state
        this.prejoinStream = null;
        this.prejoinAudioEnabled = true;
        this.prejoinVideoEnabled = false;
        this.lowBandwidthMode = this.isMobileDevice() || localStorage.getItem('broference-low-bandwidth') === 'true';
        this.videoQuality = localStorage.getItem('broference-video-quality') || '720';
        this.gravatarHash = localStorage.getItem('broference-gravatar-hash') || null;
        this.peerGravatarHashes = new Map();
        this.peerVideoStates = new Map();
        this.pendingImageData = null;

        // Noise suppression state
        this.noiseSuppressionEnabled = false;
        this.micAudioCtx = null;
        this.micSource = null;
        this.micDestination = null;
        this.noiseSuppressionNode = null;
        this.processedStream = null;

        // Noise gate configuration
        this.noiseGateThreshold = this.loadNoiseGateSetting('threshold', 25); // Default 25%
        this.micConstantlyActiveCount = 0;
        this.micConstantlyActiveThreshold = 300; // ~5 seconds of constant activity (60fps * 5)
        this.micActiveWarningShown = false;
        this.hotMicCooldownUntil = 0;

        this.initUI();
    }

    generateId() {
        return 'client_' + Math.random().toString(36).substr(2, 9);
    }

    updateModStatus() {
        this.isOwner = this.clientId === this.moderatorId;
        this.isModerator = this.isOwner || this.coModIds.has(this.clientId);
    }

    // --- Crypto helpers ---

    b64ToBytes(b64) {
        return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    }

    bytesToB64(bytes) {
        return btoa(String.fromCharCode(...new Uint8Array(bytes)));
    }

    async aesGcmEncrypt(key, data) {
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
        return { iv: this.bytesToB64(iv), ciphertext: this.bytesToB64(new Uint8Array(ciphertext)) };
    }

    async aesGcmDecrypt(key, encData) {
        const iv = this.b64ToBytes(encData.iv);
        const ciphertext = this.b64ToBytes(encData.ciphertext);
        return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    }

    // --- E2EE ---

    async initE2EE() {
        if (!window.crypto?.subtle) return;
        try {
            this.e2eeKeyPair = await window.crypto.subtle.generateKey(
                { name: 'ECDH', namedCurve: 'P-256' },
                false,
                ['deriveKey', 'deriveBits']
            );
        } catch (e) {
            console.warn('E2EE key generation failed:', e);
        }
    }

    async sendPublicKey(targetId) {
        if (!this.e2eeKeyPair) return;
        try {
            const raw = await window.crypto.subtle.exportKey('raw', this.e2eeKeyPair.publicKey);
            this.sendMessage({ type: 'public-key', targetId, data: { publicKey: this.bytesToB64(raw) } });
        } catch (e) {
            console.warn('sendPublicKey failed:', e);
        }
    }

    async receivePublicKey(peerId, pubKeyB64) {
        if (!this.e2eeKeyPair) return;
        try {
            const importedKey = await window.crypto.subtle.importKey(
                'raw', this.b64ToBytes(pubKeyB64), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
            this.peerPublicKeys.set(peerId, importedKey);
            await this.deriveSharedKey(peerId);
            // If a room key arrived before the shared key was ready, apply it now
            if (this.pendingRoomKeyData?.peerId === peerId) {
                const pending = this.pendingRoomKeyData;
                this.pendingRoomKeyData = null;
                await this.receiveRoomKey(pending.peerId, pending.data);
            }
            if (this.isModerator && this.e2eeEnabled && this.e2eeRoomKey) {
                await this.sendRoomKeyToPeer(peerId);
            }
        } catch (e) {
            console.warn('receivePublicKey failed:', e);
        }
    }

    async deriveSharedKey(peerId) {
        const peerPubKey = this.peerPublicKeys.get(peerId);
        if (!peerPubKey || !this.e2eeKeyPair) return;
        try {
            const ecdhBits = await window.crypto.subtle.deriveBits(
                { name: 'ECDH', public: peerPubKey },
                this.e2eeKeyPair.privateKey, 256);
            const hkdfKey = await window.crypto.subtle.importKey(
                'raw', ecdhBits, { name: 'HKDF' }, false, ['deriveKey']);
            const sortedIds = [this.clientId, peerId].sort().join(':');
            const enc = new TextEncoder();
            const pairKey = await window.crypto.subtle.deriveKey(
                {
                    name: 'HKDF', hash: 'SHA-256',
                    salt: enc.encode('broference-e2ee-salt-v1'),
                    info: enc.encode('broference-e2ee-pair-v1:' + sortedIds)
                },
                hkdfKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            this.peerSharedKeys.set(peerId, pairKey);
        } catch (e) {
            console.warn('deriveSharedKey failed:', e);
        }
    }

    async generateRoomKey() {
        this.e2eeRoomKey = await window.crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        this.e2eeRawKey = await window.crypto.subtle.exportKey('raw', this.e2eeRoomKey);
        this.e2eeWorker?.postMessage({ type: 'set-key', rawKey: this.e2eeRawKey });
    }

    async distributeRoomKey() {
        const peers = [...this.peerConnections.keys()].filter(id => this.peerSharedKeys.has(id));
        await Promise.all(peers.map(peerId => this.sendRoomKeyToPeer(peerId)));
    }

    async sendRoomKeyToPeer(peerId) {
        const pairKey = this.peerSharedKeys.get(peerId);
        if (!pairKey || !this.e2eeRoomKey) return;
        try {
            const rawRoomKey = await window.crypto.subtle.exportKey('raw', this.e2eeRoomKey);
            const encrypted = await this.aesGcmEncrypt(pairKey, rawRoomKey);
            this.sendMessage({ type: 'e2ee-room-key', targetId: peerId, data: encrypted });
        } catch (e) {
            console.warn('sendRoomKeyToPeer failed:', e);
        }
    }

    async receiveRoomKey(peerId, data) {
        if (peerId !== this.moderatorId && !this.coModIds.has(peerId)) return;
        const pairKey = this.peerSharedKeys.get(peerId);
        if (!pairKey) {
            // Shared key not ready yet — queue and retry after deriveSharedKey completes
            this.pendingRoomKeyData = { peerId, data };
            return;
        }
        try {
            const rawRoomKey = await this.aesGcmDecrypt(pairKey, data);
            this.e2eeRawKey = rawRoomKey;
            this.e2eeRoomKey = await window.crypto.subtle.importKey(
                'raw', rawRoomKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
            this.e2eeWorker?.postMessage({ type: 'set-key', rawKey: this.e2eeRawKey });
            this.initMediaE2EEWorker();
            this.applyMediaTransformsToAll();
            this.addChatMessage('System', 'Encryption key received. Chat is now end-to-end encrypted.', true);
        } catch (e) {
            console.warn('receiveRoomKey failed:', e);
        }
    }

    async encryptMessage(text) {
        return this.aesGcmEncrypt(this.e2eeRoomKey, new TextEncoder().encode(text));
    }

    async decryptMessage(encData) {
        const plaintext = await this.aesGcmDecrypt(this.e2eeRoomKey, encData);
        return new TextDecoder().decode(plaintext);
    }

    // --- Media E2EE (Insertable Streams) ---

    mediaE2EESupported() {
        return typeof RTCRtpScriptTransform !== 'undefined';
    }

    initMediaE2EEWorker() {
        if (this.e2eeWorker || !this.mediaE2EESupported()) return;
        this.e2eeWorker = new Worker('e2ee-worker.js');
        if (this.e2eeRawKey) {
            this.e2eeWorker.postMessage({ type: 'set-key', rawKey: this.e2eeRawKey });
        }
    }

    applyMediaTransformsToPeer(peerId) {
        if (!this.e2eeWorker) return;
        const peer = this.peerConnections.get(peerId);
        if (!peer) return;
        peer.connection.getSenders().forEach(sender => {
            if (!sender.track) return;
            try {
                sender.transform = new RTCRtpScriptTransform(
                    this.e2eeWorker, { operation: 'encrypt', kind: sender.track.kind });
            } catch (e) { console.warn('Could not set sender transform:', e); }
        });
        peer.connection.getReceivers().forEach(receiver => {
            if (!receiver.track) return;
            try {
                receiver.transform = new RTCRtpScriptTransform(
                    this.e2eeWorker, { operation: 'decrypt', kind: receiver.track.kind });
            } catch (e) { console.warn('Could not set receiver transform:', e); }
        });
    }

    applyMediaTransformsToAll() {
        for (const peerId of this.peerConnections.keys()) {
            this.applyMediaTransformsToPeer(peerId);
        }
    }

    removeMediaTransforms() {
        this.peerConnections.forEach(peer => {
            peer.connection.getSenders().forEach(s => { try { s.transform = null; } catch {} });
            peer.connection.getReceivers().forEach(r => { try { r.transform = null; } catch {} });
        });
        if (this.e2eeWorker) {
            this.e2eeWorker.terminate();
            this.e2eeWorker = null;
        }
        this.e2eeRawKey = null;
    }

    async handleE2EEToggle(enabled) {
        this.e2eeEnabled = enabled;
        if (enabled) {
            if (this.isModerator) {
                await this.generateRoomKey();   // also stores e2eeRawKey + posts to worker
                this.initMediaE2EEWorker();
                await this.distributeRoomKey();
                this.applyMediaTransformsToAll();
            }
            this.addChatMessage('System', '🔒 End-to-end encryption enabled.', true);
            this.speakText('End to end encrypted');
        } else {
            this.e2eeRoomKey = null;
            this.removeMediaTransforms();
            this.addChatMessage('System', '🔓 End-to-end encryption disabled.', true);
            this.speakText('Encryption disabled');
        }
        this.updateE2EEUI();
    }

    async toggleE2EE() {
        if (!this.isModerator) return;
        this.sendMessage({ type: 'e2ee-toggle', enabled: !this.e2eeEnabled });
    }

    updateE2EEUI() {
        const on = this.e2eeEnabled;
        document.getElementById('e2eeStatusIndicator')?.classList.toggle('hidden', !on);
        document.getElementById('e2eeStatusIndicator')?.classList.toggle('e2ee-active', on);
        document.getElementById('e2eeBanner')?.classList.toggle('hidden', !on);
        const btn = document.getElementById('e2eeToggleBtn');
        if (btn) {
            btn.style.display = this.isModerator ? '' : 'none';
            btn.setAttribute('data-enabled', String(on));
            btn.querySelector('.toggle-status').textContent = on ? 'ON' : 'OFF';
        }
    }

    // --- Gravatar ---

    md5(str) {
        const s = unescape(encodeURIComponent(str));
        let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476;
        const msg = [];
        for (let i = 0; i < s.length; i++) msg.push(s.charCodeAt(i));
        msg.push(0x80);
        while (msg.length % 64 !== 56) msg.push(0);
        const bits = s.length * 8;
        msg.push(bits & 0xFF, (bits >> 8) & 0xFF, (bits >> 16) & 0xFF, (bits >> 24) & 0xFF, 0, 0, 0, 0);
        const r = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
        const K = Array.from({length: 64}, (_, i) => (Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
        for (let i = 0; i < msg.length; i += 64) {
            const w = Array.from({length: 16}, (_, j) => msg[i+j*4] | (msg[i+j*4+1] << 8) | (msg[i+j*4+2] << 16) | (msg[i+j*4+3] << 24));
            let [a, b, c, d] = [h0, h1, h2, h3];
            for (let j = 0; j < 64; j++) {
                let f, g;
                if      (j < 16) { f = (b & c) | (~b & d); g = j; }
                else if (j < 32) { f = (d & b) | (~d & c); g = (5 * j + 1) % 16; }
                else if (j < 48) { f = b ^ c ^ d;           g = (3 * j + 5) % 16; }
                else             { f = c ^ (b | ~d);         g = (7 * j) % 16; }
                f = (f + a + K[j] + w[g]) >>> 0;
                a = d; d = c; c = b;
                b = (b + ((f << r[j]) | (f >>> (32 - r[j])))) >>> 0;
            }
            h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
        }
        return [h0, h1, h2, h3].map(h =>
            Array.from({length: 4}, (_, i) => ((h >> (i * 8)) & 0xFF).toString(16).padStart(2, '0')).join('')
        ).join('');
    }

    setGravatar(email) {
        const hash = this.md5(email.trim().toLowerCase());
        this.gravatarHash = hash;
        localStorage.setItem('broference-gravatar-hash', hash);
        localStorage.setItem('broference-gravatar-email', email.trim());

        // Update own local avatar
        const localAvatar = document.getElementById('localAvatar');
        if (localAvatar) this.applyGravatarToAvatar(localAvatar, hash);

        // Broadcast to peers if in a room
        if (this.currentRoom) {
            this.sendMessage({ type: 'gravatar', hash });
        }
    }

    applyGravatarToAvatar(el, hash) {
        const url = `https://www.gravatar.com/avatar/${hash}?d=mp&s=200`;
        el.textContent = '';
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.onerror = () => {
            el.removeChild(img);
            el.textContent = el.dataset.initial || '?';
        };
        el.appendChild(img);
    }

    // --- Notification sounds ---

    playSoundTone(startFreq, endFreq, rampDuration) {
        try {
            // Prefer an already-running context (mic chain or shared) to avoid autoplay suspension
            const ctx = (this.micAudioCtx && this.micAudioCtx.state === 'running')
                ? this.micAudioCtx
                : this.getSharedAudioContext();
            const play = () => {
                const gain = ctx.createGain();
                gain.connect(ctx.destination);
                gain.gain.setValueAtTime(0.15, ctx.currentTime);
                gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
                const osc = ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(startFreq, ctx.currentTime);
                osc.frequency.exponentialRampToValueAtTime(endFreq, ctx.currentTime + rampDuration);
                osc.connect(gain);
                osc.start(ctx.currentTime);
                osc.stop(ctx.currentTime + 0.4);
            };
            if (ctx.state === 'suspended') {
                ctx.resume().then(play).catch(() => {});
            } else {
                play();
            }
        } catch (e) { /* audio not available */ }
    }

    playJoinSound()  { this.playSoundTone(600, 900, 0.15); }
    playLeaveSound() { this.playSoundTone(900, 500, 0.2);  }
    playChatSound()  { this.playSoundTone(1000, 1200, 0.05); }

    speakText(text) {
        if (!window.speechSynthesis) return;
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.volume = 0.8;
        u.rate = 1.05;
        window.speechSynthesis.speak(u);
    }

    initICEServers() {
        const hostname = window.location.hostname;
        const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '';
        const turnServer = isLocalhost ? 'localhost' : hostname;

        // PRIMARY_TURN_CREDENTIAL rotated by update-vps.sh on each deploy
        const PRIMARY_TURN_CREDENTIAL = 'TURN_CREDENTIAL_REDACTED';
        const localTurnConfig = {
            urls: [
                `turn:${turnServer}:3479`,
                `turn:${turnServer}:3479?transport=tcp`
            ],
            username: 'webrtc',
            credential: PRIMARY_TURN_CREDENTIAL
        };

        // SECONDARY_TURN_CREDENTIAL rotated by update-vps.sh from .env (TURN2_PASSWORD) on each deploy
        const SECONDARY_TURN_CREDENTIAL = 'TURN2_CREDENTIAL_REDACTED';
        const turn2Config = {
            urls: [
                'turn:174.138.183.167:3479',
                'turn:174.138.183.167:3479?transport=tcp'
            ],
            username: 'webrtc',
            credential: SECONDARY_TURN_CREDENTIAL
        };

        // Relay-only via both coturn servers. Asymmetric paths (server1↔server2)
        // handle same-NAT hairpin without needing a third-party TURN provider.
        this.iceServers = {
            iceServers: [localTurnConfig, turn2Config],
            iceTransportPolicy: 'relay'
        };

        // P2P fallback used only after relay exhaustion (ICE restart cycle)
        this.iceServersFallback = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                localTurnConfig,
                turn2Config
            ]
        };
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
        document.getElementById('prejoinMicSelect').addEventListener('change', (e) => {
            if (e.target.value) this.prejoinSwitchDevice('audio', e.target.value);
        });
        document.getElementById('prejoinCameraSelect').addEventListener('change', (e) => {
            if (e.target.value) this.prejoinSwitchDevice('video', e.target.value);
        });
        document.getElementById('toggleAudioBtn').addEventListener('click', () => this.toggleAudio());
        document.getElementById('toggleVideoBtn').addEventListener('click', () => this.toggleVideo());
        document.getElementById('shareScreenBtn').addEventListener('click', () => this.toggleScreenShare());
document.getElementById('chatToggleBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('toggleChatBtn').addEventListener('click', () => this.toggleChat());
        document.getElementById('sendMessageBtn').addEventListener('click', () => this.sendChatMessage());
        document.getElementById('inviteLinkBtn').addEventListener('click', () => this.copyInviteLink());
        document.getElementById('defconBtn').addEventListener('click', () => this.toggleDefcon());
        document.getElementById('e2eeToggleBtn').addEventListener('click', () => this.toggleE2EE());
        document.getElementById('lockRoomBtn').addEventListener('click', () => this.setRoomPassword());
        document.getElementById('optionsBtn').addEventListener('click', () => this.toggleOptionsMenu());
        document.getElementById('closeOptionsBtn').addEventListener('click', () => this.toggleOptionsMenu());
        document.getElementById('optionsOverlay').addEventListener('click', () => this.toggleOptionsMenu());
        document.getElementById('changelogBtn').addEventListener('click', () => this.toggleChangelog());
        document.getElementById('closeChangelogBtn').addEventListener('click', () => this.toggleChangelog());
        document.getElementById('changelogOverlay').addEventListener('click', () => this.toggleChangelog());
        document.getElementById('hotMicDismissBtn').addEventListener('click', () => {
            this.hideMicActiveWarning();
            this.hotMicCooldownUntil = Date.now() + 60000; // suppress for 60s after dismiss
            const lc = document.getElementById('localContainer');
            if (lc) lc._hotMicBuffer = []; // reset buffer so re-trigger requires fresh 10s of noise
        });
        document.getElementById('hotMicEnableNoiseBtn').addEventListener('click', () => {
            this.hideMicActiveWarning();
            this.micActiveWarningShown = true;
            this.toggleOptionsMenu();
            this.toggleNoiseSuppression();
        });

        const noiseBtn = document.getElementById('noiseSuppressionBtn');
        const noiseGateSettings = document.getElementById('noiseGateSettings');
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

        // Low bandwidth mode toggle (options menu)
        const lowBandwidthBtn = document.getElementById('lowBandwidthBtn');
        if (lowBandwidthBtn) {
            lowBandwidthBtn.setAttribute('data-enabled', String(this.lowBandwidthMode));
            lowBandwidthBtn.querySelector('.toggle-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
            lowBandwidthBtn.addEventListener('click', () => this.toggleLowBandwidth());
        }

        // Video quality selector
        const videoQualitySelect = document.getElementById('videoQualitySelect');
        if (videoQualitySelect) {
            videoQualitySelect.value = this.videoQuality;
            videoQualitySelect.addEventListener('change', () => this.setVideoQuality(videoQualitySelect.value));
        }

        // Options menu camera and mic selectors
        const cameraDeviceSelect = document.getElementById('cameraDeviceSelect');
        if (cameraDeviceSelect) {
            cameraDeviceSelect.addEventListener('change', (e) => {
                if (e.target.value) this.switchCamera(e.target.value);
            });
        }
        const micDeviceSelectOptions = document.getElementById('micDeviceSelectOptions');
        if (micDeviceSelectOptions) {
            micDeviceSelectOptions.addEventListener('change', (e) => {
                if (e.target.value) this.switchMicrophone(e.target.value);
            });
        }

        // Chat input enter key
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.sendChatMessage();
        });

        // Image paste in chat
        document.querySelector('.chat-input-container').addEventListener('paste', (e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            for (const item of items) {
                if (item.type.startsWith('image/')) {
                    e.preventDefault();
                    const file = item.getAsFile();
                    if (file) this.handleImagePaste(file);
                    break;
                }
            }
        });
        document.getElementById('chatImageCancelBtn').addEventListener('click', () => this.clearImagePreview());

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

        // Restore saved nickname, fall back to generated default
        const savedUsername = localStorage.getItem('broference-username');
        this.usernameInput.value = savedUsername || `User_${this.clientId.substr(-4)}`;

        // Check for URL parameters (invite links)
        this.handleInviteLink();

        // Gravatar email input
        const gravatarInput = document.getElementById('gravatarEmailInput');
        if (gravatarInput) {
            const savedEmail = localStorage.getItem('broference-gravatar-email') || '';
            gravatarInput.value = savedEmail;
            const applyGravatar = () => {
                const email = gravatarInput.value.trim();
                if (email) this.setGravatar(email);
            };
            gravatarInput.addEventListener('change', applyGravatar);
            gravatarInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyGravatar(); });
        }

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

        // Disable the inbound video track so the browser skips decoding
        const videoEl = container.querySelector('video');
        if (videoEl && videoEl.srcObject) {
            videoEl.srcObject.getVideoTracks().forEach(track => {
                track.enabled = !hidden;
            });
        }
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
            const wsPort = window.location.port === '8443' ? '8766' : '8765';
            const wsUrl = `${protocol}://${hostname}:${wsPort}`;

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
                this.moderatorId = message.moderatorId;
                this.coModIds = new Set(message.coModIds || []);
                this.updateModStatus();
                this.moderatorUsername = this.isOwner
                    ? this.username
                    : (message.users.find(u => u.id === this.moderatorId)?.username || null);
                this.roomLocked = message.hasPassword || false;
                this.updateRoomInfo(message.users.length + 1);

                // Show conference screen
                this.joinScreen.style.display = 'none';
                this.conferenceScreen.style.display = 'flex';

                // Show control buttons in header
                document.getElementById('bottomControls').style.display = 'flex';
                this.updateLockButton();

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
                if (this.isOwner) {
                    this.addChatMessage('System', 'You are the moderator of this room', true);
                } else if (this.isModerator) {
                    this.addChatMessage('System', 'You are a co-moderator of this room', true);
                }

                // E2EE: send our public key to all existing peers in parallel
                await Promise.all(message.users.map(u => this.sendPublicKey(u.id)));

                // E2EE: handle mid-session join when encryption is already active
                if (message.e2eeEnabled) {
                    this.e2eeEnabled = true;
                    // Create the worker now (without a key) so that pc.ontrack can attach
                    // decrypt transforms before the room key arrives. Without this, ontrack
                    // fires with e2eeWorker=null and no transform is attached, causing
                    // encrypted frames to reach the decoder as garbage.
                    this.initMediaE2EEWorker();
                }

                this.updateE2EEUI();

                // Send initial video, audio state, and gravatar to other users
                setTimeout(() => {
                    this.sendMessage({ type: 'video-state', videoEnabled: this.videoEnabled || this.isScreenSharing });
                    this.sendMessage({ type: 'audio-state', audioEnabled: this.audioEnabled });
                    if (this.gravatarHash) {
                        this.sendMessage({ type: 'gravatar', hash: this.gravatarHash });
                    }
                }, 500);
                break;

            case 'user-joined':
                // Store the username for when we receive their offer
                this.pendingUsernames.set(message.clientId, message.username);
                this.addChatMessage('System', `${message.username} joined the room`, true);
                this.playJoinSound();
                // E2EE: exchange public keys with the new user
                await this.sendPublicKey(message.clientId);
                // Send our gravatar hash so the new peer can render our avatar
                if (this.gravatarHash) {
                    this.sendMessage({ type: 'gravatar', hash: this.gravatarHash });
                }
                // Wait for them to send offer
                break;

            case 'user-left':
                this.turnFailedPeers.delete(message.clientId);
                this.removePeerConnection(message.clientId);
                this.addChatMessage('System', `${message.username} left the room`, true);
                this.playLeaveSound();
                this.peerPublicKeys.delete(message.clientId);
                this.peerSharedKeys.delete(message.clientId);
                this.peerGravatarHashes.delete(message.clientId);
                this.peerVideoStates.delete(message.clientId);
                this.updateRoomInfo(this.peerConnections.size + 1);
                break;

            case 'gravatar': {
                const { clientId, hash } = message;
                if (!clientId || !hash) break;
                this.peerGravatarHashes.set(clientId, hash);
                const avatarEl = document.querySelector(`#video-${clientId} .video-avatar`);
                if (avatarEl) this.applyGravatarToAvatar(avatarEl, hash);
                break;
            }

            case 'name-changed':
                // Update the display name for a user
                const peer = this.peerConnections.get(message.clientId);
                if (peer) {
                    peer.username = message.newUsername;
                    const label = document.querySelector(`#video-${message.clientId} .video-label`);
                    if (label) {
                        label.textContent = message.newUsername;
                        if (message.clientId === this.moderatorId) {
                            this.applyLabelBadge(message.clientId, message.newUsername, 'owner', label);
                        } else if (this.coModIds.has(message.clientId)) {
                            this.applyLabelBadge(message.clientId, message.newUsername, 'co-mod', label);
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

            case 'moderator-promoted': {
                // Primary ownership transferred to another user
                const wasPrivileged = this.isModerator;
                this.moderatorId = message.moderatorId;
                this.moderatorUsername = message.username;
                if (message.coModIds !== undefined) {
                    this.coModIds = new Set(message.coModIds);
                } else {
                    this.coModIds.delete(message.moderatorId);
                }
                this.updateModStatus();
                if (wasPrivileged && !this.isModerator) {
                    document.querySelectorAll('[data-mod-control]').forEach(el => el.remove());
                    this.updateE2EEUI();
                } else if (this.isModerator) {
                    this.refreshModeratorControls();
                }
                // Move crown: remove from old owner, add to new
                document.querySelectorAll('.video-label .mod-crown').forEach(crown => {
                    const label = crown.closest('.video-label');
                    if (label && !label.closest(`#video-${message.moderatorId}`)) {
                        crown.remove();
                    }
                });
                this.applyLabelBadge(message.moderatorId, message.username, 'owner');
                this.addChatMessage('System', `${message.username} is now the room owner`, true);
                break;
            }

            case 'you-are-moderator':
                // You have become the new room owner
                this.moderatorId = this.clientId;
                this.updateModStatus();
                this.moderatorUsername = this.username;
                this.addChatMessage('System', 'You are now the room owner! Hover over users to see moderator controls.', true);
                this.refreshModeratorControls();
                this.updateLockButton();
                this.updateE2EEUI();
                if (this.e2eeEnabled) {
                    this.addChatMessage('System', 'Regenerating encryption keys after owner change...', true);
                    this.sendMessage({ type: 'e2ee-toggle', enabled: false });
                    setTimeout(() => this.sendMessage({ type: 'e2ee-toggle', enabled: true }), 300);
                }
                break;

            case 'you-are-co-mod':
                // We were promoted to co-moderator
                this.coModIds.add(this.clientId);
                this.updateModStatus();
                this.addChatMessage('System', 'You are now a co-moderator! You can kick and rename users.', true);
                this.refreshModeratorControls();
                break;

            case 'co-mod-removed-self':
                // We were demoted from co-moderator
                this.coModIds.delete(this.clientId);
                this.updateModStatus();
                document.querySelectorAll('[data-mod-control]').forEach(el => el.remove());
                this.addChatMessage('System', 'Your co-moderator status has been removed.', true);
                this.updateE2EEUI();
                break;

            case 'co-mod-added': {
                // Another user was made a co-mod
                this.coModIds.add(message.coModId);
                this.applyLabelBadge(message.coModId, message.username, 'co-mod');
                this.addChatMessage('System', `${message.username} is now a co-moderator`, true);
                if (this.isOwner) this.refreshModeratorControls();
                break;
            }

            case 'co-mod-removed': {
                // Another user lost co-mod status
                this.coModIds.delete(message.coModId);
                this.applyLabelBadge(message.coModId, message.username, 'none');
                this.addChatMessage('System', `${message.username} is no longer a co-moderator`, true);
                if (this.isOwner) this.refreshModeratorControls();
                break;
            }

            case 'room-lock-changed':
                this.roomLocked = message.locked;
                this.updateLockButton();
                this.addChatMessage('System',
                    message.locked
                        ? `${message.changedBy} locked the room with a password`
                        : `${message.changedBy} removed the room password`,
                    true);
                break;

            case 'public-key':
                await this.receivePublicKey(message.senderId, message.data.publicKey);
                break;

            case 'e2ee-room-key':
                await this.receiveRoomKey(message.senderId, message.data);
                break;

            case 'e2ee-toggle':
                await this.handleE2EEToggle(message.enabled);
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

            case 'chat-message': {
                const isIRC = message.username.includes('(IRC)');
                const isOwn = message.username === this.username;
                if (!isOwn) this.playChatSound();
                if (message.encrypted) {
                    if (!this.e2eeRoomKey) {
                        this.addChatMessage(message.username, '[encrypted message]', false, isIRC, isOwn, false, true);
                    } else {
                        this.decryptMessage(message.encrypted).then(plaintext => {
                            this.addChatMessage(message.username, plaintext, false, isIRC, isOwn, true, false);
                        }).catch(() => {
                            this.addChatMessage(message.username, '[decryption error]', false, isIRC, isOwn, false, true);
                        });
                    }
                } else {
                    this.addChatMessage(message.username, message.message, false, isIRC, isOwn, false, false, message.imageData || null);
                }
                break;
            }

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

            case 'video-state': {
                // Store state so it can be applied even if container doesn't exist yet
                this.peerVideoStates.set(message.clientId, message.videoEnabled);
                const remoteContainer = document.getElementById(`video-${message.clientId}`);
                if (remoteContainer) {
                    remoteContainer.dataset.signaledVideoEnabled = message.videoEnabled ? 'true' : 'false';
                    remoteContainer.classList.toggle('no-video', !message.videoEnabled);
                }
                break;
            }

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

            case 'noise-gate-set': {
                const { enabled, threshold } = message;
                if (threshold !== null && threshold !== undefined) {
                    const t = Math.min(80, Math.max(1, parseInt(threshold)));
                    this.noiseGateThreshold = t;
                    this.updateNoiseGateThreshold(t);
                    this.saveNoiseGateSetting('threshold', t);
                    const gateSlider = document.getElementById('gateThresholdSlider');
                    const gateValue  = document.getElementById('gateThresholdValue');
                    const gateLine   = document.getElementById('gateThresholdLine');
                    if (gateSlider) gateSlider.value = t;
                    if (gateValue)  gateValue.textContent = `${t}%`;
                    if (gateLine)   gateLine.style.left = `${t}%`;
                }
                if (enabled !== null && enabled !== undefined) {
                    if (enabled && !this.noiseSuppressionEnabled) await this.toggleNoiseSuppression();
                    else if (!enabled && this.noiseSuppressionEnabled) await this.toggleNoiseSuppression();
                }
                break;
            }
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
        if (this.isMobileDevice()) {
            return { facingMode: 'user', width: { ideal: 640, max: 1280 }, height: { ideal: 480, max: 720 } };
        }
        const qualityMap = {
            '480':  { width: { ideal: 854,  max: 854  }, height: { ideal: 480,  max: 480  }, frameRate: { ideal: 24, max: 30 } },
            '720':  { width: { ideal: 1280, max: 1280 }, height: { ideal: 720,  max: 720  }, frameRate: { ideal: 24, max: 30 } },
            '1080': { width: { ideal: 1920, max: 1920 }, height: { ideal: 1080, max: 1080 }, frameRate: { ideal: 24, max: 30 } },
        };
        return qualityMap[this.videoQuality] || qualityMap['720'];
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

                // Set up persistent mic audio chain (source → destination graph)
                await this.setupMicAudioChain();

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

    // Creates (or recreates) the persistent mic audio graph:
    //   micSource → [noiseSuppressionNode →] micDestination
    // Peers always receive micDestination's track regardless of NS state.
    async setupMicAudioChain() {
        const audioTrack = this.localStream && this.localStream.getAudioTracks()[0];
        if (!audioTrack) return;

        if (!this.micAudioCtx) {
            this.micAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            await this.micAudioCtx.audioWorklet.addModule('noise-processor.js');
        }
        if (this.micAudioCtx.state === 'suspended') {
            await this.micAudioCtx.resume();
        }

        // Disconnect old source without disturbing the rest of the chain
        if (this.micSource) {
            try { this.micSource.disconnect(); } catch (e) {}
        }

        this.micSource = this.micAudioCtx.createMediaStreamSource(new MediaStream([audioTrack]));

        if (!this.micDestination) {
            this.micDestination = this.micAudioCtx.createMediaStreamDestination();
        }

        // Wire: source → noiseSuppressionNode → destination  OR  source → destination
        if (this.noiseSuppressionEnabled && this.noiseSuppressionNode) {
            this.micSource.connect(this.noiseSuppressionNode);
            this.noiseSuppressionNode.connect(this.micDestination);
        } else {
            this.micSource.connect(this.micDestination);
        }

        this.processedStream = this.micDestination.stream;
    }

    getSharedAudioContext() {
        if (!this._sharedAudioCtx || this._sharedAudioCtx.state === 'closed') {
            this._sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        return this._sharedAudioCtx;
    }

    monitorAudioLevel(stream, containerElement) {
        if (!stream || stream.getAudioTracks().length === 0) return;

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

                // Hot mic / background noise detection — local stream only, noise suppression off
                if (containerElement.id === 'localContainer' && !this.noiseSuppressionEnabled && this.audioEnabled) {
                    // Rolling 10-second buffer (40 samples × 250ms)
                    if (!containerElement._hotMicBuffer) containerElement._hotMicBuffer = [];
                    const buf = containerElement._hotMicBuffer;
                    buf.push(average);
                    if (buf.length > 40) buf.shift();

                    if (buf.length >= 40) {
                        // "Loud" = above normal speech floor; "silent" = genuinely quiet
                        const loudCount  = buf.filter(v => v > 25).length;
                        const silentCount = buf.filter(v => v < 8).length;
                        // Background noise: 70%+ of samples are loud AND fewer than 10% are silent
                        // Speech has natural pauses so silentCount stays higher
                        const isBgNoise = loudCount / 40 > 0.70 && silentCount / 40 < 0.10;

                        if (isBgNoise && !this.micActiveWarningShown && Date.now() > this.hotMicCooldownUntil) {
                            this.showMicActiveWarning();
                        } else if (!isBgNoise && this.micActiveWarningShown) {
                            this.hideMicActiveWarning();
                        }
                    }
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
                    <span class="stat-label">Audio:</span>
                    <span class="stat-value audio-value">--</span>
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
        const audioSpan = signalBars.querySelector('.audio-value');
        const resSpan = signalBars.querySelector('.res-value');
        const fpsSpan = signalBars.querySelector('.fps-value');

        // Track previous values for packet loss and audio bitrate calculation
        let prevPacketsReceived = 0;
        let prevPacketsLost = 0;
        let prevAudioBytes = 0;
        let prevAudioTime = Date.now();

        const updateStats = async () => {
            try {
                const stats = await pc.getStats();
                let rtt = null;
                let packetsReceived = 0;
                let packetsLost = 0;
                let frameWidth = null;
                let frameHeight = null;
                let fps = null;
                let audioBytesReceived = 0;

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

                    if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                        audioBytesReceived = report.bytesReceived || 0;
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
                    rttSpan.className = 'stat-value rtt-value';
                    if (rttMs < 100) {
                        rttSpan.classList.add('stat-good');
                    } else if (rttMs < 300) {
                        rttSpan.classList.add('stat-warning');
                        signalQuality = Math.min(signalQuality, 3);
                    } else if (rttMs < 500) {
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

                // Audio bitrate
                const now = Date.now();
                const deltaBytes = audioBytesReceived - prevAudioBytes;
                const deltaSec = (now - prevAudioTime) / 1000;
                const audioKbps = deltaSec > 0 ? Math.round((deltaBytes * 8) / deltaSec / 1000) : 0;
                prevAudioBytes = audioBytesReceived;
                prevAudioTime = now;

                // Watchdog: detect a stalled remote audio flow and self-heal (re-play, then
                // ICE restart) so users don't have to refresh to hear each other again.
                this.checkRemoteAudioHealth(peerId, pc, deltaBytes);

                audioSpan.textContent = audioKbps > 0 ? `${audioKbps} kbps` : '--';
                audioSpan.className = 'stat-value audio-value';
                if (audioKbps >= 128) audioSpan.classList.add('stat-good');
                else if (audioKbps >= 48) audioSpan.classList.add('stat-warning');
                else if (audioKbps > 0) audioSpan.classList.add('stat-bad');

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
                    <span class="stat-label">Audio:</span>
                    <span class="stat-value audio-value">--</span>
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
        const audioSpan = signalBars.querySelector('.audio-value');
        const resSpan = signalBars.querySelector('.res-value');
        const fpsSpan = signalBars.querySelector('.fps-value');
        let prevAudioBytesSent = 0;
        let prevAudioTime = Date.now();

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
            let totalAudioBytesSent = 0;

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
                        if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                            totalAudioBytesSent += report.bytesSent || 0;
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
                } else if (avgRtt < 300) {
                    rttSpan.classList.add('stat-warning');
                    signalQuality = Math.min(signalQuality, 3);
                } else if (avgRtt < 500) {
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

            // Audio bitrate (outbound)
            const now = Date.now();
            const deltaBytes = totalAudioBytesSent - prevAudioBytesSent;
            const deltaSec = (now - prevAudioTime) / 1000;
            const audioKbps = deltaSec > 0 ? Math.round((deltaBytes * 8) / deltaSec / 1000) : 0;
            prevAudioBytesSent = totalAudioBytesSent;
            prevAudioTime = now;
            audioSpan.textContent = audioKbps > 0 ? `${audioKbps} kbps` : '--';
            audioSpan.className = 'stat-value audio-value';
            if (audioKbps >= 128) audioSpan.classList.add('stat-good');
            else if (audioKbps >= 48) audioSpan.classList.add('stat-warning');
            else if (audioKbps > 0) audioSpan.classList.add('stat-bad');

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
        localStorage.setItem('broference-username', username);

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

            // Populate device selectors
            await this.updatePrejoinDeviceLists(this.prejoinStream);
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

    async setVideoQuality(quality) {
        this.videoQuality = quality;
        localStorage.setItem('broference-video-quality', quality);

        const stream = this.localStream || this.prejoinStream;
        if (!stream) return;

        const oldTrack = stream.getVideoTracks()[0];
        const deviceId = oldTrack?.getSettings().deviceId;
        const constraints = { ...this.getVideoConstraints() };
        if (deviceId) constraints.deviceId = { ideal: deviceId };

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
            const newTrack = newStream.getVideoTracks()[0];

            if (oldTrack) {
                oldTrack.stop();
                stream.removeTrack(oldTrack);
            }
            stream.addTrack(newTrack);

            if (this.localVideo) this.localVideo.srcObject = stream;

            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track?.kind === 'video');
                if (sender) sender.replaceTrack(newTrack);
            });
        } catch (err) {
            console.warn('Could not switch video quality:', err);
        }
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
        const videoBitrate = this.lowBandwidthMode ? 200000 : 1500000; // 200kbps low-band, else 1.5Mbps cap (mesh CPU/bandwidth guard)
        const audioBitrate = (this.lowBandwidthMode || this.isMobileDevice()) ? 64000 : 256000; // 64kbps mobile/low-band, 256kbps desktop

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

                // Set up persistent mic audio chain
                await this.setupMicAudioChain();

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
                localAvatar.dataset.initial = this.username.charAt(0).toUpperCase();
                if (this.gravatarHash) {
                    this.applyGravatarToAvatar(localAvatar, this.gravatarHash);
                } else {
                    localAvatar.textContent = this.username.charAt(0).toUpperCase();
                }
            }
            const localLabel = document.querySelector('#localContainer .video-label');
            if (localLabel && this.username) {
                localLabel.textContent = this.username;
            }

            // Set initial video state for local container
            const localContainer = document.getElementById('localContainer');
            localContainer.classList.toggle('no-video', !this.videoEnabled);

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

            // Auto-enable AI noise suppression on all devices
            try { await this.toggleNoiseSuppression(); } catch (e) { console.warn('Auto noise suppression failed:', e); }

            // Generate E2EE key pair before joining room
            await this.initE2EE();

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

        // Add local stream tracks with optimized RTP parameters.
        // Pick the tracks deliberately rather than iterating a single stream:
        // during a screen share the video is the screen track and the audio is
        // the mic+screen stereo mix (or the mic alone if the share has no system
        // audio). screenStream itself contains no mic track, so a peer joining
        // mid-share must be wired from these sources explicitly — otherwise the
        // late joiner gets screenStream's (often absent) audio and can't hear
        // the streamer at all.
        const activeStream = this.isScreenSharing && this.screenStream ? this.screenStream : this.localStream;

        const videoTrack = activeStream.getVideoTracks()[0];

        let audioTrack;
        if (this.isScreenSharing) {
            // Mirror exactly what existing peers receive (see startStereoScreenAudioMix):
            // the stereo mix when the share has system audio, otherwise the
            // processed/raw mic track so the streamer's voice still gets through.
            audioTrack = this.stereoMixTrack
                || this.micDestination?.stream.getAudioTracks()[0]
                || this.localStream.getAudioTracks()[0];
        } else if (this.micDestination) {
            // Use processed audio track if noise suppression is enabled
            audioTrack = this.micDestination.stream.getAudioTracks()[0] || this.localStream.getAudioTracks()[0];
        } else {
            audioTrack = this.localStream.getAudioTracks()[0];
        }

        const tracksToAdd = [];
        if (audioTrack) tracksToAdd.push(audioTrack);
        if (videoTrack) tracksToAdd.push(videoTrack);

        tracksToAdd.forEach(track => {
            const sender = pc.addTrack(track, activeStream);

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

                    parameters.encodings[0].maxBitrate = (this.lowBandwidthMode || this.isMobileDevice()) ? 64000 : 256000;

                    sender.setParameters(parameters).catch(err => {
                        console.warn('Could not set audio encoding parameters:', err);
                    });
                }
            }

            // Video bitrate: give a mid-share late joiner the same screen-share
            // encoding existing peers got; otherwise the normal mesh cap.
            if (track.kind === 'video' && sender.getParameters) {
                if (this.isScreenSharing) {
                    this.applyScreenShareEncoding(sender);
                } else {
                    const parameters = sender.getParameters();
                    if (parameters.encodings && parameters.encodings.length > 0) {
                        parameters.encodings[0].maxBitrate = this.lowBandwidthMode ? 200000 : 1500000;
                        sender.setParameters(parameters).catch(err => {
                            console.warn('Could not set video encoding parameters:', err);
                        });
                    }
                }
            }
        });

        // Prefer hardware-accelerated codecs (H.264 > VP9 > AV1 > VP8)
        this.setPreferredCodecs(pc);

        // Attach encrypt transforms if E2EE is active
        if (this.e2eeEnabled && this.e2eeWorker) {
            pc.getSenders().forEach(sender => {
                if (!sender.track) return;
                try {
                    sender.transform = new RTCRtpScriptTransform(
                        this.e2eeWorker, { operation: 'encrypt', kind: sender.track.kind });
                } catch (e) { console.warn('Could not set sender transform:', e); }
            });
        }

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

                // Wire health handlers on an audio track that arrived after the video track.
                if (event.track.kind === 'audio' && videoEl) {
                    this.attachRemoteAudioHandlers(peerId, event.track, videoEl);
                }
            }

            // Attach decrypt transform if E2EE is active
            if (this.e2eeEnabled && this.e2eeWorker) {
                try {
                    event.receiver.transform = new RTCRtpScriptTransform(
                        this.e2eeWorker, { operation: 'decrypt', kind: event.track.kind });
                } catch (e) { console.warn('Could not set receiver transform:', e); }
            }
        };

        // Handle ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // Strip raddr/rport from relay candidates before forwarding via signaling —
                // these fields reveal the real public IP even in relay-only mode.
                let candidate = event.candidate;
                if (candidate.candidate && candidate.candidate.includes('typ relay')) {
                    const sanitized = candidate.candidate.replace(/\s+raddr\s+\S+\s+rport\s+\d+/g, '');
                    candidate = new RTCIceCandidate({
                        candidate: sanitized,
                        sdpMid: candidate.sdpMid,
                        sdpMLineIndex: candidate.sdpMLineIndex,
                        usernameFragment: candidate.usernameFragment
                    });
                }
                this.sendMessage({
                    type: 'ice-candidate',
                    targetId: peerId,
                    data: candidate
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
                // Re-apply E2EE transforms now that the connection is fully established.
                // Chrome can reject the worker's pipeTo promise if transforms are set too
                // early (during ICE negotiation). Re-applying here guarantees the pipeline
                // is wired correctly on a stable connection.
                if (this.e2eeEnabled && this.e2eeWorker) {
                    this.applyMediaTransformsToPeer(peerId);
                }
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
        label.textContent = username;
        if (peerId === this.moderatorId) {
            this.applyLabelBadge(peerId, username, 'owner', label);
        } else if (this.coModIds.has(peerId)) {
            this.applyLabelBadge(peerId, username, 'co-mod', label);
        }

        // Add avatar for when video is off
        const avatar = document.createElement('div');
        avatar.className = 'video-avatar';
        avatar.dataset.initial = username.charAt(0).toUpperCase();
        const existingHash = this.peerGravatarHashes.get(peerId);
        if (existingHash) {
            this.applyGravatarToAvatar(avatar, existingHash);
        } else {
            avatar.textContent = username.charAt(0).toUpperCase();
        }
        container.appendChild(avatar);

        // Apply any already-received video-state before checking the track
        // (video-state can arrive before the container exists, so we cache it)
        const signaledState = this.peerVideoStates.get(peerId);
        if (signaledState !== undefined) {
            container.dataset.signaledVideoEnabled = signaledState ? 'true' : 'false';
            container.classList.toggle('no-video', !signaledState);
        }

        // Monitor video track to show/hide avatar
        const videoTrack = stream.getVideoTracks()[0];
        if (videoTrack) {
            // Check initial state only if no signaled state overrides it
            if (signaledState === undefined && (!videoTrack.enabled || videoTrack.muted)) {
                container.classList.add('no-video');
            }

            // Listen for track state changes
            videoTrack.onmute = () => {
                // Don't show avatar if peer signaled their video is on (e.g. screen sharing via replaceTrack)
                if (container.dataset.signaledVideoEnabled === 'true') return;
                container.classList.add('no-video');
            };
            videoTrack.onunmute = () => {
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

        // Monitor remote AUDIO track health (re-kick playback on transient stalls).
        // The deeper no-recovery case is handled by the stats-loop watchdog below.
        const audioTrack = stream.getAudioTracks()[0];
        if (audioTrack) this.attachRemoteAudioHandlers(peerId, audioTrack, video);

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
            isMuted: false,
            hasReceivedAudio: false,
            audioStallCount: 0,
            audioRecoveryAttempted: false
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
            videoEnabled: this.videoEnabled || this.isScreenSharing
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

    // Add/refresh moderator controls on every remote video container.
    // Clears and rebuilds — handles owner/co-mod permission differences.
    refreshModeratorControls() {
        if (!this.isModerator) return;

        this.peerConnections.forEach((peer, peerId) => {
            const audioControls = document.querySelector(`#video-${peerId} .remote-audio-controls`);
            if (!audioControls) return;

            // Always rebuild mod controls so buttons reflect current role
            audioControls.querySelectorAll('[data-mod-control]').forEach(el => el.remove());

            const targetIsOwner = peerId === this.moderatorId;
            const targetIsCoMod = this.coModIds.has(peerId);

            // Co-mods cannot act on the owner or other co-mods
            if (!this.isOwner && (targetIsOwner || targetIsCoMod)) return;

            // Owner: transfer ownership button (only on non-mod users)
            if (this.isOwner && !targetIsCoMod) {
                const promoteBtn = document.createElement('button');
                promoteBtn.textContent = '👑';
                promoteBtn.title = 'Transfer ownership';
                promoteBtn.dataset.modControl = 'promote';
                promoteBtn.onclick = () => this.promoteToModerator(peerId);
                audioControls.appendChild(promoteBtn);
            }

            // Owner: add/remove co-mod button
            if (this.isOwner) {
                if (targetIsCoMod) {
                    const demoteBtn = document.createElement('button');
                    demoteBtn.textContent = '🛡️';
                    demoteBtn.title = 'Remove co-moderator';
                    demoteBtn.dataset.modControl = 'demote-comod';
                    demoteBtn.onclick = () => this.removeCoMod(peerId);
                    audioControls.appendChild(demoteBtn);
                } else {
                    const coModBtn = document.createElement('button');
                    coModBtn.textContent = '🛡️';
                    coModBtn.title = 'Add as co-moderator';
                    coModBtn.dataset.modControl = 'add-comod';
                    coModBtn.onclick = () => this.addCoMod(peerId);
                    audioControls.appendChild(coModBtn);
                }
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

            audioControls.appendChild(renameBtn);
            audioControls.appendChild(kickBtn);

            // Ban button: owner only
            if (this.isOwner) {
                const banBtn = document.createElement('button');
                banBtn.textContent = '🚫';
                banBtn.title = 'Ban user';
                banBtn.dataset.modControl = 'ban';
                banBtn.onclick = () => this.banUser(peerId);
                audioControls.appendChild(banBtn);
            }
        });
    }

    updateLockButton() {
        const btn = document.getElementById('lockRoomBtn');
        if (!btn) return;
        btn.style.display = this.isOwner ? '' : 'none';
        if (this.roomLocked) {
            btn.textContent = '🔒 Locked';
            btn.classList.add('active');
        } else {
            btn.textContent = '🔓 Lock Room';
            btn.classList.remove('active');
        }
    }

    setRoomPassword() {
        if (!this.isOwner) return;
        let newPassword;
        if (this.roomLocked) {
            newPassword = prompt('Room is locked. Enter a new password to change it, or leave blank to unlock:');
            if (newPassword === null) return; // cancelled
        } else {
            newPassword = prompt('Enter a password to lock this room (leave blank to cancel):');
            if (!newPassword) return;
        }
        this.sendMessage({ type: 'set-room-password', password: newPassword || null });
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
        if (!this.isOwner) return;
        const peer = this.peerConnections.get(targetId);
        if (!peer) return;
        if (confirm(`Transfer room ownership to ${peer.username}? You will lose owner status.`)) {
            this.sendMessage({ type: 'promote-moderator', targetId });
        }
    }

    addCoMod(targetId) {
        if (!this.isOwner) return;
        const peer = this.peerConnections.get(targetId);
        if (!peer) return;
        if (confirm(`Make ${peer.username} a co-moderator?`)) {
            this.sendMessage({ type: 'add-co-mod', targetId });
        }
    }

    removeCoMod(targetId) {
        if (!this.isOwner) return;
        const peer = this.peerConnections.get(targetId);
        if (!peer) return;
        if (confirm(`Remove co-moderator status from ${peer.username}?`)) {
            this.sendMessage({ type: 'remove-co-mod', targetId });
        }
    }

    // Apply or update the badge (crown/shield/none) on a remote video label.
    // Pass an existing label element to update in-place, or omit to find it by peerId.
    applyLabelBadge(peerId, username, role, labelEl) {
        const label = labelEl || document.querySelector(`#video-${peerId} .video-label`);
        if (!label) return;
        label.innerHTML = '';
        if (role === 'owner') {
            const span = document.createElement('span');
            span.className = 'mod-crown';
            span.textContent = '👑';
            label.appendChild(span);
            label.appendChild(document.createTextNode(' ' + username));
        } else if (role === 'co-mod') {
            const span = document.createElement('span');
            span.className = 'mod-badge';
            span.textContent = '🛡️';
            label.appendChild(span);
            label.appendChild(document.createTextNode(' ' + username));
        } else {
            label.textContent = username;
        }
    }

    moderatorChangeName(targetId) {
        if (!this.isModerator) return;

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

    // Wire health handlers on a remote AUDIO track — the parallel of the video-track
    // handlers in addRemoteVideo. A transient RTP stall (NAT rebind, congestion) fires
    // `mute`; when it clears we re-kick the media element in case its playback wedged
    // while silent. Deeper stalls that never fire `unmute` are caught by the stats-loop
    // watchdog (checkRemoteAudioHealth).
    attachRemoteAudioHandlers(peerId, audioTrack, video) {
        if (!audioTrack || audioTrack._healthWired) return;
        audioTrack._healthWired = true;
        audioTrack.onmute = () => {
            console.warn(`Remote audio track muted for peer ${peerId}`);
        };
        audioTrack.onunmute = () => {
            console.log(`Remote audio unmuted for peer ${peerId}, re-kicking playback`);
            if (video) video.play().catch(() => {});
        };
    }

    // Watchdog driven by the per-peer stats loop (runs every 5s while connected).
    // "Can't hear after a while, refresh fixes it" is a remote-audio RTP stall while the
    // PeerConnection stays `connected` — it slips past the ICE-restart-on-disconnect path.
    // We detect a flatline in audio bytes-received and self-heal: first re-play the element,
    // then (once per episode) renegotiate via ICE restart.
    checkRemoteAudioHealth(peerId, pc, audioDeltaBytes) {
        const controls = this.remoteAudioControls.get(peerId);
        if (!controls || !controls.videoElement) return;

        // Only meaningful on a live transport, and skip peers we've locally muted.
        if (pc.connectionState !== 'connected' || controls.isMuted) {
            controls.audioStallCount = 0;
            return;
        }

        if (audioDeltaBytes > 0) {
            controls.hasReceivedAudio = true;
            controls.audioStallCount = 0;
            controls.audioRecoveryAttempted = false;
            return;
        }

        // Flatlined. Only act once audio was actually flowing, so a peer who simply never
        // sent audio (or just joined) doesn't trip the watchdog.
        if (!controls.hasReceivedAudio) return;

        controls.audioStallCount = (controls.audioStallCount || 0) + 1;

        if (controls.audioStallCount === 2) {
            // ~10s silent — re-kick the media element in case playback stalled.
            console.warn(`Remote audio stalled for peer ${peerId} (~10s), re-playing element`);
            controls.videoElement.play().catch(() => {});
        } else if (controls.audioStallCount >= 3 && !controls.audioRecoveryAttempted) {
            // ~15s silent and re-play didn't help — renegotiate the media flow. Once per episode.
            controls.audioRecoveryAttempted = true;
            console.warn(`Remote audio still stalled for peer ${peerId} (~15s), attempting ICE restart`);
            this.attemptIceRestart(peerId).catch(() => {});
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

    // Screen share needs far more bitrate than a webcam and must not drop frame
    // rate to hold resolution. Lift the per-sender cap to ~4 Mbps (0.8 Mbps in
    // low-bandwidth mode) and pin degradationPreference so text/UI stays smooth.
    applyScreenShareEncoding(sender) {
        if (!sender || !sender.getParameters) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.degradationPreference = 'maintain-resolution';
            params.encodings[0].maxBitrate = this.lowBandwidthMode ? 800000 : 4000000;
            delete params.encodings[0].scaleResolutionDownBy;
            sender.setParameters(params).catch(err => {
                console.warn('Could not apply screen-share encoding:', err);
            });
        } catch (err) {
            console.warn('Error applying screen-share encoding:', err);
        }
    }

    // Put the camera sender back under the normal mesh bitrate guard once the
    // screen share stops, so a webcam can't hog the 4 Mbps screen budget.
    restoreCameraEncoding(sender) {
        if (!sender || !sender.getParameters) return;
        try {
            const params = sender.getParameters();
            if (!params.encodings || params.encodings.length === 0) return;
            params.degradationPreference = 'balanced';
            params.encodings[0].maxBitrate = this.lowBandwidthMode ? 200000 : 1500000;
            sender.setParameters(params).catch(err => {
                console.warn('Could not restore camera encoding:', err);
            });
        } catch (err) {
            console.warn('Error restoring camera encoding:', err);
        }
    }

    async toggleScreenShare() {
        if (!this.isScreenSharing) {
            try {
                // Request screen sharing with system audio
                const screenQuality = this.getVideoConstraints();
                this.screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: {
                        cursor: 'always',
                        width: screenQuality.width,
                        height: screenQuality.height,
                        frameRate: { ideal: 30, max: 60 }
                    },
                    audio: {
                        // EC must stay ON: without it, system/entire-screen audio capture
                        // re-captures the conference audio playing on the sharer's machine
                        // and loops it back, so remote users hear themselves.
                        echoCancellation: true,
                        noiseSuppression: false,
                        autoGainControl: false,
                        sampleRate: 48000
                    }
                });

                // Replace video track in all peer connections
                const screenVideoTrack = this.screenStream.getVideoTracks()[0];
                // Screen content is high-detail / low-motion: hint the encoder so it
                // keeps resolution sharp instead of collapsing frame rate, then give it
                // real bitrate headroom (the camera path is capped at 1.5 Mbps, which
                // starves screen content and is the main cause of choppy/low-FPS shares).
                screenVideoTrack.contentHint = 'detail';
                this.peerConnections.forEach(peer => {
                    const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                    if (sender) {
                        sender.replaceTrack(screenVideoTrack);
                        this.applyScreenShareEncoding(sender);
                    }
                });

                // Auto-disable noise suppression during screen share (preserves audio fidelity)
                this._nsWasEnabledBeforeScreenShare = this.noiseSuppressionEnabled;
                if (this.noiseSuppressionEnabled) await this.toggleNoiseSuppression();

                // Mix mic + stereo screen audio and push to peers
                this.startStereoScreenAudioMix(this.screenStream);

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

                // Tell remote peers to hide our avatar
                this.sendMessage({ type: 'video-state', videoEnabled: true });

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
            if (cameraVideoTrack) cameraVideoTrack.contentHint = 'motion';
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) {
                    sender.replaceTrack(cameraVideoTrack);
                    this.restoreCameraEncoding(sender);
                }
            });

            // Tear down stereo screen audio mix, restore mic track in senders
            this.stopStereoScreenAudioMix();

            // Restore noise suppression if it was on before screen share
            if (this._nsWasEnabledBeforeScreenShare) await this.toggleNoiseSuppression();
            this._nsWasEnabledBeforeScreenShare = false;

            this.localVideo.srcObject = this.localStream;
            this.isScreenSharing = false;
            document.getElementById('shareScreenBtn').classList.remove('active');

            // Restore correct avatar state after screen share ends
            document.getElementById('localContainer').classList.toggle('no-video', !this.videoEnabled);

            // Tell remote peers to restore correct avatar state
            this.sendMessage({ type: 'video-state', videoEnabled: this.videoEnabled });

            console.log('Screen sharing stopped');
        }
    }

    startStereoScreenAudioMix(screenStream) {
        const screenAudioTracks = screenStream.getAudioTracks();
        if (screenAudioTracks.length === 0) {
            console.log('No screen audio available');
            return;
        }

        try {
            this.stereoMixCtx = new AudioContext({ sampleRate: 48000 });
            // Resume in case the context starts suspended (autoplay policy) — otherwise the mix is silent
            if (this.stereoMixCtx.state === 'suspended') this.stereoMixCtx.resume().catch(() => {});
            const destination = this.stereoMixCtx.createMediaStreamDestination();
            destination.channelCount = 2;

            // Screen audio (stereo)
            this.stereoScreenGain = this.stereoMixCtx.createGain();
            const screenSource = this.stereoMixCtx.createMediaStreamSource(new MediaStream([screenAudioTracks[0]]));
            screenSource.connect(this.stereoScreenGain);
            this.stereoScreenGain.connect(destination);

            // Mic audio (raw mono track — browser auto-upmixes to both channels)
            const micTrack = this.localStream?.getAudioTracks()[0];
            if (micTrack) {
                this.stereoMicGain = this.stereoMixCtx.createGain();
                const micSource = this.stereoMixCtx.createMediaStreamSource(new MediaStream([micTrack]));
                micSource.connect(this.stereoMicGain);
                this.stereoMicGain.connect(destination);
            }

            // Push stereo track to all peer senders
            this.stereoMixTrack = destination.stream.getAudioTracks()[0];
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) sender.replaceTrack(this.stereoMixTrack);
            });

            // Wire mixer UI
            const mixer = document.getElementById('screenAudioMixer');
            if (mixer) {
                mixer.classList.remove('hidden');
                const micSlider = document.getElementById('micGainSlider');
                const screenSlider = document.getElementById('screenGainSlider');
                const micVal = document.getElementById('micGainValue');
                const screenVal = document.getElementById('screenGainValue');
                micSlider.value = 100;
                screenSlider.value = 100;
                micVal.textContent = '100%';
                screenVal.textContent = '100%';
                micSlider.oninput = (e) => {
                    if (this.stereoMicGain) this.stereoMicGain.gain.value = e.target.value / 100;
                    micVal.textContent = e.target.value + '%';
                };
                screenSlider.oninput = (e) => {
                    if (this.stereoScreenGain) this.stereoScreenGain.gain.value = e.target.value / 100;
                    screenVal.textContent = e.target.value + '%';
                };
            }

            console.log('Stereo screen audio mix started');
        } catch (error) {
            console.error('Error starting stereo screen audio mix:', error);
        }
    }

    stopStereoScreenAudioMix() {
        if (!this.stereoMixCtx) return;

        // Restore mic track in all peer senders
        const micTrack = this.micDestination?.stream.getAudioTracks()[0];
        if (micTrack) {
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track?.kind === 'audio');
                if (sender) sender.replaceTrack(micTrack);
            });
        }

        this.stereoMixCtx.close();
        this.stereoMixCtx = null;
        this.stereoMixTrack = null;
        this.stereoScreenGain = null;
        this.stereoMicGain = null;

        const mixer = document.getElementById('screenAudioMixer');
        if (mixer) mixer.classList.add('hidden');

        console.log('Restored original mic audio');
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
        this.videoEnabled = !this.videoEnabled;

        if (this.localStream) {
            this.localStream.getVideoTracks().forEach(track => {
                track.enabled = this.videoEnabled;
            });
        }

        const btn = document.getElementById('toggleVideoBtn');
        btn.classList.toggle('active', !this.videoEnabled);
        btn.querySelector('.icon').textContent = this.videoEnabled ? '📹' : '📷';

        document.getElementById('localContainer').classList.toggle('no-video', !this.videoEnabled);

        this.sendMessage({ type: 'video-state', videoEnabled: this.videoEnabled });
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
        const isOpening = optionsMenu.classList.contains('hidden');
        optionsMenu.classList.toggle('hidden');
        optionsOverlay.classList.toggle('hidden');
        if (isOpening) {
            this.updateCameraDeviceList();
            this.updateMicDeviceList();
            this.updateMicDeviceListOptions();
        }
    }

    toggleChangelog() {
        document.getElementById('changelogModal').classList.toggle('hidden');
        document.getElementById('changelogOverlay').classList.toggle('hidden');
    }

    async toggleNoiseSuppression() {
        const btn = document.getElementById('noiseSuppressionBtn');
        const noiseGateSettings = document.getElementById('noiseGateSettings');

        if (!this.noiseSuppressionEnabled) {
            try {
                // Ensure mic audio chain is ready (micAudioCtx + worklet already loaded by setupMicAudioChain)
                if (!this.micAudioCtx) {
                    await this.setupMicAudioChain();
                }
                if (this.micAudioCtx.state === 'suspended') {
                    await this.micAudioCtx.resume();
                }

                // Create the noise suppression processor node
                this.noiseSuppressionNode = new AudioWorkletNode(this.micAudioCtx, 'noise-suppression-processor');

                // Set up audio level reporting from the processor
                this.noiseSuppressionNode.port.onmessage = (event) => {
                    if (event.data.type === 'audioLevel') {
                        this.handleAudioLevelUpdate(event.data);
                    }
                };
                this.noiseSuppressionNode.port.start();

                // Apply saved threshold setting
                this.updateNoiseGateThreshold(this.noiseGateThreshold);

                // Insert NS node into existing chain: micSource → noiseSuppressionNode → micDestination
                this.micSource.disconnect();
                this.micSource.connect(this.noiseSuppressionNode);
                this.noiseSuppressionNode.connect(this.micDestination);
                // processedStream is already micDestination.stream — no replaceTrack needed

                this.noiseSuppressionEnabled = true;
                btn.setAttribute('data-enabled', 'true');
                btn.querySelector('.toggle-status').textContent = 'ON';

                noiseGateSettings.classList.remove('hidden');
                this.updateMicDeviceList();

                this.micConstantlyActiveCount = 0;
                this.hideMicActiveWarning();

                console.log('AI Noise Suppression enabled');

            } catch (error) {
                console.error('Error enabling noise suppression:', error);
                throw error;
            }
        } else {
            // Disable noise suppression
            try {
                // Remove NS node from chain: micSource → micDestination directly
                if (this.noiseSuppressionNode) {
                    this.micSource.disconnect();
                    this.noiseSuppressionNode.disconnect();
                    this.noiseSuppressionNode = null;
                    this.micSource.connect(this.micDestination);
                    // processedStream is still micDestination.stream — no replaceTrack needed
                }

                this.noiseSuppressionEnabled = false;
                btn.setAttribute('data-enabled', 'false');
                btn.querySelector('.toggle-status').textContent = 'OFF';

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

    async updateMicDeviceListOptions() {
        const select = document.getElementById('micDeviceSelectOptions');
        if (!select) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            const audioTrack = this.localStream?.getAudioTracks()[0];
            const currentDeviceId = audioTrack ? audioTrack.getSettings().deviceId : null;
            select.innerHTML = '';
            audioInputs.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Microphone ${i + 1}`;
                if (device.deviceId === currentDeviceId) option.selected = true;
                select.appendChild(option);
            });
        } catch (error) {
            console.warn('Could not enumerate mic devices:', error);
        }
    }

    async updateCameraDeviceList() {
        const select = document.getElementById('cameraDeviceSelect');
        if (!select) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const videoInputs = devices.filter(d => d.kind === 'videoinput');
            const videoTrack = this.localStream?.getVideoTracks()[0];
            const currentDeviceId = videoTrack ? videoTrack.getSettings().deviceId : null;
            select.innerHTML = '';
            videoInputs.forEach((device, i) => {
                const option = document.createElement('option');
                option.value = device.deviceId;
                option.textContent = device.label || `Camera ${i + 1}`;
                if (device.deviceId === currentDeviceId) option.selected = true;
                select.appendChild(option);
            });
        } catch (error) {
            console.warn('Could not enumerate camera devices:', error);
        }
    }

    async switchCamera(deviceId) {
        try {
            const constraints = { ...this.getVideoConstraints(), deviceId: { exact: deviceId } };
            const newStream = await navigator.mediaDevices.getUserMedia({ video: constraints });
            const newVideoTrack = newStream.getVideoTracks()[0];

            const oldVideoTrack = this.localStream?.getVideoTracks()[0];
            if (oldVideoTrack) {
                oldVideoTrack.stop();
                this.localStream.removeTrack(oldVideoTrack);
            }
            this.localStream.addTrack(newVideoTrack);

            // Update local video preview
            if (this.localVideo) this.localVideo.srcObject = this.localStream;

            // Replace track in all peer connections
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(newVideoTrack);
            });

            localStorage.setItem('broference-preferred-camera', deviceId);
            console.log('Switched camera to:', newVideoTrack.label);
        } catch (error) {
            console.error('Error switching camera:', error);
        }
    }

    async updatePrejoinDeviceLists(stream) {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            const videoInputs = devices.filter(d => d.kind === 'videoinput');

            const currentMicId = stream?.getAudioTracks()[0]?.getSettings().deviceId;
            const currentCamId = stream?.getVideoTracks()[0]?.getSettings().deviceId;

            const micSel = document.getElementById('prejoinMicSelect');
            micSel.innerHTML = '';
            audioInputs.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Microphone ${i + 1}`;
                if (d.deviceId === currentMicId) opt.selected = true;
                micSel.appendChild(opt);
            });

            const camSel = document.getElementById('prejoinCameraSelect');
            camSel.innerHTML = '';
            videoInputs.forEach((d, i) => {
                const opt = document.createElement('option');
                opt.value = d.deviceId;
                opt.textContent = d.label || `Camera ${i + 1}`;
                if (d.deviceId === currentCamId) opt.selected = true;
                camSel.appendChild(opt);
            });
        } catch (error) {
            console.warn('Could not enumerate devices for prejoin:', error);
        }
    }

    async prejoinSwitchDevice(kind, deviceId) {
        if (!this.prejoinStream) return;
        try {
            const constraints = kind === 'audio'
                ? { audio: { ...this.getAudioConstraints(), deviceId: { exact: deviceId } } }
                : { video: { ...this.getVideoConstraints(), deviceId: { exact: deviceId } } };

            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newTrack = kind === 'audio' ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];

            // Stop and replace old track
            const oldTracks = kind === 'audio' ? this.prejoinStream.getAudioTracks() : this.prejoinStream.getVideoTracks();
            oldTracks.forEach(t => { t.stop(); this.prejoinStream.removeTrack(t); });
            this.prejoinStream.addTrack(newTrack);

            // Preserve enabled state for video
            if (kind === 'video') newTrack.enabled = this.prejoinVideoEnabled;
            if (kind === 'audio') newTrack.enabled = this.prejoinAudioEnabled;

            document.getElementById('prejoinVideo').srcObject = this.prejoinStream;
        } catch (error) {
            console.error(`Error switching prejoin ${kind} device:`, error);
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

            // Re-wire audio chain with the new source track (handles NS state automatically)
            await this.setupMicAudioChain();

            // Replace the destination track in all peer connections
            const destTrack = this.micDestination
                ? this.micDestination.stream.getAudioTracks()[0]
                : newAudioTrack;
            this.peerConnections.forEach(peer => {
                const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'audio');
                if (sender) sender.replaceTrack(destTrack);
            });

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

    async sendChatMessage() {
        const message = this.chatInput.value.trim();
        if (!message && !this.pendingImageData) return;

        if (this.pendingImageData) {
            if (this.e2eeEnabled) {
                this.addChatMessage('System', 'Images cannot be sent in E2EE mode.', true);
                this.clearImagePreview();
                return;
            }
            const imageData = this.pendingImageData;
            this.clearImagePreview();
            this.chatInput.value = '';
            this.sendMessage({ type: 'chat-message', message: message || '[image]', imageData });
            return;
        }

        if (message.startsWith('/')) {
            this.handleChatCommand(message);
            this.chatInput.value = '';
            return;
        }

        if (this.e2eeEnabled) {
            if (!this.e2eeRoomKey) {
                this.addChatMessage('System', 'Waiting for encryption key...', true);
                return;
            }
            try {
                const encrypted = await this.encryptMessage(message);
                this.sendMessage({ type: 'chat-message', message: '[E2EE]', encrypted });
            } catch (e) {
                this.addChatMessage('System', 'Encryption failed. Message not sent.', true);
                return;
            }
        } else {
            this.sendMessage({ type: 'chat-message', message });
        }

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

    addChatMessage(username, text, isSystem = false, isIRC = false, isOwn = false, isEncrypted = false, isFailed = false, imageData = null) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';

        if (isOwn) messageDiv.classList.add('own');
        if (isIRC) messageDiv.classList.add('irc');
        if (isEncrypted) messageDiv.classList.add('e2ee-message');
        if (isFailed) messageDiv.classList.add('e2ee-failed');

        const usernameSpan = document.createElement('div');
        usernameSpan.className = 'username';
        const prefix = !isSystem ? this.getNickPrefix(username, isOwn) : '';
        usernameSpan.textContent = prefix + username;

        const textSpan = document.createElement('div');
        textSpan.className = 'text';

        // Linkify the text if it's not a system message; hide "[image]" sentinel
        if (!isSystem) {
            const displayText = (imageData && text === '[image]') ? '' : text;
            if (displayText) textSpan.innerHTML = this.linkifyText(displayText);
        } else {
            textSpan.textContent = text;
        }

        const timestamp = document.createElement('div');
        timestamp.className = 'timestamp';
        timestamp.textContent = new Date().toLocaleTimeString();

        if (isEncrypted) {
            const badge = document.createElement('span');
            badge.className = 'e2ee-lock-badge';
            badge.textContent = '🔒';
            badge.title = 'End-to-end encrypted';
            timestamp.appendChild(badge);
        }

        messageDiv.appendChild(usernameSpan);
        if (textSpan.textContent || textSpan.innerHTML) messageDiv.appendChild(textSpan);

        if (imageData) {
            const imgEl = document.createElement('img');
            imgEl.src = imageData;
            imgEl.className = 'chat-img';
            imgEl.alt = 'Image';
            imgEl.title = 'Click to view full size';
            imgEl.addEventListener('click', () => {
                const [header, b64] = imageData.split(',');
                const mime = (header.match(/:(.*?);/) || [])[1] || 'image/jpeg';
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
                window.open(url, '_blank', 'noopener,noreferrer');
                setTimeout(() => URL.revokeObjectURL(url), 60000);
            });
            messageDiv.appendChild(imgEl);
        }

        messageDiv.appendChild(timestamp);

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

        // Increment unread count if chat is hidden and not a system message from self
        if (!this.chatVisible && !isOwn) {
            this.unreadMessageCount++;
            this.updateChatNotification();
        }
    }

    compressImage(file) {
        return new Promise((resolve) => {
            const img = new Image();
            const url = URL.createObjectURL(file);
            img.onload = () => {
                URL.revokeObjectURL(url);
                const maxDim = 1024;
                let { width, height } = img;
                if (width > maxDim || height > maxDim) {
                    if (width >= height) {
                        height = Math.round(height * maxDim / width);
                        width = maxDim;
                    } else {
                        width = Math.round(width * maxDim / height);
                        height = maxDim;
                    }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                resolve(canvas.toDataURL('image/jpeg', 0.75));
            };
            img.src = url;
        });
    }

    async handleImagePaste(file) {
        const dataURL = await this.compressImage(file);
        this.pendingImageData = dataURL;
        const preview = document.getElementById('chatImagePreview');
        document.getElementById('chatImagePreviewImg').src = dataURL;
        preview.classList.remove('hidden');
        this.chatInput.placeholder = 'Add a caption... (optional)';
        this.chatInput.focus();
    }

    clearImagePreview() {
        this.pendingImageData = null;
        document.getElementById('chatImagePreview').classList.add('hidden');
        document.getElementById('chatImagePreviewImg').src = '';
        this.chatInput.placeholder = 'Type a message...';
    }

    updateRoomInfo(participantCount) {
        document.title = `${this.currentRoom} - BroFerence`;
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
            localStorage.setItem('broference-username', this.username);

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

        // Clean up mic audio chain
        if (this.noiseSuppressionNode) {
            this.noiseSuppressionNode.disconnect();
            this.noiseSuppressionNode = null;
        }
        if (this.micAudioCtx) {
            this.micAudioCtx.close();
            this.micAudioCtx = null;
            this.micSource = null;
            this.micDestination = null;
        }
        this.noiseSuppressionEnabled = false;
        const noiseBtn = document.getElementById('noiseSuppressionBtn');
        if (noiseBtn) {
            noiseBtn.setAttribute('data-enabled', 'false');
            noiseBtn.querySelector('.toggle-status').textContent = 'OFF';
        }

        // Clear E2EE state
        this.e2eeEnabled = false;
        this.e2eeKeyPair = null;
        this.e2eeRoomKey = null;
        this.peerPublicKeys.clear();
        this.peerSharedKeys.clear();
        this.pendingRoomKeyData = null;
        this.removeMediaTransforms();
        this.updateE2EEUI();

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
        this.clearImagePreview();
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
window._client = _client; // expose for console debugging
