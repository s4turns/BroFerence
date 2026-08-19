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
        this.turnFailedPeers = new Set(); // Peers whose TURN relay has failed; retry with fresh relay-only config on next connect
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
        this.mediaNotice = null;        // why a mic/camera is missing, surfaced in prejoin and chat
        this.awaitingRestartReload = false; // countdown hit zero; page reloads once the server answers again
        this.screenStream = null;
        this.isScreenSharing = false;

        // Screen share runs on its own peer connections, separate from the camera
        // mesh. The sharer always offers and the viewer always answers, so glare is
        // impossible here and none of the main-mesh ICE-restart machinery applies.
        this.screenPeerConnections = new Map(); // Map<peerId, {connection, username, retryCount}> — our screen → peer
        this.screenReceivers = new Map();       // Map<peerId, {connection, username}> — their screen → us
        this.screenPendingIce = new Map();      // Map<`${peerId}:${role}`, Array<candidate>>
        this.currentPresenterId = null;         // room-wide presenter, null when nobody is sharing
        this.screenBroadcasting = false;        // true once the server granted us the slot and we started offering

        // ICE servers - will be set dynamically in initICEServers()
        this.iceServers = null;
        this.turnSelectionPromise = null; // in-flight/completed TURN latency probe
        this.bestTurnUrl = null;          // closest relay for this client
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
        this.prejoinMediaPromise = null; // in-flight getUserMedia, awaited if Join is hit early
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
        this.refreshOwnLabelBadge();
    }

    // Your own tile gets the same crown/shield everyone else sees on you.
    // Without this the owner is the only person in the room with no badge.
    refreshOwnLabelBadge() {
        const role = this.isOwner ? 'owner' : (this.isModerator ? 'co-mod' : 'user');
        const name = this.localLabelName || this.username;
        if (!name) return;
        this.applyLabelBadge('local', name, role);
    }

    // Rename your own tile without dropping the role badge, and keep the
    // avatar initial in sync.
    setLocalLabelName(name) {
        this.localLabelName = name;
        const avatar = document.getElementById('localAvatar');
        if (avatar && name) {
            const initial = name.charAt(0).toUpperCase();
            avatar.dataset.initial = initial;
            // Don't stomp a gravatar image with the initial letter.
            if (!this.gravatarHash) avatar.textContent = initial;
        }
        const screenLabel = document.querySelector('#video-local-screen .video-label');
        if (screenLabel && name) screenLabel.textContent = `${name}'s screen`;
        this.refreshOwnLabelBadge();
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
            // Owner only, never co-mods: two moderators handing a joiner two
            // different keys is how the room ends up unable to read itself.
            if (this.isOwner && this.e2eeEnabled && this.e2eeRoomKey) {
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
        // The owner is the only key authority. Accepting one from a co-mod as well
        // let a second key into the room, and whichever arrived last silently
        // replaced the one everyone else was encrypting with.
        if (peerId !== this.moderatorId) return;
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

    applyMediaTransformsToConnection(pc) {
        if (!this.e2eeWorker || !pc) return;
        pc.getSenders().forEach(sender => {
            if (!sender.track) return;
            try {
                sender.transform = new RTCRtpScriptTransform(
                    this.e2eeWorker, { operation: 'encrypt', kind: sender.track.kind });
            } catch (e) { console.warn('Could not set sender transform:', e); }
        });
        pc.getReceivers().forEach(receiver => {
            if (!receiver.track) return;
            try {
                receiver.transform = new RTCRtpScriptTransform(
                    this.e2eeWorker, { operation: 'decrypt', kind: receiver.track.kind });
            } catch (e) { console.warn('Could not set receiver transform:', e); }
        });
    }

    applyMediaTransformsToPeer(peerId) {
        const peer = this.peerConnections.get(peerId);
        if (!peer) return;
        this.applyMediaTransformsToConnection(peer.connection);
    }

    // Every connection carrying media must be covered, screen channel included.
    // A screen PC left out here would send frames in the clear while the rest of
    // the room is encrypted — and still render perfectly on the far side, so the
    // gap would be invisible.
    applyMediaTransformsToAll() {
        for (const peerId of this.peerConnections.keys()) {
            this.applyMediaTransformsToPeer(peerId);
        }
        this.screenPeerConnections.forEach(p => this.applyMediaTransformsToConnection(p.connection));
        this.screenReceivers.forEach(p => this.applyMediaTransformsToConnection(p.connection));
    }

    removeMediaTransforms() {
        const clear = pc => {
            pc.getSenders().forEach(s => { try { s.transform = null; } catch {} });
            pc.getReceivers().forEach(r => { try { r.transform = null; } catch {} });
        };
        this.peerConnections.forEach(peer => clear(peer.connection));
        this.screenPeerConnections.forEach(peer => clear(peer.connection));
        this.screenReceivers.forEach(peer => clear(peer.connection));
        if (this.e2eeWorker) {
            this.e2eeWorker.terminate();
            this.e2eeWorker = null;
        }
        this.e2eeRawKey = null;
    }

    async handleE2EEToggle(enabled) {
        this.e2eeEnabled = enabled;
        if (enabled) {
            // Only the owner mints the room key. A co-mod can still turn E2EE on —
            // the toggle is broadcast room-wide, so this handler runs on the owner's
            // client too and it is the owner's key that gets distributed.
            if (this.isOwner) {
                await this.generateRoomKey();   // also stores e2eeRawKey + posts to worker
                this.initMediaE2EEWorker();
                await this.distributeRoomKey();
                this.applyMediaTransformsToAll();
            }
            this.addChatMessage('System', 'End-to-end encryption enabled.', true);
            this.speakText('End to end encrypted');
        } else {
            this.e2eeRoomKey = null;
            this.removeMediaTransforms();
            this.addChatMessage('System', 'End-to-end encryption disabled.', true);
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
        // Both are always offered for redundancy; selectBestTurnServer() reorders
        // them so the one with the lowest allocation RTT for this client is first,
        // which is what the ICE agent prioritises.
        this.turnConfigs = [localTurnConfig, turn2Config];

        this.iceServers = {
            iceServers: [localTurnConfig, turn2Config],
            iceTransportPolicy: 'relay'
        };

        // Fallback after relay exhaustion: fresh relay-only config.
        // Never P2P — direct ICE candidates expose participants' real IPs.
        this.iceServersFallback = {
            iceServers: [
                localTurnConfig,
                turn2Config
            ],
            iceTransportPolicy: 'relay'
        };
    }

    /**
     * Time how long a TURN server takes to hand back a relay candidate.
     * That round trip covers DNS + the UDP allocation handshake, so it is a
     * decent proxy for "how far is this relay from the user".
     * Resolves to Infinity if the server never produces a relay candidate.
     */
    probeTurnServer(turnConfig, timeoutMs = 2500) {
        return new Promise((resolve) => {
            let pc = null;
            let timer = null;
            const start = performance.now();

            const finish = (rtt) => {
                if (!pc) return;
                clearTimeout(timer);
                try { pc.close(); } catch (e) { /* already closed */ }
                pc = null;
                resolve(rtt);
            };

            try {
                pc = new RTCPeerConnection({
                    iceServers: [turnConfig],
                    iceTransportPolicy: 'relay'
                });
            } catch (error) {
                console.warn('TURN probe could not create peer connection:', error);
                resolve(Infinity);
                return;
            }

            timer = setTimeout(() => finish(Infinity), timeoutMs);

            pc.onicecandidate = (event) => {
                if (event.candidate && event.candidate.candidate.includes('typ relay')) {
                    finish(performance.now() - start);
                } else if (!event.candidate) {
                    // Gathering finished without a relay candidate: server unusable.
                    finish(Infinity);
                }
            };

            // A data channel is enough to trigger ICE gathering without media.
            pc.createDataChannel('turn-probe');
            pc.createOffer()
                .then((offer) => pc && pc.setLocalDescription(offer))
                .catch((error) => {
                    console.warn('TURN probe offer failed:', error);
                    finish(Infinity);
                });
        });
    }

    /**
     * Probe every configured TURN server and put the closest one first, so the
     * ICE agent prefers the relay with the best path for this user's location.
     * Result is cached for the tab session; failures leave the default order.
     */
    async selectBestTurnServer() {
        if (this.turnSelectionPromise) return this.turnSelectionPromise;

        this.turnSelectionPromise = (async () => {
            const cacheKey = 'broference-turn-order';
            const fingerprint = this.turnConfigs.map(c => c.urls[0]).join('|');

            try {
                const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
                if (cached && cached.fingerprint === fingerprint) {
                    this.applyTurnOrder(cached.order);
                    console.log('Using cached TURN order:', cached.order);
                    return;
                }
            } catch (e) { /* ignore malformed cache */ }

            const timings = await Promise.all(
                this.turnConfigs.map(async (config) => ({
                    config,
                    url: config.urls[0],
                    rtt: await this.probeTurnServer(config)
                }))
            );

            const reachable = timings.filter(t => Number.isFinite(t.rtt));
            console.log('TURN probe results:', timings.map(t => `${t.url} = ${Math.round(t.rtt)}ms`).join(', '));

            if (reachable.length === 0) {
                console.warn('No TURN server answered the probe; keeping default order');
                return;
            }

            // Unreachable servers stay in the list (they may recover) but go last.
            timings.sort((a, b) => a.rtt - b.rtt);
            const order = timings.map(t => t.url);
            this.applyTurnOrder(order);

            try {
                sessionStorage.setItem(cacheKey, JSON.stringify({ fingerprint, order }));
            } catch (e) { /* storage unavailable */ }

            this.bestTurnUrl = timings[0].url;
            console.log(`Preferred TURN server: ${this.bestTurnUrl} (${Math.round(timings[0].rtt)}ms)`);
        })();

        return this.turnSelectionPromise;
    }

    /** Reorder the live ICE configs to match an ordered list of TURN urls. */
    applyTurnOrder(order) {
        const ordered = order
            .map(url => this.turnConfigs.find(c => c.urls[0] === url))
            .filter(Boolean);

        // Anything not named in the order (e.g. a server added since the cache
        // was written) is appended so it is never silently dropped.
        for (const config of this.turnConfigs) {
            if (!ordered.includes(config)) ordered.push(config);
        }

        this.iceServers.iceServers = ordered;
        this.iceServersFallback.iceServers = ordered;
        this.bestTurnUrl = ordered[0].urls[0];
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
            const savedTheme = localStorage.getItem('broference-theme') || 'tron';
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
        setIcon(btn, hidden ? 'eye-off' : 'eye');
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

        btn.innerHTML = `<span class="ic-wrap">${iconSvg(this.defconActive ? 'tv' : 'tv-off')}</span> DEFCON`;
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
                // A restart reload is already pending — reconnecting and re-joining
                // the room only to reload on top of it wastes a round trip and
                // flashes the call back up for a moment.
                if (this.awaitingRestartReload) {
                    this.updateStatus('Server restarting — reloading shortly', 'error');
                    return;
                }
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

                // A WS reconnect skips already-connected peers above, so any screen
                // channel lost during the outage has to be reopened explicitly.
                this.reconcileScreenBroadcast();

                // Someone may already be presenting when we walk in
                if (message.presenterId && message.presenterId !== this.clientId) {
                    this.handleScreenShareState(message.presenterId, message.presenterUsername);
                }

                // Show IRC status if bridged
                if (message.ircChannel) {
                    document.getElementById('ircStatus').textContent =
                        `Bridged to IRC: ${message.ircChannel}`;
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
                    this.sendMessage({ type: 'video-state', videoEnabled: this.videoEnabled });
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
                // Their screen tile carries their name too
                {
                    const screenLabel = document.querySelector(`#video-${message.clientId}-screen .video-label`);
                    if (screenLabel) screenLabel.textContent = `${message.newUsername}'s screen`;
                }
                this.addChatMessage('System', `${message.oldUsername} changed their name to ${message.newUsername}`, true);
                break;

            case 'username-assigned':
                // The server renamed us because the nick was already taken here.
                this.username = message.username;
                localStorage.setItem('broference-username', this.username);
                this.setLocalLabelName(this.username);
                this.addChatMessage(
                    'System',
                    `${message.reason}. You joined as ${message.username}.`,
                    true
                );
                break;

            case 'name-changed-by-moderator':
                // Your name was changed by moderator
                this.username = message.newUsername;
                this.setLocalLabelName(this.username);
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

            // The screen share rides the same relay as the camera mesh; `channel`
            // inside the payload is what separates the two.
            case 'offer':
                if (message.data?.channel === 'screen') {
                    await this.handleScreenOffer(message.senderId, message.data);
                } else {
                    await this.handleOffer(message.senderId, message.data);
                }
                break;

            case 'answer':
                if (message.data?.channel === 'screen') {
                    await this.handleScreenAnswer(message.senderId, message.data);
                } else {
                    await this.handleAnswer(message.senderId, message.data);
                }
                break;

            case 'ice-candidate':
                if (message.data?.channel === 'screen') {
                    await this.handleScreenIceCandidate(message.senderId, message.data, message.data.origin);
                } else {
                    await this.handleIceCandidate(message.senderId, message.data);
                }
                break;

            case 'screen-share-state':
                this.handleScreenShareState(message.presenterId, message.username);
                break;

            case 'screen-share-denied':
                this.handleScreenShareDenied(message.presenterId, message.username);
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

            case 'server-restart':
                this.showRestartWarning(message.seconds);
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
                            setIcon(mutedIndicator, 'mic-off');
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

            case 'force-mute':
                if (this.audioEnabled) {
                    this.toggleAudio();
                }
                this.addChatMessage('System', `You were muted by ${message.by}. You can unmute yourself with the mic button.`, true);
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

    // What the browser will admit about the user's hardware before permission is
    // granted. Labels stay hidden until then, but the device kinds are visible,
    // which is all we need to decide what is worth asking for.
    async probeDeviceKinds() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            return { hasMic: true, hasCam: true };
        }
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const hasMic = devices.some(d => d.kind === 'audioinput');
            const hasCam = devices.some(d => d.kind === 'videoinput');
            // An empty list means the browser is withholding devices until we ask,
            // not that the machine has none — request both and let getUserMedia judge.
            if (!hasMic && !hasCam) return { hasMic: true, hasCam: true };
            return { hasMic, hasCam };
        } catch (error) {
            console.warn('Could not enumerate devices:', error);
            return { hasMic: true, hasCam: true };
        }
    }

    describeMediaError(error) {
        switch (error && error.name) {
            case 'NotAllowedError':
            case 'PermissionDeniedError':
                return 'Camera and microphone access is blocked. Click the padlock or camera icon in your address bar, allow access, then reload.';
            case 'NotFoundError':
            case 'DevicesNotFoundError':
                return 'No microphone or camera found on this device.';
            case 'NotReadableError':
            case 'TrackStartError':
                return 'Your microphone or camera is already in use by another app.';
            case 'OverconstrainedError':
            case 'ConstraintNotSatisfiedError':
                return 'Your microphone or camera does not support the requested settings.';
            case 'SecurityError':
                return 'Media access requires a secure (HTTPS) connection.';
            default:
                return (error && error.message) || 'Could not access your microphone or camera.';
        }
    }

    mediaNoticeFor(stream, lastError) {
        const gotAudio = stream.getAudioTracks().length > 0;
        const gotVideo = stream.getVideoTracks().length > 0;
        if (gotAudio && gotVideo) return null;

        const why = lastError && (lastError.name === 'NotReadableError' || lastError.name === 'TrackStartError')
            ? 'is in use by another app'
            : 'was not found';

        if (!gotAudio && !gotVideo) return 'No microphone or camera — you will join as a listener.';
        if (!gotAudio) return `Your microphone ${why} — you can see and hear everyone, but they cannot hear you.`;
        return `Your camera ${why} — you can still talk and hear everyone.`;
    }

    // Asks for mic and camera together, then falls back to whichever one the
    // browser will actually hand over. Requesting both at once is all-or-nothing:
    // a missing or busy camera used to fail the whole call and leave someone with
    // a perfectly good mic unable to speak — or to join. Always resolves; an empty
    // stream means listen-only, never a thrown error.
    async acquireLocalMedia() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            return {
                stream: new MediaStream(),
                notice: window.isSecureContext
                    ? 'This browser does not support camera and microphone access — you can still join to listen and chat.'
                    : 'Camera and microphone need a secure connection. Open this site over https:// to use your devices.'
            };
        }

        const { hasMic, hasCam } = await this.probeDeviceKinds();
        const audio = this.getAudioConstraints();
        const video = this.getVideoConstraints();

        const attempts = [];
        if (hasMic && hasCam) attempts.push({ audio, video });
        if (hasMic) attempts.push({ audio });
        if (hasCam) attempts.push({ video });

        let lastError = null;
        for (const constraints of attempts) {
            try {
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                console.log(`Media stream acquired: ${Object.keys(constraints).join(' + ')} (${this.isMobileDevice() ? 'mobile' : 'desktop'}${this.lowBandwidthMode ? ', low-bandwidth' : ''} mode)`);
                return { stream, notice: this.mediaNoticeFor(stream, lastError) };
            } catch (error) {
                lastError = error;
                console.warn(`getUserMedia failed for ${Object.keys(constraints).join(' + ')}:`, error.name, error.message);
                // A refused prompt covers every kind — narrowing the request just
                // re-prompts for something the user has already said no to.
                if (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError') break;
            }
        }

        return {
            stream: new MediaStream(),
            notice: `${this.describeMediaError(lastError)} You can still join to listen and chat.`
        };
    }

    async getLocalStream() {
        if (!this.localStream) {
            const { stream, notice } = await this.acquireLocalMedia();
            this.localStream = stream;
            this.mediaNotice = notice;
            this.localVideo.srcObject = this.localStream;

            // Set up persistent mic audio chain (source → destination graph)
            await this.setupMicAudioChain();

            // Start monitoring for speaking indicator
            this.monitorAudioLevel(this.localStream, document.getElementById('localContainer'));

            console.log('Got local stream');
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

        // Rank the TURN servers while the user is setting up their devices, so
        // the closest relay is already picked by the time they hit Join.
        this.selectBestTurnServer();

        // Re-entering prejoin must not leave the previous stream running — the
        // device light would stay on with nothing holding the tracks.
        if (this.prejoinStream) {
            this.prejoinStream.getTracks().forEach(track => track.stop());
            this.prejoinStream = null;
        }

        // The permission prompt can sit unanswered for a long time, and a blank
        // preview with no explanation reads as a broken page.
        this.setPrejoinNotice('Requesting camera and microphone access — allow it in your browser to be seen and heard.', 'pending');

        // Held so joinRoom can wait on an unanswered prompt instead of firing a
        // second getUserMedia behind the first one.
        this.prejoinMediaPromise = this.acquireLocalMedia();
        const { stream, notice } = await this.prejoinMediaPromise;
        this.prejoinStream = stream;
        this.mediaNotice = notice;

        // Default: mic ON (when there is one), camera OFF
        this.prejoinAudioEnabled = stream.getAudioTracks().length > 0;
        this.prejoinVideoEnabled = false;
        stream.getVideoTracks().forEach(t => { t.enabled = false; });

        document.getElementById('prejoinVideo').srcObject = stream;

        this.setPrejoinNotice(notice, 'warn');
        this.syncPrejoinControls();

        const lwBtn = document.getElementById('prejoinLowBandwidthBtn');
        if (lwBtn) {
            lwBtn.classList.toggle('active', this.lowBandwidthMode);
            setIcon(lwBtn.querySelector('.icon'), this.lowBandwidthMode ? 'signal-low' : 'signal');
            lwBtn.querySelector('.btn-status').textContent = this.lowBandwidthMode ? 'ON' : 'OFF';
        }

        // Populate device selectors
        await this.updatePrejoinDeviceLists(stream);
    }

    setPrejoinNotice(text, kind = 'warn') {
        const el = document.getElementById('prejoinNotice');
        if (!el) return;
        el.textContent = text || '';
        el.classList.toggle('hidden', !text);
        el.classList.toggle('pending', kind === 'pending');
    }

    // Mic and camera buttons reflect what we actually hold a track for. Without a
    // device there is nothing to toggle, so the button says so instead of looking
    // live and doing nothing when clicked.
    syncPrejoinControls() {
        const hasAudio = !!(this.prejoinStream && this.prejoinStream.getAudioTracks().length);
        const hasVideo = !!(this.prejoinStream && this.prejoinStream.getVideoTracks().length);

        const audioBtn = document.getElementById('prejoinToggleAudioBtn');
        audioBtn.disabled = !hasAudio;
        audioBtn.classList.toggle('active', hasAudio && !this.prejoinAudioEnabled);
        setIcon(audioBtn.querySelector('.icon'), hasAudio && this.prejoinAudioEnabled ? 'mic' : 'mic-off');
        audioBtn.querySelector('.btn-status').textContent = hasAudio ? (this.prejoinAudioEnabled ? 'ON' : 'OFF') : 'NONE';

        const videoBtn = document.getElementById('prejoinToggleVideoBtn');
        videoBtn.disabled = !hasVideo;
        videoBtn.classList.toggle('active', hasVideo && !this.prejoinVideoEnabled);
        setIcon(videoBtn.querySelector('.icon'), hasVideo && this.prejoinVideoEnabled ? 'camera' : 'camera-off');
        videoBtn.querySelector('.btn-status').textContent = hasVideo ? (this.prejoinVideoEnabled ? 'ON' : 'OFF') : 'NONE';
    }

    hidePrejoinScreen() {
        // Stop prejoin stream
        if (this.prejoinStream) {
            this.prejoinStream.getTracks().forEach(track => track.stop());
            this.prejoinStream = null;
        }
        this.prejoinMediaPromise = null;
        this.mediaNotice = null;
        this.setPrejoinNotice(null);

        // Show join screen
        document.getElementById('prejoinScreen').style.display = 'none';
        document.getElementById('joinScreen').style.display = 'flex';
    }

    prejoinToggleAudio() {
        if (this.prejoinStream && this.prejoinStream.getAudioTracks().length) {
            this.prejoinAudioEnabled = !this.prejoinAudioEnabled;
            this.prejoinStream.getAudioTracks().forEach(track => {
                track.enabled = this.prejoinAudioEnabled;
            });
            this.syncPrejoinControls();
        }
    }

    prejoinToggleVideo() {
        if (this.prejoinStream && this.prejoinStream.getVideoTracks().length) {
            this.prejoinVideoEnabled = !this.prejoinVideoEnabled;
            this.prejoinStream.getVideoTracks().forEach(track => {
                track.enabled = this.prejoinVideoEnabled;
            });
            this.syncPrejoinControls();
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
            setIcon(prejoinBtn.querySelector('.icon'), this.lowBandwidthMode ? 'signal-low' : 'signal');
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
                // A recvonly transceiver has no sender track; its receiver still
                // knows the kind, and its codec preferences matter just as much.
                const kind = transceiver.sender.track?.kind || transceiver.receiver?.track?.kind;
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

            // The prejoin permission prompt may still be open. Let it settle first,
            // or we fire a second getUserMedia behind the one already showing.
            if (this.prejoinMediaPromise) {
                await this.prejoinMediaPromise;
                this.prejoinMediaPromise = null;
            }

            // Normally already resolved from the prejoin screen; cap the wait so
            // a hung probe can never hold up joining.
            await Promise.race([
                this.selectBestTurnServer(),
                new Promise(resolve => setTimeout(resolve, 1500))
            ]);

            // Connect to signaling server
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                await this.connectSignalingServer();
            }

            // Use prejoin stream if available, otherwise get new stream
            if (this.prejoinStream) {
                this.localStream = this.prejoinStream;
                // A missing device can never be "on", however the prejoin toggle
                // was left — the stream is the authority here, not the button.
                this.audioEnabled = this.prejoinAudioEnabled && this.localStream.getAudioTracks().length > 0;
                this.videoEnabled = this.prejoinVideoEnabled && this.localStream.getVideoTracks().length > 0;
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
            if (this.username) {
                this.setLocalLabelName(this.username);
            }

            // Set initial video state for local container
            const localContainer = document.getElementById('localContainer');
            localContainer.classList.toggle('no-video', !this.videoEnabled);

            // Click local tile to spotlight it
            this.sealControls(localContainer.querySelector('.video-controls'));
            localContainer.addEventListener('click', () => {
                this.toggleSpotlight('localContainer');
            });

            // Initialize video grid layout for 1 participant (local)
            this.updateVideoGridLayout();

            // Update main control buttons to match prejoin state
            const audioBtn = document.getElementById('toggleAudioBtn');
            audioBtn.classList.toggle('active', !this.audioEnabled);
            setIcon(audioBtn.querySelector('.icon'), this.audioEnabled ? 'mic' : 'mic-off');

            const videoBtn = document.getElementById('toggleVideoBtn');
            videoBtn.classList.toggle('active', !this.videoEnabled);
            setIcon(videoBtn.querySelector('.icon'), this.videoEnabled ? 'camera' : 'camera-off');

            this.syncDeviceControlAvailability();

            // Start local connection stats monitoring
            this.startLocalStatsMonitoring();

            // Auto-enable noise suppression on all devices — nothing to suppress
            // without a mic, and the audio chain has no context to hang it off.
            if (this.localStream.getAudioTracks().length > 0) {
                try { await this.toggleNoiseSuppression(); } catch (e) { console.warn('Auto noise suppression failed:', e); }
            }

            // Say once, in chat, why the mic or camera button is dead — the prejoin
            // notice is gone by now and the cause is not otherwise discoverable.
            if (this.mediaNotice) {
                this.addChatMessage('System', this.mediaNotice, true);
            }

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
        // The main connection always carries camera + mic, screen share or not —
        // a share rides its own peer connection (see createScreenPeerConnection),
        // so nothing here has to know about it.
        const activeStream = this.localStream || new MediaStream();

        const videoTrack = activeStream.getVideoTracks()[0];

        const audioTrack = this.micDestination
            // Processed audio track when noise suppression is enabled
            ? (this.micDestination.stream.getAudioTracks()[0] || activeStream.getAudioTracks()[0])
            : activeStream.getAudioTracks()[0];

        const tracksToAdd = [];
        if (audioTrack) tracksToAdd.push(audioTrack);
        if (videoTrack) tracksToAdd.push(videoTrack);

        // A kind we cannot send still needs an m-line, or our offer gives the peer
        // no slot to send us theirs and a user with no mic or camera joins deaf and
        // blind. Only the offerer needs this — an answer takes its m-lines from the
        // offer. The two calls straddle the track loop to keep audio before video.
        if (createOffer && !audioTrack) pc.addTransceiver('audio', { direction: 'recvonly' });

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

            // Camera bitrate: the normal mesh cap, or the reduced share cap if we
            // are presenting (the screen PC needs the headroom more than the webcam).
            if (track.kind === 'video' && sender.getParameters) {
                const parameters = sender.getParameters();
                if (parameters.encodings && parameters.encodings.length > 0) {
                    parameters.encodings[0].maxBitrate = this.isScreenSharing
                        ? this.cameraBitrateDuringShare()
                        : (this.lowBandwidthMode ? 200000 : 1500000);
                    if (this.isScreenSharing) parameters.encodings[0].scaleResolutionDownBy = 2;
                    sender.setParameters(parameters).catch(err => {
                        console.warn('Could not set video encoding parameters:', err);
                    });
                }
            }
        });

        if (createOffer && !videoTrack) pc.addTransceiver('video', { direction: 'recvonly' });

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
                // A peer with no mic or camera sends nothing, so ontrack never fires
                // and nothing would ever put them in the grid. Give them an avatar
                // tile so they are visible — and moderatable — like everyone else.
                // streamAdded stays false on purpose: if a track does turn up later,
                // ontrack rebuilds this tile properly around the real stream.
                if (!document.getElementById(`video-${peerId}`)) {
                    this.addRemoteVideo(peerId, this.knownUsernames.get(peerId) || peerUsername, new MediaStream());
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

        // If we are presenting, open the screen channel to this peer too. Covers
        // both callers — room-joined and handleOffer — so a late joiner sees the
        // share without any extra signaling. Not awaited: the screen handshake
        // must not delay the camera connection.
        if (this.isScreenSharing && this.screenStream) {
            this.createScreenPeerConnection(peerId, peerUsername).catch(err => {
                console.warn('Could not open screen channel to', peerId, err);
            });
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
        this.sealControls(audioControls);
        container.addEventListener('click', () => {
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
                            setIcon(muteBtn, 'volume');
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
        setIcon(muteBtn, 'volume');
        muteBtn.title = 'Mute/Unmute';
        muteBtn.onclick = () => this.toggleRemoteMute(peerId, muteBtn);

        // Hide video button
        const hideVideoBtn = document.createElement('button');
        setIcon(hideVideoBtn, 'eye');
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
                setIcon(promoteBtn, 'crown');
                promoteBtn.title = 'Transfer ownership';
                promoteBtn.dataset.modControl = 'promote';
                promoteBtn.onclick = () => this.promoteToModerator(peerId);
                audioControls.appendChild(promoteBtn);
            }

            // Owner: add/remove co-mod button
            if (this.isOwner) {
                if (targetIsCoMod) {
                    const demoteBtn = document.createElement('button');
                    setIcon(demoteBtn, 'shield');
                    demoteBtn.title = 'Remove co-moderator';
                    demoteBtn.dataset.modControl = 'demote-comod';
                    demoteBtn.onclick = () => this.removeCoMod(peerId);
                    audioControls.appendChild(demoteBtn);
                } else {
                    const coModBtn = document.createElement('button');
                    setIcon(coModBtn, 'shield');
                    coModBtn.title = 'Add as co-moderator';
                    coModBtn.dataset.modControl = 'add-comod';
                    coModBtn.onclick = () => this.addCoMod(peerId);
                    audioControls.appendChild(coModBtn);
                }
            }

            const renameBtn = document.createElement('button');
            setIcon(renameBtn, 'pencil');
            renameBtn.title = 'Change user name';
            renameBtn.dataset.modControl = 'rename';
            renameBtn.onclick = () => this.moderatorChangeName(peerId);

            const kickBtn = document.createElement('button');
            setIcon(kickBtn, 'user-minus');
            kickBtn.title = 'Kick user';
            kickBtn.dataset.modControl = 'kick';
            kickBtn.onclick = () => this.kickUser(peerId);

            const muteBtn = document.createElement('button');
            setIcon(muteBtn, 'mic-off');
            muteBtn.title = 'Mute user';
            muteBtn.dataset.modControl = 'mute';
            muteBtn.onclick = () => this.muteUser(peerId);

            audioControls.appendChild(muteBtn);
            audioControls.appendChild(renameBtn);
            audioControls.appendChild(kickBtn);

            // Ban button: owner only
            if (this.isOwner) {
                const banBtn = document.createElement('button');
                setIcon(banBtn, 'ban');
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
            btn.innerHTML = `<span class="ic-wrap">${iconSvg('lock')}</span> Locked`;
            btn.classList.add('active');
        } else {
            btn.innerHTML = `<span class="ic-wrap">${iconSvg('unlock')}</span> Lock Room`;
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

    muteUser(targetId) {
        if (!this.isModerator) {
            alert('Only moderator can mute users');
            return;
        }

        this.sendMessage({
            type: 'mute-user',
            targetId: targetId
        });
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

    // Apply or update the badge (crown/shield/none) on a video label.
    // Pass an existing label element to update in-place, omit to find it by
    // peerId, or pass peerId 'local' for your own tile.
    applyLabelBadge(peerId, username, role, labelEl) {
        const selector = peerId === 'local'
            ? '#localContainer .video-label'
            : `#video-${peerId} .video-label`;
        const label = labelEl || document.querySelector(selector);
        if (!label) return;
        label.innerHTML = '';
        if (role === 'owner') {
            const span = document.createElement('span');
            span.className = 'mod-crown';
            setIcon(span, 'crown');
            label.appendChild(span);
            label.appendChild(document.createTextNode(' ' + username));
        } else if (role === 'co-mod') {
            const span = document.createElement('span');
            span.className = 'mod-badge';
            setIcon(span, 'shield');
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
            setIcon(button, 'volume-off');
            button.classList.add('muted');
        } else {
            setIcon(button, 'volume');
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
        overlay.innerHTML = `<span class="ic-wrap">${iconSvg('play')}</span> Tap to play`;
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
        overlay.innerHTML = `<span class="ic-wrap">${iconSvg('volume-off')}</span> Tap to unmute`;
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
                setIcon(controls, 'volume');
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

        // Tear down both directions of the screen channel with this peer
        this.removeScreenPeerConnection(peerId);
        this.removeScreenReceiver(peerId);

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

        this.updateVideoGridLayout();
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
                console.warn('TURN relay failed for peer', peerId, '- reconnecting with fresh relay-only config');
                this.reconnectWithFallback(peerId);
            } else {
                console.warn('ICE restart limit reached for peer', peerId, '(already on relay-only fallback) - giving up');
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
        console.log('Reconnecting to', peerId, 'with fresh relay-only ICE config');

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

    // While presenting, the camera gives up most of its budget to the screen —
    // both streams share one uplink and the screen is what people are looking at.
    cameraBitrateDuringShare() {
        return this.lowBandwidthMode ? 120000 : 400000;
    }

    // The screen cap scales down as the mesh grows: every peer costs another full
    // copy of the stream, all of it relayed through TURN.
    screenBitrateForMesh() {
        if (this.lowBandwidthMode) return 800000;
        return this.peerConnections.size > 4 ? 2500000 : 4000000;
    }

    throttleCameraForShare() {
        this.peerConnections.forEach(peer => {
            const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!sender || !sender.getParameters) return;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) return;
                params.degradationPreference = 'balanced';
                params.encodings[0].maxBitrate = this.cameraBitrateDuringShare();
                params.encodings[0].scaleResolutionDownBy = 2;
                sender.setParameters(params).catch(err => {
                    console.warn('Could not throttle camera for share:', err);
                });
            } catch (err) {
                console.warn('Error throttling camera for share:', err);
            }
        });
    }

    unthrottleCameraAfterShare() {
        this.peerConnections.forEach(peer => {
            const sender = peer.connection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!sender || !sender.getParameters) return;
            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) return;
                delete params.encodings[0].scaleResolutionDownBy;
                sender.setParameters(params).catch(() => {});
            } catch (err) {
                console.warn('Error restoring camera resolution:', err);
            }
            this.restoreCameraEncoding(sender);
        });
    }

    async toggleScreenShare() {
        if (!this.isScreenSharing) {
            if (this.currentPresenterId && this.currentPresenterId !== this.clientId) {
                const name = this.knownUsernames.get(this.currentPresenterId) || 'Someone else';
                this.addChatMessage('System', `${name} is already sharing their screen.`, true);
                return;
            }
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

                const screenVideoTrack = this.screenStream.getVideoTracks()[0];
                // Screen content is high-detail / low-motion: hint the encoder so it
                // keeps resolution sharp instead of collapsing frame rate.
                screenVideoTrack.contentHint = 'detail';

                // Handle stream end (user clicks "Stop sharing" in browser UI)
                screenVideoTrack.onended = () => {
                    this.toggleScreenShare();
                };

                this.isScreenSharing = true;
                document.getElementById('shareScreenBtn').classList.add('active');

                // Claim the presenter slot and wait for the server to grant it before
                // pushing anything to peers. Broadcasting optimistically put a tile on
                // every viewer's grid that a later denial could not clear — the denial
                // goes only to us, so the losing sharer's now-dead tracks sat there as
                // a black rectangle until ICE eventually timed the connection out.
                // startScreenBroadcast() runs from handleScreenShareState() instead.
                this.sendMessage({ type: 'screen-share-start' });

                console.log('Screen sharing started');

            } catch (error) {
                console.error('Error sharing screen:', error);
                if (error && error.name !== 'NotAllowedError') {
                    alert('Could not start screen sharing. Please try again.');
                }
            }
        } else {
            this.stopScreenBroadcast();
            this.unthrottleCameraAfterShare();

            if (this.screenStream) {
                this.screenStream.getTracks().forEach(track => track.stop());
                this.screenStream = null;
            }

            this.isScreenSharing = false;
            document.getElementById('shareScreenBtn').classList.remove('active');
            this.sendMessage({ type: 'screen-share-stop' });

            console.log('Screen sharing stopped');
        }
    }

    // --- Screen share channel ---

    // Open a send-only connection carrying the screen to one peer. We always
    // offer here; the viewer only ever answers.
    async createScreenPeerConnection(peerId, peerUsername) {
        if (!this.screenStream) return;
        this.removeScreenPeerConnection(peerId);

        const pc = new RTCPeerConnection(this.iceServers);
        const entry = { connection: pc, username: peerUsername, retryCount: 0 };
        this.screenPeerConnections.set(peerId, entry);

        const videoTrack = this.screenStream.getVideoTracks()[0];
        const audioTrack = this.screenStream.getAudioTracks()[0];

        if (videoTrack) {
            const tr = pc.addTransceiver(videoTrack, {
                direction: 'sendonly',
                streams: [this.screenStream]
            });
            this.applyScreenShareEncoding(tr.sender);
        }
        if (audioTrack) {
            pc.addTransceiver(audioTrack, {
                direction: 'sendonly',
                streams: [this.screenStream]
            });
        }

        this.setPreferredCodecs(pc);

        if (this.e2eeEnabled && this.e2eeWorker) {
            pc.getSenders().forEach(sender => {
                if (!sender.track) return;
                try {
                    sender.transform = new RTCRtpScriptTransform(
                        this.e2eeWorker, { operation: 'encrypt', kind: sender.track.kind });
                } catch (e) { console.warn('Could not set screen sender transform:', e); }
            });
        }

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendScreenIceCandidate(peerId, event.candidate, 'sharer');
            }
        };

        // Deliberately minimal recovery. The main-mesh helpers (attemptIceRestart,
        // reconnectWithFallback, turnFailedPeers) all read this.peerConnections and
        // would corrupt camera state if called with a screen peer id.
        pc.onconnectionstatechange = () => {
            if (pc.connectionState !== 'failed') return;
            const current = this.screenPeerConnections.get(peerId);
            if (!current || current.connection !== pc) return;
            if (current.retryCount >= 1) {
                console.warn('Screen channel to', peerId, 'failed; giving up');
                this.removeScreenPeerConnection(peerId);
                return;
            }
            const retryCount = current.retryCount + 1;
            console.warn('Screen channel to', peerId, 'failed; retrying once');
            this.createScreenPeerConnection(peerId, peerUsername).then(() => {
                const next = this.screenPeerConnections.get(peerId);
                if (next) next.retryCount = retryCount;
            }).catch(() => {});
        };

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendMessage({
                type: 'offer',
                targetId: peerId,
                data: { type: offer.type, sdp: offer.sdp, channel: 'screen', origin: 'sharer' }
            });
        } catch (error) {
            console.error('Error creating screen offer for', peerId, error);
        }
    }

    async handleScreenOffer(senderId, offer) {
        // A re-offer means the sharer restarted the channel — drop the old one.
        this.removeScreenReceiver(senderId, { keepTile: true });

        const username = this.peerConnections.get(senderId)?.username
            || this.knownUsernames.get(senderId)
            || 'User';

        const pc = new RTCPeerConnection(this.iceServers);
        this.screenReceivers.set(senderId, { connection: pc, username });

        let tileAdded = false;
        pc.ontrack = (event) => {
            const stream = (event.streams && event.streams.length > 0)
                ? event.streams[0]
                : new MediaStream([event.track]);

            if (!tileAdded) {
                tileAdded = true;
                this.addScreenTile(senderId, username, stream);
            } else {
                const videoEl = document.querySelector(`#video-${senderId}-screen video`);
                if (videoEl && videoEl.srcObject !== stream) videoEl.srcObject = stream;
            }

            if (this.e2eeEnabled && this.e2eeWorker) {
                try {
                    event.receiver.transform = new RTCRtpScriptTransform(
                        this.e2eeWorker, { operation: 'decrypt', kind: event.track.kind });
                } catch (e) { console.warn('Could not set screen receiver transform:', e); }
            }
        };

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.sendScreenIceCandidate(senderId, event.candidate, 'viewer');
            }
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                const current = this.screenReceivers.get(senderId);
                if (current && current.connection === pc) this.removeScreenReceiver(senderId);
            }
        };

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: offer.type, sdp: offer.sdp }));
            await this.drainScreenIce(senderId, 'sharer', pc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendMessage({
                type: 'answer',
                targetId: senderId,
                data: { type: answer.type, sdp: answer.sdp, channel: 'screen', origin: 'viewer' }
            });
        } catch (error) {
            console.error('Error handling screen offer from', senderId, error);
            this.removeScreenReceiver(senderId);
        }
    }

    async handleScreenAnswer(senderId, answer) {
        const entry = this.screenPeerConnections.get(senderId);
        if (!entry) return;

        const pc = entry.connection;
        if (pc.signalingState !== 'have-local-offer') {
            console.warn('Dropping stale screen answer from', senderId, '- signalingState:', pc.signalingState);
            return;
        }

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: answer.type, sdp: answer.sdp }));
            await this.drainScreenIce(senderId, 'viewer', pc);
        } catch (error) {
            console.error('Error handling screen answer from', senderId, error);
        }
    }

    // `origin` is who sent the candidate, so it selects which of our two screen
    // maps it belongs to. Without it, two people sharing at once would cross wires.
    async handleScreenIceCandidate(senderId, candidate, origin) {
        const entry = origin === 'sharer'
            ? this.screenReceivers.get(senderId)
            : this.screenPeerConnections.get(senderId);

        const pc = entry && entry.connection;

        // ws.onmessage is async and the browser does not serialize invocations, so
        // a candidate can land while the offer is still being processed.
        if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
            this.queueScreenIce(senderId, origin, candidate);
            return;
        }

        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error adding screen ICE candidate for', senderId, error);
        }
    }

    sendScreenIceCandidate(peerId, candidate, origin) {
        // Strip raddr/rport from relay candidates — they leak the real public IP
        // even in relay-only mode.
        let payload = candidate.toJSON ? candidate.toJSON() : candidate;
        if (payload.candidate && payload.candidate.includes('typ relay')) {
            payload = {
                ...payload,
                candidate: payload.candidate.replace(/\s+raddr\s+\S+\s+rport\s+\d+/g, '')
            };
        }
        this.sendMessage({
            type: 'ice-candidate',
            targetId: peerId,
            data: { ...payload, channel: 'screen', origin }
        });
    }

    queueScreenIce(peerId, origin, candidate) {
        const key = `${peerId}:${origin}`;
        if (!this.screenPendingIce.has(key)) this.screenPendingIce.set(key, []);
        this.screenPendingIce.get(key).push(candidate);
    }

    async drainScreenIce(peerId, origin, pc) {
        const key = `${peerId}:${origin}`;
        const queued = this.screenPendingIce.get(key);
        if (!queued) return;
        for (const candidate of queued) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (err) {
                console.error('Error adding queued screen ICE candidate:', err);
            }
        }
        this.screenPendingIce.delete(key);
    }

    startScreenBroadcast() {
        this.peerConnections.forEach((peer, peerId) => {
            this.createScreenPeerConnection(peerId, peer.username).catch(err => {
                console.warn('Could not open screen channel to', peerId, err);
            });
        });
        this.addScreenTile('local', this.localLabelName || this.username, this.screenStream, true);
    }

    stopScreenBroadcast() {
        this.screenBroadcasting = false;
        this.screenPeerConnections.forEach(peer => peer.connection.close());
        this.screenPeerConnections.clear();
        for (const key of [...this.screenPendingIce.keys()]) {
            if (key.endsWith(':viewer')) this.screenPendingIce.delete(key);
        }
        this.removeScreenTile('local');
    }

    // A screen gets a tile of its own, like a second participant. Deliberately
    // leaner than addRemoteVideo: no avatar, no stats monitor, no speaking
    // indicator — those are all keyed by bare peerId and would collide.
    addScreenTile(ownerId, username, stream, isLocal = false) {
        const id = `video-${ownerId}-screen`;
        const existing = document.getElementById(id);
        if (existing) existing.remove();

        const container = document.createElement('div');
        container.className = 'video-container screen-tile';
        container.id = id;

        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        // Start muted even for remote screens: Chrome blocks autoplay of a stream
        // with audio, which would leave the tile frozen on a black frame. We
        // unmute below once playback is actually running. Our own capture stays
        // muted for good — playing it back would echo.
        video.muted = true;
        video.srcObject = stream;

        const labelEl = document.createElement('div');
        labelEl.className = 'video-label';
        labelEl.textContent = `${username}'s screen`;

        container.appendChild(video);
        if (!isLocal) {
            const screenControls = this.createScreenAudioControls(ownerId, video);
            container.appendChild(screenControls);
            this.sealControls(screenControls);
        }
        container.appendChild(labelEl);

        container.style.cursor = 'pointer';
        container.addEventListener('click', () => {
            this.toggleSpotlight(id);
        });

        this.videoGrid.appendChild(container);
        this.updateVideoGridLayout();

        video.play().then(() => {
            // Playback is live, so unmuting no longer trips the autoplay policy.
            if (!isLocal) video.muted = false;
        }).catch(() => {
            if (isLocal) return;
            // Autoplay refused outright — the user has to click once.
            this.addPlayButtonOverlay(container, video, `${username}'s screen`);
        });
    }

    // Desktop audio arrives on the screen connection, so it gets its own volume
    // and mute — muting someone's screen no longer mutes their voice.
    createScreenAudioControls(ownerId, videoEl) {
        const key = `${ownerId}:screen`;
        const controlsDiv = document.createElement('div');
        controlsDiv.className = 'remote-audio-controls';

        const muteBtn = document.createElement('button');
        muteBtn.title = 'Mute/Unmute screen audio';
        setIcon(muteBtn, 'volume');
        muteBtn.onclick = () => {
            const controls = this.remoteAudioControls.get(key);
            if (!controls) return;
            controls.isMuted = !controls.isMuted;
            videoEl.muted = controls.isMuted;
            setIcon(muteBtn, controls.isMuted ? 'volume-off' : 'volume');
            muteBtn.classList.toggle('muted', controls.isMuted);
        };

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.min = '0';
        volumeSlider.max = '100';
        volumeSlider.value = '100';
        volumeSlider.title = 'Screen volume';
        volumeSlider.oninput = (e) => { videoEl.volume = e.target.value / 100; };

        this.remoteAudioControls.set(key, { videoElement: videoEl, isMuted: false });

        controlsDiv.appendChild(muteBtn);
        controlsDiv.appendChild(volumeSlider);
        return controlsDiv;
    }

    removeScreenTile(ownerId) {
        const container = document.getElementById(`video-${ownerId}-screen`);
        if (container) container.remove();
        this.remoteAudioControls.delete(`${ownerId}:screen`);
        this.updateVideoGridLayout();
    }

    removeScreenPeerConnection(peerId) {
        const entry = this.screenPeerConnections.get(peerId);
        if (entry) {
            entry.connection.close();
            this.screenPeerConnections.delete(peerId);
        }
        this.screenPendingIce.delete(`${peerId}:viewer`);
    }

    removeScreenReceiver(peerId, { keepTile = false } = {}) {
        const entry = this.screenReceivers.get(peerId);
        if (entry) {
            entry.connection.close();
            this.screenReceivers.delete(peerId);
        }
        this.screenPendingIce.delete(`${peerId}:sharer`);
        if (!keepTile) this.removeScreenTile(peerId);
    }

    // Reopen screen channels to peers we lost track of — e.g. after a WS
    // reconnect, where room-joined skips peers that are still connected.
    reconcileScreenBroadcast() {
        if (!this.isScreenSharing || !this.screenStream) return;
        this.peerConnections.forEach((peer, peerId) => {
            if (this.screenPeerConnections.has(peerId)) return;
            this.createScreenPeerConnection(peerId, peer.username).catch(() => {});
        });
    }

    handleScreenShareState(presenterId, username) {
        this.currentPresenterId = presenterId || null;
        if (username && presenterId) this.knownUsernames.set(presenterId, username);

        // Drop every screen tile that isn't the current presenter's, rather than
        // waiting for the connection to time out. Covers the presenter stopping
        // (nobody is presenter, so all tiles go) and a second sharer whose claim
        // was denied after their offer had already reached us.
        this.screenReceivers.forEach((_, peerId) => {
            if (peerId !== presenterId) this.removeScreenReceiver(peerId);
        });

        // Our claim was granted — only now is it safe to offer the screen to peers.
        if (presenterId && presenterId === this.clientId && this.isScreenSharing && !this.screenBroadcasting) {
            this.screenBroadcasting = true;
            this.startScreenBroadcast();
            this.throttleCameraForShare();
        }

        const btn = document.getElementById('shareScreenBtn');
        if (btn) {
            const lockedOut = !!presenterId && presenterId !== this.clientId;
            btn.disabled = lockedOut;
            btn.classList.toggle('locked', lockedOut);
            btn.title = lockedOut ? `${username || 'Someone'} is sharing their screen` : 'Share Screen';
        }
    }

    // The server refused our claim — another presenter got there first.
    handleScreenShareDenied(presenterId, username) {
        if (!this.isScreenSharing) return;
        console.warn('Screen share denied; presenter is', username);
        this.stopScreenBroadcast();
        this.unthrottleCameraAfterShare();
        if (this.screenStream) {
            this.screenStream.getTracks().forEach(track => track.stop());
            this.screenStream = null;
        }
        this.isScreenSharing = false;
        document.getElementById('shareScreenBtn').classList.remove('active');
        this.handleScreenShareState(presenterId, username);
        this.addChatMessage('System', `${username || 'Someone else'} is already sharing their screen.`, true);
    }

    hasLocalTrack(kind) {
        if (!this.localStream) return false;
        return (kind === 'audio' ? this.localStream.getAudioTracks() : this.localStream.getVideoTracks()).length > 0;
    }

    // Greys out the mic/camera buttons we have no device for, so a listener can
    // see at a glance why they cannot unmute rather than clicking a live-looking
    // button that does nothing.
    syncDeviceControlAvailability() {
        const audioBtn = document.getElementById('toggleAudioBtn');
        if (audioBtn) {
            const hasMic = this.hasLocalTrack('audio');
            audioBtn.disabled = !hasMic;
            audioBtn.title = hasMic ? 'Toggle microphone' : 'No microphone available';
        }
        const videoBtn = document.getElementById('toggleVideoBtn');
        if (videoBtn) {
            const hasCam = this.hasLocalTrack('video');
            videoBtn.disabled = !hasCam;
            videoBtn.title = hasCam ? 'Toggle camera' : 'No camera available';
        }
    }

    toggleAudio() {
        if (!this.hasLocalTrack('audio')) {
            this.addChatMessage('System', this.mediaNotice || 'No microphone available — others cannot hear you.', true);
            return;
        }

        this.audioEnabled = !this.audioEnabled;
        this.localStream.getAudioTracks().forEach(track => {
            track.enabled = this.audioEnabled;
        });

        const btn = document.getElementById('toggleAudioBtn');
        btn.classList.toggle('active', !this.audioEnabled);
        setIcon(btn.querySelector('.icon'), this.audioEnabled ? 'mic' : 'mic-off');

        // Notify other users of audio state change
        this.sendMessage({
            type: 'audio-state',
            audioEnabled: this.audioEnabled
        });
    }

    toggleVideo() {
        // Without a camera track there is nothing to turn on, and announcing
        // video-state: true would put a live tile in front of everyone else.
        if (!this.hasLocalTrack('video')) {
            this.addChatMessage('System', this.mediaNotice || 'No camera available — others cannot see you.', true);
            return;
        }

        this.videoEnabled = !this.videoEnabled;

        this.localStream.getVideoTracks().forEach(track => {
            track.enabled = this.videoEnabled;
        });

        const btn = document.getElementById('toggleVideoBtn');
        btn.classList.toggle('active', !this.videoEnabled);
        setIcon(btn.querySelector('.icon'), this.videoEnabled ? 'camera' : 'camera-off');

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
                // setupMicAudioChain builds nothing without a mic track — there is
                // no source to gate, so leave the toggle off rather than throwing.
                if (!this.micAudioCtx || !this.micSource || !this.micDestination) {
                    console.warn('Noise suppression unavailable: no microphone track');
                    return;
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

                console.log('Noise suppression enabled');

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

                console.log('Noise suppression disabled');

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

    // An empty <select> looks like a loading bug. When there is nothing to list,
    // say so in a disabled placeholder instead of leaving the control blank.
    fillDeviceSelect(select, devices, currentDeviceId, noun) {
        select.innerHTML = '';

        if (devices.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = `No ${noun.toLowerCase()} detected`;
            select.appendChild(option);
            select.disabled = true;
            return;
        }

        select.disabled = false;
        devices.forEach((device, i) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.textContent = device.label || `${noun} ${i + 1}`;
            if (device.deviceId === currentDeviceId) option.selected = true;
            select.appendChild(option);
        });
    }

    async updateDeviceSelect(selectId, kind, noun) {
        const select = document.getElementById(selectId);
        if (!select || !navigator.mediaDevices?.enumerateDevices) return;

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const inputs = devices.filter(d => d.kind === kind);
            const track = kind === 'audioinput'
                ? this.localStream?.getAudioTracks()[0]
                : this.localStream?.getVideoTracks()[0];
            this.fillDeviceSelect(select, inputs, track ? track.getSettings().deviceId : null, noun);
        } catch (error) {
            console.warn(`Could not enumerate ${noun.toLowerCase()} devices:`, error);
        }
    }

    async updateMicDeviceList() {
        await this.updateDeviceSelect('micDeviceSelect', 'audioinput', 'Microphone');
    }

    async updateMicDeviceListOptions() {
        await this.updateDeviceSelect('micDeviceSelectOptions', 'audioinput', 'Microphone');
    }

    async updateCameraDeviceList() {
        await this.updateDeviceSelect('cameraDeviceSelect', 'videoinput', 'Camera');
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

            // A camera we did not have when we joined has no sender to swap into:
            // that m-line was negotiated receive-only and this mesh has no
            // renegotiation path. Better to say so than to show a local preview
            // that nobody else is receiving.
            if (!oldVideoTrack && this.peerConnections.size > 0) {
                this.addChatMessage('System', 'Camera connected. Rejoin the room for others to see it.', true);
            }
            this.syncDeviceControlAvailability();

            localStorage.setItem('broference-preferred-camera', deviceId);
            console.log('Switched camera to:', newVideoTrack.label);
        } catch (error) {
            console.error('Error switching camera:', error);
        }
    }

    async updatePrejoinDeviceLists(stream) {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const audioInputs = devices.filter(d => d.kind === 'audioinput');
            const videoInputs = devices.filter(d => d.kind === 'videoinput');

            const currentMicId = stream?.getAudioTracks()[0]?.getSettings().deviceId;
            const currentCamId = stream?.getVideoTracks()[0]?.getSettings().deviceId;

            this.fillDeviceSelect(document.getElementById('prejoinMicSelect'), audioInputs, currentMicId, 'Microphone');
            this.fillDeviceSelect(document.getElementById('prejoinCameraSelect'), videoInputs, currentCamId, 'Camera');
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
            const hadTrack = oldTracks.length > 0;
            oldTracks.forEach(t => { t.stop(); this.prejoinStream.removeTrack(t); });
            this.prejoinStream.addTrack(newTrack);

            // Preserve the toggle across a swap, but a mic that only just became
            // available starts on — its "off" was the absence of a device, not a choice.
            if (kind === 'audio') {
                if (!hadTrack) this.prejoinAudioEnabled = true;
                newTrack.enabled = this.prejoinAudioEnabled;
            } else {
                newTrack.enabled = this.prejoinVideoEnabled;
            }

            document.getElementById('prejoinVideo').srcObject = this.prejoinStream;

            // Picking a device we previously had none of makes that button live again.
            this.mediaNotice = this.mediaNoticeFor(this.prejoinStream, null);
            this.setPrejoinNotice(this.mediaNotice);
            this.syncPrejoinControls();
        } catch (error) {
            console.error(`Error switching prejoin ${kind} device:`, error);
            this.setPrejoinNotice(this.describeMediaError(error));
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
            // A mic that only just became available starts unmuted — the mute was
            // the absence of a device, not the user's choice.
            if (!oldAudioTrack) {
                this.audioEnabled = true;
                const audioBtn = document.getElementById('toggleAudioBtn');
                audioBtn.classList.remove('active');
                setIcon(audioBtn.querySelector('.icon'), 'mic');
            }

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

            // Same receive-only limitation as switchCamera — no sender exists for a
            // mic we did not have at join time.
            if (!oldAudioTrack && this.peerConnections.size > 0) {
                this.addChatMessage('System', 'Microphone connected. Rejoin the room for others to hear you.', true);
            }
            this.syncDeviceControlAvailability();

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
                btn.innerHTML = `<span class="ic-wrap">${iconSvg('arrow-up')}</span> Load older messages`;
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
            setIcon(badge, 'key');
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

        // Whatever was spotlit may have just been removed — a screen share that
        // stopped, a peer that left. Spotlight mode hides every other tile, so
        // without this you're left in an empty black room with audio and no tile
        // to click your way out of.
        if (this.videoGrid.classList.contains('spotlight-mode') &&
            !this.videoGrid.querySelector('.spotlight-active')) {
            this.exitSpotlight();
        }
    }

    // Drop spotlight mode and put every tile back in the grid.
    exitSpotlight() {
        this.videoGrid.classList.remove('spotlight-mode');
        this.videoGrid.querySelectorAll('.video-container').forEach(c => {
            c.classList.remove('spotlight-active', 'spotlight-hidden');
        });
    }

    // The deploy script signals the server before it takes the containers down.
    // Counts down in place so people can wrap up instead of being cut off mid-call.
    showRestartWarning(seconds) {
        const banner = document.getElementById('restartWarning');
        const countdown = document.getElementById('restartCountdown');
        if (!banner || !countdown) return;

        let remaining = Math.max(0, parseInt(seconds, 10) || 60);
        clearInterval(this.restartCountdownInterval);
        banner.classList.remove('hidden');
        hydrateIcons(banner);

        const render = () => {
            countdown.textContent = remaining > 0 ? `in ${remaining}s` : 'now';
            if (remaining <= 0) {
                clearInterval(this.restartCountdownInterval);
                this.restartCountdownInterval = null;
                this.reloadWhenServerReturns();
            }
            remaining -= 1;
        };

        render();
        this.restartCountdownInterval = setInterval(render, 1000);
        this.addChatMessage('System', `Server restarting in ${seconds}s — your call will drop and this page will reload itself once it is back.`, true);
    }

    // The countdown ends with the containers going down, so reloading on the spot
    // would just land on a dead server — and the rebuild that follows can take a
    // couple of minutes. Poll the origin instead and reload the moment it answers,
    // which is also the point at which the new cache-busted assets exist.
    async reloadWhenServerReturns() {
        if (this.awaitingRestartReload) return;
        this.awaitingRestartReload = true;

        const banner = document.getElementById('restartWarning');
        const countdown = document.getElementById('restartCountdown');
        const sub = banner && banner.querySelector('.restart-sub');
        if (countdown) countdown.textContent = 'now';
        if (sub) sub.textContent = '— reloading as soon as the server is back';

        const POLL_MS = 3000;
        const deadline = Date.now() + 10 * 60 * 1000;

        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, POLL_MS));
            try {
                // Cache-busted so a stale 200 from the HTTP cache can't pass for
                // the server being up again.
                const response = await fetch(`${window.location.pathname}?restartping=${Date.now()}`, {
                    method: 'HEAD',
                    cache: 'no-store'
                });
                if (response.ok) {
                    window.location.reload();
                    return;
                }
            } catch (_error) {
                // Still down — keep waiting.
            }
        }

        // Ten minutes without an answer means something is wrong with the deploy.
        // Reloading into an error page would only hide that, so hand it back to
        // the user instead.
        this.awaitingRestartReload = false;
        if (sub) sub.textContent = '— server did not come back; reload manually';
        this.addChatMessage('System', 'The server has not come back after 10 minutes. Reload the page to try again.', true);
    }

    // Keep a tile's control cluster from spotlighting the tile underneath it.
    // The closest('.controls') guards on the tile handlers aren't enough: an icon
    // button swaps its own <svg> when clicked, so by the time the click bubbles up
    // the original e.target is detached and closest() walks up to nothing. Stopping
    // the click at the controls element doesn't depend on the target surviving.
    sealControls(el) {
        if (el) el.addEventListener('click', (e) => e.stopPropagation());
    }

    toggleSpotlight(containerId) {
        const grid = this.videoGrid;
        const target = document.getElementById(containerId);
        if (!target) return;

        const alreadySpotlit = grid.classList.contains('spotlight-mode') &&
            target.classList.contains('spotlight-active');

        if (alreadySpotlit) {
            // Click same tile again → exit spotlight
            this.exitSpotlight();
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

    changeName() {
        const newName = prompt('Enter your new name:', this.username);
        if (newName && newName.trim() && newName !== this.username) {
            const oldName = this.username;
            this.username = newName.trim();
            localStorage.setItem('broference-username', this.username);

            // Update local video label and avatar (keeps the role badge)
            this.setLocalLabelName(this.username);

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

        // Close both directions of the screen channel and drop every screen tile
        this.screenPeerConnections.forEach(peer => peer.connection.close());
        this.screenPeerConnections.clear();
        this.screenReceivers.forEach(peer => peer.connection.close());
        this.screenReceivers.clear();
        this.screenPendingIce.clear();
        this.currentPresenterId = null;
        document.querySelectorAll('.screen-tile').forEach(el => el.remove());

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
        const shareBtn = document.getElementById('shareScreenBtn');
        shareBtn.classList.remove('active', 'locked');
        shareBtn.disabled = false;
        shareBtn.title = 'Share Screen';
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
