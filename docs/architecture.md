# Architecture (Phase 0 state)

```text
apps/web (React + TS)                 core (Go -> WASM)
  input/types.ts  <-- InputFrame JSON -->  input/frame.go (Validate)
  input/mock/     (MOCK source)             cmd/wasm  (tbtCore global; not loaded yet)
  app/App.tsx     (10 Hz readout, no per-sample render)
```

Ownership (spec 8): Go core owns drill/session determinism and metrics;
TypeScript adapters own Gamepad/WebSocket/speech/audio; React owns views.
No backend, no storage of session telemetry. Target layout: spec section 9.
