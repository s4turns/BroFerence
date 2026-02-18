// AudioWorklet processor for noise suppression
// Uses a noise gate + silence-gated transient detection approach

class NoiseSuppressionProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.enabled = true;

        // Noise gate parameters
        this.threshold = 0.012;     // Noise floor threshold
        this.holdTime = 0.1;        // Hold time before release

        // Precomputed noise gate coefficients (never change, compute once)
        this.attackCoef  = Math.exp(-1 / (0.003 * sampleRate));  // 3ms attack
        this.releaseCoef = Math.exp(-1 / (0.250 * sampleRate));  // 250ms release

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

        // Speech presence detector — slow attack/release to distinguish sustained
        // speech from brief click transients. A keyboard click (≤60ms) never pushes
        // this above the 0.5 threshold; normal speech confirms in ~140ms.
        // Attack 200ms, Release 100ms (precomputed).
        this.speechAttackCoef  = Math.exp(-1 / (0.200 * sampleRate));
        this.speechReleaseCoef = Math.exp(-1 / (0.100 * sampleRate));
        this.speechEnvelope = 0;

        // Click suppression state
        this.silenceCounter = 0;         // Samples since speech last confirmed
        this.clickArmed = false;         // True once 50ms of non-speech confirmed
        this.clickActive = false;        // Currently suppressing a click
        this.clickSampleCount = 0;       // Samples into current suppression
        this.clickHold = 0;              // Hold suppression after click ends
        this.clickRecovery = 0;          // Fade-in counter after hold
        this.clickGain = 1.0;            // Current suppression gain

        // Thresholds (set by updateClickSensitivityParams)
        this.minSilenceSamples = 0;
        this.clickMultiplier = 0;
        this.maxClickSamples = 0;
        this.clickHoldSamples = 0;
        this.clickRecoverySamples = 0;
        this.updateClickSensitivityParams();

        this.port.postMessage({ type: 'init', message: 'NoiseSuppressionProcessor initialized' });

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

        // How many times above noise floor the signal must be to trigger.
        // High sensitivity = lower multiplier = easier to trigger.
        // Range: 12× (low) down to 5× (high)
        this.clickMultiplier = 12 - (sensitivityNorm * 7);

        // 50ms of confirmed non-speech required before detection arms.
        this.minSilenceSamples = Math.round(sampleRate * 0.050);

        // Max suppression duration before releasing as speech.
        // Keyboard clicks: up to 60ms, Mouse clicks: up to 20ms.
        const keyboardMs = 0.060;
        const mouseMs = 0.020;
        if (this.keyboardSuppressionEnabled) {
            this.maxClickSamples = Math.round(sampleRate * keyboardMs);
        } else {
            this.maxClickSamples = Math.round(sampleRate * mouseMs);
        }

        // Hold suppression for 15ms after the click signal drops
        this.clickHoldSamples = Math.round(sampleRate * 0.015);

        // 5ms fade-in after suppression ends
        this.clickRecoverySamples = Math.round(sampleRate * 0.005);
    }

    detectAndSuppressTransient(absSample, inSpeech) {
        if (!this.keyboardSuppressionEnabled && !this.mouseSuppressionEnabled) {
            return 1.0;
        }

        // Confirmed speech — disable click suppression and reset state.
        if (inSpeech) {
            this.silenceCounter = 0;
            this.clickArmed = false;
            this.clickActive = false;
            this.clickHold = 0;
            this.clickRecovery = 0;
            this.clickGain = 1.0;
            return 1.0;
        }

        // Count non-speech samples until arming threshold is reached.
        this.silenceCounter++;
        if (this.silenceCounter >= this.minSilenceSamples) {
            this.clickArmed = true;
        }

        if (!this.clickArmed) {
            return 1.0;
        }

        // Trigger threshold: signal must be meaningfully above the noise floor
        const triggerThreshold = Math.max(
            this.noiseFloor * this.clickMultiplier,
            this.threshold * 0.5
        );

        if (this.clickActive) {
            this.clickSampleCount++;

            if (this.clickSampleCount > this.maxClickSamples) {
                // Lasted too long — release as speech. Fade in from silence.
                this.clickActive = false;
                this.clickRecovery = this.clickRecoverySamples;
                this.clickGain = 0.0;
            } else if (this.smoothedLevel < triggerThreshold * 0.3) {
                // Signal dropped — click is over, enter hold
                this.clickActive = false;
                this.clickHold = this.clickHoldSamples;
                this.clickGain = 0.0;
            } else {
                this.clickGain = 0.0;
            }
        } else if (this.clickHold > 0) {
            // Check for a new click arriving during hold (rapid typing burst)
            if (this.smoothedLevel > triggerThreshold) {
                this.clickActive = true;
                this.clickSampleCount = 0;
                this.clickHold = 0;
                this.clickGain = 0.0;
            } else {
                this.clickHold--;
                this.clickGain = 0.0;
                if (this.clickHold === 0) {
                    this.clickRecovery = this.clickRecoverySamples;
                }
            }
        } else if (this.clickRecovery > 0) {
            // Check for a new click arriving during fade-in (rapid typing burst)
            if (this.smoothedLevel > triggerThreshold) {
                this.clickActive = true;
                this.clickSampleCount = 0;
                this.clickRecovery = 0;
                this.clickGain = 0.0;
            } else {
                this.clickRecovery--;
                const progress = 1.0 - (this.clickRecovery / this.clickRecoverySamples);
                this.clickGain = progress * progress;
            }
        } else {
            // Armed and idle — watch for a click
            if (this.smoothedLevel > triggerThreshold) {
                this.clickActive = true;
                this.clickSampleCount = 0;
                this.clickGain = 0.0;
            } else {
                this.clickGain = 1.0;
            }
        }

        return this.clickGain;
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

                // Apply attack/release smoothing (coefficients precomputed in constructor)
                if (targetEnvelope > this.envelope) {
                    this.envelope = this.attackCoef * this.envelope + (1 - this.attackCoef) * targetEnvelope;
                } else {
                    this.envelope = this.releaseCoef * this.envelope + (1 - this.releaseCoef) * targetEnvelope;
                }

                // Apply soft knee gain reduction
                const gain = this.envelope * this.envelope; // Squared for softer knee

                // Speech presence detector: slow attack (200ms) / release (100ms) on the
                // raw level signal. A keyboard click (≤60ms) only pushes this to ~0.26
                // max; speech confirms at 0.5 after ~140ms of sustained activity.
                const speechInput = isAboveThreshold ? 1.0 : 0.0;
                if (speechInput > this.speechEnvelope) {
                    this.speechEnvelope = this.speechAttackCoef * this.speechEnvelope + (1 - this.speechAttackCoef) * speechInput;
                } else {
                    this.speechEnvelope = this.speechReleaseCoef * this.speechEnvelope + (1 - this.speechReleaseCoef) * speechInput;
                }
                const inSpeech = this.speechEnvelope > 0.5;

                // Apply click suppression
                const clickGain = this.detectAndSuppressTransient(absSample, inSpeech);

                // Output with both gains applied
                outputChannel[i] = sample * gain * clickGain;

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
                    clickSuppressed: this.clickActive
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
