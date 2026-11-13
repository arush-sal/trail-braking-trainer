# 0003. Phase 0 toolchain and layout

- Status: accepted
- Date: 2026-11-14
- Requirements: R-001, R-002, R-030, R-031

## Decision
- One Go module at `core/` (stdlib only). `go` directive = latest toolchain.
  WASM built with `GOOS=js GOARCH=wasm`, `-trimpath -buildid=`, and the
  version-matched `wasm_exec.js` copied from `$(go env GOROOT)/lib/wasm`.
- npm workspaces at root, single app `apps/web` (Vite + React + TypeScript,
  Vitest, ESLint flat config). Node pinned in `.node-version`.
- `Makefile` is the single local/CI command contract; workflows call `make`.
- Phase 0 creates only the folders it fills. Spec section 9 layout is the
  target, filled by later phases (no empty scaffolding).
- One shared `InputFrame` JSON contract (spec 4.1) mirrored in
  `core/input` and `apps/web/src/input/types.ts`. Unavailable channels carry
  `null`, never `0`. Go `input.Decode` enforces field presence: required
  fields must be present and non-null, `rawValue`/`normalized` present (null
  when unavailable), optional fields absent rather than null, unknown fields
  rejected.
- Steering `[-1,1]` validation is a **provisional** signed practice scale
  (matches Gamepad axes and the mock). It will be revisited after hardware
  and collector evidence (validation-log); it is not a physical unit.

## Consequences
Contract drift between Go and TS is caught only by review until Phase 1 adds a
cross-language fixture test (`tests/contracts`).
