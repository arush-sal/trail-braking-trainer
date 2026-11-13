# Trail Braking Trainer

Browser-based muscle-memory trainer for precise, smooth, repeatable brake,
steering, and throttle input. It is not a racing-line advisor, lap-time
optimizer, or race engineer. Spec: `trail-braking-trainer-implementation-plan.md`.

## Status: Phase 1 (feasibility prototypes)

| Area | State |
|---|---|
| Input | MOCK source, plus Gamepad adapter + diagnostics (prototype, **not verified on any wheel yet**). |
| Go core | Input frame contract + strict decode; loaded in the browser via WASM. |
| Fanatec / Logitech | Not tested. Follow `docs/hardware-test-protocol.md`. |
| Audio | Single pitch-tone prototype. Speech, voice/button commands not implemented. |
| Drills, sessions, metrics, graphs | Not implemented. |
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
