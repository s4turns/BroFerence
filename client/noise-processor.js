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

        // Transient detection state — energy ratio approach
        // Short-term energy spikes relative to long-term energy indicate clicks
        this.shortTermEnergy = 0;
        this.longTermEnergy = 0;
        this.transientActive = false;
        this.transientSampleCount = 0;
        this.transientGain = 1.0;
        this.suppressionHold = 0;        // Hold suppression after transient ends
        this.prevAbsSample = 0;          // For derivative as secondary detector

        // Transient detection thresholds (derived from clickSensitivity)
        this.energyRatioThreshold = 0;   // Short/long energy ratio to trigger
        this.maxTransientDuration = 0;   // Max samples before releasing as speech
        this.suppressionHoldSamples = 0; // Hold suppression after click ends
        this.recoverySamples = 0;        // Fade-in duration after suppression
        this.recoveryCounter = 0;
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
                this.updateClickSensitivityParams();
            } else if (event.data.type === 'setMouseSuppression') {
                this.mouseSuppressionEnabled = event.data.enabled;
                this.updateClickSensitivityParams();
            } else if (event.data.type === 'setClickSensitivity') {
                this.clickSensitivity = event.data.sensitivity;
                this.updateClickSensitivityParams();
            }
        };
    }

    updateClickSensitivityParams() {
        const sensitivityNorm = this.clickSensitivity / 100;

        // Energy ratio threshold: how much the short-term energy must exceed
        // long-term energy to be considered a click.
        // Lower ratio = more aggressive detection.
        // Range: 8.0 (low sensitivity) down to 2.5 (high sensitivity)
        this.energyRatioThreshold = 8.0 - (sensitivityNorm * 5.5);

        // Max transient duration before releasing as speech
        // Keyboard: up to 50ms, Mouse: up to 15ms
        // With both enabled, use the longer window
        const keyboardMs = 0.050 + sensitivityNorm * 0.020; // 50-70ms
        const mouseMs = 0.015 + sensitivityNorm * 0.010;    // 15-25ms
        if (this.keyboardSuppressionEnabled) {
            this.maxTransientDuration = Math.round(sampleRate * keyboardMs);
        } else {
            this.maxTransientDuration = Math.round(sampleRate * mouseMs);
        }

        // Hold suppression briefly after the click energy drops
        // Prevents the tail of the click from leaking through
        this.suppressionHoldSamples = Math.round(sampleRate * (0.010 + sensitivityNorm * 0.010)); // 10-20ms

        // Smooth fade-in after suppression ends
        this.recoverySamples = Math.round(sampleRate * 0.005); // 5ms
    }

    detectAndSuppressTransient(absSample) {
        if (!this.keyboardSuppressionEnabled && !this.mouseSuppressionEnabled) {
            return 1.0;
        }

        const energy = absSample * absSample;

        // Short-term energy: fast-tracking (~0.5ms window)
        // Responds quickly to sudden amplitude changes
        const shortAlpha = 1.0 - Math.exp(-1.0 / (sampleRate * 0.0005));
        this.shortTermEnergy = this.shortTermEnergy * (1 - shortAlpha) + energy * shortAlpha;

        // Long-term energy: slow-tracking (~100ms window)
        // Represents the background/speech energy level
        const longAlpha = 1.0 - Math.exp(-1.0 / (sampleRate * 0.100));
        this.longTermEnergy = this.longTermEnergy * (1 - longAlpha) + energy * longAlpha;

        // Energy ratio: how much short-term exceeds long-term
        const safeFloor = 1e-10;
        const energyRatio = this.shortTermEnergy / (this.longTermEnergy + safeFloor);

        // Derivative as secondary signal (rapid amplitude change)
        const derivative = Math.abs(absSample - this.prevAbsSample);
        this.prevAbsSample = absSample;

        if (this.transientActive) {
            this.transientSampleCount++;

            // Check if the click energy has subsided
            const stillClickLike = energyRatio > (this.energyRatioThreshold * 0.5);

            if (this.transientSampleCount > this.maxTransientDuration) {
                // Lasted too long — this is sustained speech, not a click
                this.transientActive = false;
                this.recoveryCounter = this.recoverySamples;
                this.transientGain = 1.0;
            } else if (!stillClickLike && this.transientSampleCount > Math.round(sampleRate * 0.002)) {
                // Energy dropped and we're past the minimum 2ms — click is over
                this.transientActive = false;
                this.suppressionHold = this.suppressionHoldSamples;
                this.transientGain = 0.01;
            } else {
                // Still in the click — suppress
                this.transientGain = 0.01;
            }
        } else if (this.suppressionHold > 0) {
            // Hold suppression after click ends to catch the tail
            this.suppressionHold--;
            this.transientGain = 0.01;
            if (this.suppressionHold === 0) {
                this.recoveryCounter = this.recoverySamples;
            }
        } else if (this.recoveryCounter > 0) {
            // Smooth fade-in after suppression
            this.recoveryCounter--;
            const progress = 1.0 - (this.recoveryCounter / this.recoverySamples);
            this.transientGain = progress * progress;
        } else {
            // Check if a new transient is starting
            // Trigger when energy ratio spikes AND there's meaningful amplitude
            const minAmplitude = 0.002;
            const hasEnergySpike = energyRatio > this.energyRatioThreshold;
            const hasDerivativeSpike = derivative > 0.01;
            const aboveFloor = absSample > minAmplitude;

            if (hasEnergySpike && hasDerivativeSpike && aboveFloor) {
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
