// eslint.config.js
import js from "@eslint/js";

export default [
  // Vendored/generated code — not ours to lint.
  {
    ignores: ["node_modules/**", "client/lib/**"],
  },

  js.configs.recommended,  // includes good defaults like no-unused-vars, semi, etc.

  // Node config files (CommonJS).
  {
    files: ["ecosystem.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        require: "readonly",
        process: "readonly",
        __dirname: "readonly",
      },
    },
  },

  {
    languageOptions: {
      globals: {
        // Browser globals
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        requestAnimationFrame: "readonly",
        fetch: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        URLSearchParams: "readonly",
        URL: "readonly",
        Blob: "readonly",
        Image: "readonly",
        performance: "readonly",
        atob: "readonly",
        btoa: "readonly",
        crypto: "readonly",
        SpeechSynthesisUtterance: "readonly",
        speechSynthesis: "readonly",

        // Signaling transport globals
        WebTransport: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        DataView: "readonly",
        Uint8Array: "readonly",

        // WebRTC globals
        WebSocket: "readonly",
        RTCPeerConnection: "readonly",
        RTCSessionDescription: "readonly",
        RTCIceCandidate: "readonly",
        MediaStream: "readonly",
        RTCRtpScriptTransform: "readonly",
        RTCRtpSender: "readonly",
        RTCRtpReceiver: "readonly",

        // AudioWorklet globals
        AudioWorkletProcessor: "readonly",
        AudioWorkletNode: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",

        // Web Worker globals (for AudioWorklet processors and the E2EE worker)
        importScripts: "readonly",
        self: "readonly",
        Worker: "readonly",
        TransformStream: "readonly",

        // RNNoise specific (loaded via importScripts)
        createRNNWasmModuleSync: "readonly",

        // icons.js (loaded via its own script tag before conference.js)
        iconSvg: "readonly",
        setIcon: "readonly",
        hydrateIcons: "readonly",
      },
    },
    rules: {
      // Add/override rules here as needed
      "no-console": "warn",           // warn on console.log (acceptable for client-side code)
      "semi": ["error", "always"],    // require semicolons
      "no-case-declarations": "off",  // allow lexical declarations in case blocks
      "no-unused-vars": ["error", {
        "argsIgnorePattern": "^_",    // allow unused parameters prefixed with _
        "varsIgnorePattern": "^_",    // allow unused variables prefixed with _
        "destructuredArrayIgnorePattern": "^_",  // allow unused destructured array elements prefixed with _
        "caughtErrorsIgnorePattern": "^_"  // allow unused catch clause errors prefixed with _
      }]
    },
  },
];