// eslint.config.js
import js from "@eslint/js";

export default [
  js.configs.recommended,  // includes good defaults like no-unused-vars, semi, etc.

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
        URLSearchParams: "readonly",

        // WebRTC globals
        WebSocket: "readonly",
        RTCPeerConnection: "readonly",
        RTCSessionDescription: "readonly",
        RTCIceCandidate: "readonly",
        MediaStream: "readonly",

        // AudioWorklet globals
        AudioWorkletProcessor: "readonly",
        AudioWorkletNode: "readonly",
        registerProcessor: "readonly",
        sampleRate: "readonly",

        // Web Worker globals (for AudioWorklet processors)
        importScripts: "readonly",

        // RNNoise specific (loaded via importScripts)
        createRNNWasmModuleSync: "readonly",
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