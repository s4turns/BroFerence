// AudioWorklet processor for noise suppression
// Uses a noise gate + spectral analysis approach

class NoiseSuppressionProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;

        // Noise gate parameters
        this.threshold = 0.011;     // Noise floor threshold
        this.attack = 0.003;        // Attack time in seconds
        this.release = 0.25;        // Release time in seconds
        this.holdTime = 0.1;        // Hold time before release

        // State
        this.envelope = 0;
        this.holdCounter = 0;
        this.smoothedLevel = 0;

        // Noise profile (will be updated during silence)
        this.noiseFloor = 0.005;
        this.noiseAdaptRate = 0.001;

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.type === 'setEnabled') {
                this.enabled = event.data.enabled;
            } else if (event.data.type === 'setThreshold') {
                this.threshold = event.data.threshold;
            }
        };
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        const output = outputs[0];

        if (!input || !input[0]) {
            return true;
        }

        for (let channel = 0; channel < input.length; channel++) {
            const inputChannel = input[channel];
            const outputChannel = output[channel];

            if (!this.enabled) {
                // Pass through without processing
                outputChannel.set(inputChannel);
                continue;
            }

            for (let i = 0; i < inputChannel.length; i++) {
                const sample = inputChannel[i];
                const absSample = Math.abs(sample);

                // Smooth the input level
                const levelSmoothing = 0.1;
                this.smoothedLevel = this.smoothedLevel * (1 - levelSmoothing) + absSample * levelSmoothing;

                // Adaptive noise floor detection (during quiet moments)
                if (this.smoothedLevel < this.noiseFloor * 2) {
                    this.noiseFloor = this.noiseFloor * (1 - this.noiseAdaptRate) + this.smoothedLevel * this.noiseAdaptRate;
                }

                // Dynamic threshold based on noise floor
                const dynamicThreshold = Math.max(this.threshold, this.noiseFloor * 3);

                // Determine if signal is above threshold
                const isAboveThreshold = this.smoothedLevel > dynamicThreshold;

                // Calculate target envelope
                let targetEnvelope;
                if (isAboveThreshold) {
                    targetEnvelope = 1;
                    this.holdCounter = this.holdTime * sampleRate;
                } else if (this.holdCounter > 0) {
                    targetEnvelope = 1;
                    this.holdCounter--;
                } else {
                    targetEnvelope = 0;
                }

                // Apply attack/release smoothing
                const attackCoef = Math.exp(-1 / (this.attack * sampleRate));
                const releaseCoef = Math.exp(-1 / (this.release * sampleRate));

                if (targetEnvelope > this.envelope) {
                    this.envelope = attackCoef * this.envelope + (1 - attackCoef) * targetEnvelope;
                } else {
                    this.envelope = releaseCoef * this.envelope + (1 - releaseCoef) * targetEnvelope;
                }

                // Apply soft knee gain reduction
                const gain = this.envelope * this.envelope; // Squared for softer knee

                // Output with gain applied
                outputChannel[i] = sample * gain;
            }
        }

        return true;
    }
}

registerProcessor('noise-suppression-processor', NoiseSuppressionProcessor);
