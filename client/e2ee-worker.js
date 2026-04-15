// E2EE Worker — encrypts outbound and decrypts inbound encoded media frames.
// Frame format: [12 bytes IV][AES-GCM ciphertext]

let cryptoKey = null;

self.onmessage = async (event) => {
    if (event.data.type !== 'set-key') return;
    cryptoKey = await crypto.subtle.importKey(
        'raw', event.data.rawKey,
        { name: 'AES-GCM', length: 256 },
        false, ['encrypt', 'decrypt']
    );
};

self.onrtctransform = (event) => {
    const { operation } = event.transformer.options;
    // Flips to true on the first successful decryption.  Until then, frames that
    // fail decryption are passed through so the decoder sees valid unencrypted
    // video during the window before the remote peer has received the room key.
    // Once the peer starts encrypting (first successful decrypt), strict mode
    // kicks in and subsequent failures are dropped (e.g. during key rotation).
    let peerIsEncrypting = false;

    const transform = new TransformStream({
        async transform(frame, controller) {
            if (!cryptoKey) {
                // No key yet:
                // - Encrypt: pass through (outbound frames still flow unencrypted)
                // - Decrypt: drop — we know existing peers ARE encrypting; passing
                //   their ciphertext to the decoder would corrupt its internal state
                if (operation === 'encrypt') controller.enqueue(frame);
                return;
            }
            try {
                if (operation === 'encrypt') {
                    const iv = crypto.getRandomValues(new Uint8Array(12));
                    const encrypted = await crypto.subtle.encrypt(
                        { name: 'AES-GCM', iv }, cryptoKey, frame.data);
                    const out = new Uint8Array(12 + encrypted.byteLength);
                    out.set(iv, 0);
                    out.set(new Uint8Array(encrypted), 12);
                    frame.data = out.buffer;
                    controller.enqueue(frame);
                } else {
                    const bytes = new Uint8Array(frame.data);
                    if (bytes.length < 13) { controller.enqueue(frame); return; }
                    const decrypted = await crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: bytes.slice(0, 12) },
                        cryptoKey, bytes.slice(12));
                    frame.data = decrypted;
                    peerIsEncrypting = true;
                    controller.enqueue(frame);
                }
            } catch {
                // Decrypt failed — two cases:
                // 1. !peerIsEncrypting: remote peer hasn't started encrypting yet
                //    (room key exchange still in flight). Pass through so the decoder
                //    receives valid unencrypted video during this transition window.
                // 2.  peerIsEncrypting: peer was encrypting; this frame is bad (key
                //    rotation / corruption). Drop it — don't corrupt the decoder.
                if (operation === 'decrypt' && !peerIsEncrypting) controller.enqueue(frame);
            }
        }
    });
    event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable);
};
