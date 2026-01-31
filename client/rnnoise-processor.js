// RNNoise AudioWorklet Processor
// Uses the RNNoise neural network for noise suppression

// Import the RNNoise WASM module (will be loaded via importScripts in worklet)
let RNNoiseModule = null;
let rnnoiseState = null;
let rnnoiseBuffer = null;
let rnnoiseBufferSize = 480; // RNNoise expects 480 samples (10ms at 48kHz)

class RNNoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;
        this.initialized = false;
        this.inputBuffer = new Float32Array(rnnoiseBufferSize);
        this.inputBufferIndex = 0;
        this.outputBuffer = new Float32Array(rnnoiseBufferSize);
        this.outputBufferIndex = 0;
        this.hasOutputData = false;

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.type === 'setEnabled') {
                this.enabled = event.data.enabled;
            } else if (event.data.type === 'init') {
                this.initRNNoise();
            }
        };

        // Auto-init
        this.initRNNoise();
    }

    async initRNNoise() {
        if (this.initialized) return;

        try {
            // Load the RNNoise module
            if (!RNNoiseModule) {
                // Import the sync module
                importScripts('lib/rnnoise-sync.js');
                RNNoiseModule = createRNNWasmModuleSync();
            }

            // Create RNNoise state
            rnnoiseState = RNNoiseModule._rnnoise_create();
            rnnoiseBuffer = RNNoiseModule._malloc(rnnoiseBufferSize * 4); // 4 bytes per float

            this.initialized = true;
            this.port.postMessage({ type: 'initialized' });
            console.log('RNNoise initialized successfully');
        } catch (error) {
            console.error('Failed to initialize RNNoise:', error);
            this.port.postMessage({ type: 'error', error: error.message });
        }
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) {
            return true;
        }

        const inputChannel = input[0];
        const outputChannel = output[0];

        if (!this.enabled || !this.initialized || !rnnoiseState) {
            // Pass through without processing
            outputChannel.set(inputChannel);
            return true;
        }

        // Process samples through RNNoise
        for (let i = 0; i < inputChannel.length; i++) {
            // Add sample to input buffer
            this.inputBuffer[this.inputBufferIndex++] = inputChannel[i];

            // When we have enough samples, process through RNNoise
            if (this.inputBufferIndex >= rnnoiseBufferSize) {
                this.processRNNoiseFrame();
                this.inputBufferIndex = 0;
                this.hasOutputData = true;
                this.outputBufferIndex = 0;
            }

            // Output from the processed buffer
            if (this.hasOutputData && this.outputBufferIndex < rnnoiseBufferSize) {
                outputChannel[i] = this.outputBuffer[this.outputBufferIndex++];
            } else {
                // No processed data yet, output silence or pass through
                outputChannel[i] = 0;
            }
        }

        return true;
    }

    processRNNoiseFrame() {
        if (!RNNoiseModule || !rnnoiseState || !rnnoiseBuffer) return;

        // Copy input to WASM memory (convert to int16 range that RNNoise expects)
        for (let i = 0; i < rnnoiseBufferSize; i++) {
            // RNNoise expects samples in range [-32768, 32767]
            const sample = Math.max(-1, Math.min(1, this.inputBuffer[i]));
            RNNoiseModule.HEAPF32[(rnnoiseBuffer >> 2) + i] = sample * 32768;
        }

        // Process through RNNoise
        RNNoiseModule._rnnoise_process_frame(rnnoiseState, rnnoiseBuffer, rnnoiseBuffer);

        // Copy output from WASM memory (convert back to float range)
        for (let i = 0; i < rnnoiseBufferSize; i++) {
            this.outputBuffer[i] = RNNoiseModule.HEAPF32[(rnnoiseBuffer >> 2) + i] / 32768;
        }
    }
}

registerProcessor('rnnoise-processor', RNNoiseProcessor);
