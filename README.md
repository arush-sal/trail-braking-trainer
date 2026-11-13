# Trail Braking Trainer

Browser-based muscle-memory trainer for precise, smooth, repeatable brake,
steering, and throttle input. It is not a racing-line advisor, lap-time
optimizer, or race engineer. Spec: `trail-braking-trainer-implementation-plan.md`.

## Status: Phase 0 (foundation)

| Area | State |
|---|---|
| Input | **Mock only.** Synthetic B->S->T pattern, labelled `MOCK` in the UI. |
| Go core | Input frame contract + validation. WASM builds but is not loaded by the app yet. |
| Gamepad / Fanatec / Logitech | Not implemented, not tested. |
| Audio, speech, voice/button commands | Not implemented. |
| Drills, sessions, metrics, graphs | Not implemented. |
| GT7 collector WebSocket | Not implemented (separate repo, Phase 5). Steering from GT7 is unverified. |
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
```

## License

Business Source License 1.1. See `LICENSE`.
