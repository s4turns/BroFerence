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
    const transform = new TransformStream({
        async transform(frame, controller) {
            if (!cryptoKey) { controller.enqueue(frame); return; }
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
                    controller.enqueue(frame);
                }
            } catch {
                // Drop undecryptable frames (e.g. during key rotation) — do not forward
            }
        }
    });
    event.transformer.readable.pipeThrough(transform).pipeTo(event.transformer.writable);
};
