# Trail Braking Trainer

Browser-based muscle-memory trainer for precise, smooth, repeatable brake,
steering, and throttle input. It is not a racing-line advisor, lap-time
optimizer, or race engineer. Spec: `trail-braking-trainer-implementation-plan.md`.

## Status: Phase 4 (guided drills, metrics and results; MOCK-verified only)

| Area | State |
|---|---|
| Input | MOCK source, plus Gamepad adapter + diagnostics (prototype, **not verified on any wheel yet**). |
| Fanatec / Logitech | Not tested. Follow `docs/hardware-test-protocol.md`. |
| Go core | Drills, targets, session state machine, overlap/fluctuation/completion/primary detectors; WASM session API v1 (ADR 0007). |
| Audio + speech | Sonification (position, movement, smoothness; dual tone / deviation / self-paced end-state), alerts, spoken cues with ducking. Sounds are PROPOSED; no listening test yet; browser speech output unverified. |
| Commands | One dispatcher for keyboard, learned gamepad buttons, voice (browser SpeechRecognition, privacy notice) and UI. Voice and gamepad buttons unverified. |
| Sessions | Freeform and guided (preset catalog + parameter drill editor with core-validated preview), rounds/rest/countdown, source-loss handling. MOCK sessions of every drill type complete in e2e. |
| Metrics, graphs | Separate accuracy / smoothness / timing / consistency metrics (no combined score; formulas in `docs/metric-definitions.md`), desired-vs-actual graphs per channel, suggestions applied only on confirm. Thresholds PROPOSED; not validated on hardware. Results stay in memory only. |
| GT7 collector WebSocket | Client prototype vs MOCK server (`tests/mock-collector/`); collector side is Phase 5. GT7 steering always unavailable. |
| Release, SBOM, signing, deploy | Not implemented (Phase 6). |

Per-requirement status: `docs/requirements.md`. Hardware evidence:
`docs/validation-log.md`.

## Quickstart

Requires Go (version in `core/go.mod`), Node (version in `.node-version`), and
for `make lint` / `make security`: golangci-lint, govulncheck, osv-scanner,
trivy, zizmor on `PATH`.

```sh
make setup   # npm ci + go mod download/verify
make test    # Go (race) + Vitest
make lint    # go vet (native + js/wasm), golangci-lint, eslint, tsc
make build   # WASM + Vite bundle -> apps/web/dist
make dev     # Vite dev server
make test-wasm  # contract fixtures through built core.wasm
make test-e2e   # Playwright smoke (Chromium)
```

## License

Business Source License 1.1. See `LICENSE`.
