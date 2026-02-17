// AudioWorklet processor for noise suppression
// Uses a noise gate + transient detection approach

class NoiseSuppressionProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;

        // Noise gate parameters
        this.threshold = 0.012;     // Noise floor threshold
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

        // Audio level reporting
        this.levelReportInterval = 10; // Report every N process calls (~20fps)
        this.sampleCounter = 0;
        this.peakLevel = 0;
        this.processCallCount = 0;

        // Click suppression parameters
        this.keyboardSuppressionEnabled = false;
        this.mouseSuppressionEnabled = false;
        this.clickSensitivity = 50;

        // Transient detection state
        this.prevAbsSample = 0;
        this.derivativeHistory = new Float32Array(8);
        this.derivativeIndex = 0;
        this.transientActive = false;
        this.transientSampleCount = 0;
        this.transientGain = 1.0;
        this.silenceSamplesAfterTransient = 0;

        // Transient detection thresholds (derived from clickSensitivity)
        this.keyboardMaxDuration = 0;
        this.mouseMaxDuration = 0;
        this.transientDerivativeThreshold = 0;
        this.transientRecoverySamples = 0;
        this.updateClickSensitivityParams();

        // Send a test message immediately
        this.port.postMessage({ type: 'init', message: 'NoiseSuppressionProcessor initialized' });

        // Listen for messages from main thread
        this.port.onmessage = (event) => {
            if (event.data.type === 'setEnabled') {
                this.enabled = event.data.enabled;
            } else if (event.data.type === 'setThreshold') {
                this.threshold = event.data.threshold;
            } else if (event.data.type === 'setKeyboardSuppression') {
                this.keyboardSuppressionEnabled = event.data.enabled;
            } else if (event.data.type === 'setMouseSuppression') {
                this.mouseSuppressionEnabled = event.data.enabled;
            } else if (event.data.type === 'setClickSensitivity') {
                this.clickSensitivity = event.data.sensitivity;
                this.updateClickSensitivityParams();
            }
        };
    }

    updateClickSensitivityParams() {
        const sensitivityNorm = this.clickSensitivity / 100;
        // Higher sensitivity = lower derivative threshold = more aggressive detection
        this.transientDerivativeThreshold = 0.15 - (sensitivityNorm * 0.13);

        // Duration windows in samples
        // Keyboard clicks: ~5-15ms, Mouse clicks: ~1-5ms
        this.keyboardMaxDuration = Math.round(sampleRate * (0.015 + sensitivityNorm * 0.005));
        this.mouseMaxDuration = Math.round(sampleRate * (0.005 + sensitivityNorm * 0.003));

        // Recovery period after transient (smooth fade-in)
        this.transientRecoverySamples = Math.round(sampleRate * 0.003);
    }

    detectAndSuppressTransient(absSample) {
        if (!this.keyboardSuppressionEnabled && !this.mouseSuppressionEnabled) {
            return 1.0;
        }

        // Calculate the derivative (rate of change of amplitude)
        const derivative = absSample - this.prevAbsSample;
        this.prevAbsSample = absSample;

        // Store in ring buffer for averaging
        this.derivativeHistory[this.derivativeIndex] = Math.abs(derivative);
        this.derivativeIndex = (this.derivativeIndex + 1) % this.derivativeHistory.length;

        // Average recent derivatives for stability
        let avgDerivative = 0;
        for (let j = 0; j < this.derivativeHistory.length; j++) {
            avgDerivative += this.derivativeHistory[j];
        }
        avgDerivative /= this.derivativeHistory.length;

        // Determine max transient duration based on enabled modes
        let maxDuration;
        if (this.keyboardSuppressionEnabled) {
            maxDuration = this.keyboardMaxDuration; // Longer window covers both
        } else {
            maxDuration = this.mouseMaxDuration;
        }

        if (this.transientActive) {
            this.transientSampleCount++;

            if (this.transientSampleCount > maxDuration) {
                // Lasted too long — this is speech, not a click. Release suppression.
                this.transientActive = false;
                this.silenceSamplesAfterTransient = this.transientRecoverySamples;
                this.transientGain = 1.0;
            } else {
                // Still in transient window — suppress
                this.transientGain = 0.01;
            }
        } else if (this.silenceSamplesAfterTransient > 0) {
            // Recovery phase: smooth fade-in after transient
            this.silenceSamplesAfterTransient--;
            const recoveryProgress = 1.0 - (this.silenceSamplesAfterTransient / this.transientRecoverySamples);
            this.transientGain = recoveryProgress * recoveryProgress;
        } else {
            // Check if a transient is starting
            if (avgDerivative > this.transientDerivativeThreshold && absSample > 0.005) {
                this.transientActive = true;
                this.transientSampleCount = 0;
                this.transientGain = 0.01;
            } else {
                this.transientGain = 1.0;
            }
        }

        return this.transientGain;
    }

    process(inputs, outputs, _parameters) {
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

                // Apply transient suppression on top of noise gate
                const clickGain = this.detectAndSuppressTransient(absSample);

                // Output with both gains applied
                outputChannel[i] = sample * gain * clickGain;

                // Track peak level for reporting
                if (absSample > this.peakLevel) {
                    this.peakLevel = absSample;
                }
            }
        }

        // Report audio level to main thread periodically
        this.sampleCounter++;
        if (this.sampleCounter >= this.levelReportInterval) {
            const dynamicThreshold = Math.max(this.threshold, this.noiseFloor * 3);
            try {
                this.port.postMessage({
                    type: 'audioLevel',
                    level: this.peakLevel,
                    smoothedLevel: this.smoothedLevel,
                    threshold: dynamicThreshold,
                    gateOpen: this.envelope > 0.5,
                    clickSuppressed: this.transientActive
                });
            } catch (_e) {
                // Port may be closed
            }
            this.peakLevel = 0;
            this.sampleCounter = 0;
        }

        return true;
    }
}

registerProcessor('noise-suppression-processor', NoiseSuppressionProcessor);
