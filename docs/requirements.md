# Requirements ledger

Source: spec section 2. Status reflects the repository, not intent.
Statuses: Not started / Partial / Done. "Mock" means implemented only against the mock source.

| ID | Priority | Requirement | Target phase | Status |
|---|---|---|---|---|
| R-001 | P0 | Browser-first, no trainer application backend required for direct hardware use | 0-1 | Partial: static Vite app, no backend. Hardware path not started. |
| R-002 | P0 | Go core compiled to WASM; React + TypeScript frontend; browser APIs remain in TypeScript adapters | 0-2 | Partial: Go core WASM loaded in browser via `coreBridge` facade; contract fixtures checked in Go and via built WASM (`make test-wasm`). |
| R-003 | P0 | Read actual B/S/T controls from browser Gamepad API when available | 1 | Partial (unverified on hardware): Gamepad adapter reads axes + analog buttons, per-control device mapping, diagnostics screen. |
| R-004 | P0 | GT7 collector supported through its new optional WebSocket endpoint; separate repo | 5 | Partial: prototype client + MOCK collector server; draft protocol v1 (ADR 0005 proposed). Collector unchanged (Phase 5). |
| R-005 | P0 | Correct availability flags: never pass unverified vehicle measurements off as user steering | 1-5 | Partial: Go `Decode` + UI keep null as n/a; GT7 client forces steering unavailable regardless of collector claims. |
| R-006 | P0 | Freeform practice without a desired target | 3-4 | Not started |
| R-007 | P0 | Guided practice via presets and parameter-based drills | 4 | Partial (core): drill schema v1, presets (proposed values), parameter targets in `core/drills`. UI = Phase 4. |
| R-008 | P0 | Select B, S, T, B+S, S+T, or B+S+T; no B+T-only selection | 2 | Done (core): `drills.ValidateSelection` accepts only contiguous B/S/T ranges; B+T rejected. UI = Phase 4. |
| R-009 | P0 | Desired B and T never simultaneously positive; optional steering-only and coast phases | 2 | Done (core): `drills.Validate` rejects any desired B/T overlap; property + fuzz tested; coast/steering-only phases supported. |
| R-010 | P0 | Actual B+T overlap generates immediate distinctive warning; round continues | 2-3 | Partial (core): `engine.OverlapDetector` one-shot onset with hysteresis + cooldown, never alters input or ends round. Audio alert = Phase 3. |
| R-011 | P0 | Primary audio input follows new/later control: B then S then T; other channels are still monitored | 2-3 | Partial (core): `engine.GuidedPrimary` (phase-driven) and `FreeformPrimary` (hysteresis). Audio priority = Phase 3. |
| R-012 | P0 | Audio represents input position, movement direction, movement rate, and smoothness | 3 | Partial (prototype): input position -> pitch tone only. Movement/smoothness = Phase 3. |
| R-013 | P0 | Optional, toggleable unwanted-fluctuation alerts; rapid intentional changes not categorically wrong | 3 | Not started |
| R-014 | P0 | Guided drills offer user-selectable dual tones or deviation-based feedback | 3 | Not started |
| R-015 | P0 | Spoken instructions, countdowns and summaries plus reference tones; voice summary can be disabled | 3 | Not started |
| R-016 | P0 | Time-based and self-paced drills | 2-4 | Partial (core): timed `TargetAt` and self-paced `ShapeAt` (retrospective only); session timed/selfPaced modes. |
| R-017 | P0 | Automatic final-state detection **and** manual completion for self-paced drills | 2 | Partial (core): `engine.CompletionDetector` (continuous hold, fly-through safe) + session auto/manual/either. Commands UI = Phase 3. |
| R-018 | P0 | Voice commands **and** configurable keyboard/wheel/controller button mappings | 3 | Not started |
| R-019 | P0 | Repeated rounds in one session: configurable count, default **8** | 2 | Done (core): session rounds default 8, configurable 1..100. |
| R-020 | P0 | Configurable rest and countdown; automatic next round without checking input reset | 2 | Done (core): rest/countdown configurable (5 s/3 s proposed); rounds auto-advance without input reset. |
| R-021 | P0 | Distinct Hold, Full-range Linear Sweep, Progressive Curve, and Multi-stage drill types | 2-4 | Partial (core): hold, sweep, progressive, multistage definitions + targets. UX = Phase 4. |
| R-022 | P0 | Progressive curves use adjustable presets; no mandatory hand-drawn curve editor | 2-4 | Partial (core): documented eased curves (linear, easeIn, easeOut, easeInOut, intensity). UX = Phase 4. |
| R-023 | P0 | Beginner/intermediate/advanced presets plus per-control and per-drill precision overrides | 4 | Partial (core): beginner/intermediate/advanced presets (proposed values) + per-control/per-drill overrides. |
| R-024 | P0 | Independent accuracy/smoothness/timing/consistency metrics; no combined total | 4 | Not started |
| R-025 | P0 | Preserve per-round input telemetry and plot desired vs actual for each selected input after drills | 4 | Not started |
| R-026 | P0 | Optional spoken performance feedback and post-session improvement suggestions only; no automatic difficulty changes | 4 | Not started |
| R-027 | P0 | Current-session data only, no retained historical results | 0-4 | Partial: no storage/backend exists; mock frames live in memory only. |
| R-028 | P0 | Calibration is optional; ability to set mapping, inversion, min/max, neutral, deadzone | 1 | Partial (unverified on hardware): optional mapping, inversion, range capture, center, deadzone. |
| R-029 | P0 | Source/connection loss and permission failures are audible and do not yield false success scores | 1-3 | Partial: device loss -> n/a; WS stale; session SOURCE_LOST invalidates attempt (retry cap 3); audio suspended warning. Audible alerts = Phase 3. |
| R-030 | P0 | Go Modules + npm workspace dependency management; deterministic builds | 0 | Done (baseline): `core/go.mod`, npm workspaces + lockfile, `make setup` uses `npm ci` + `go mod verify`. |
| R-031 | P0 | GitHub Actions tests, static analysis, security scanning, SBOM, signing, provenance | 0-6 | Partial: CI runs make lint/test/build/test-wasm/test-e2e; security scans; CodeQL enabled (public repo). SBOM/signing/provenance = Phase 6. |
| R-032 | P0 | Version tags from `main` create GitHub Releases; Cloudflare Pages deploys the exact release bundle | 6 | Not started |
| R-033 | P1 | Record-and-repeat custom target (advanced, later) | future | Not started |
| R-034 | P1 | Live visible target trace (optional advanced enhancement; post-session trace is P0) | future | Not started |
| R-035 | P2 | Native desktop application using reusable core | future | Not started |
| R-036 | P2 | GT7-specific mobile application using reusable core and collector connection | future | Not started |
| R-037 | P0 | Hardware and browser compatibility tested rather than assumed | 1-6 | Partial: manual protocol `docs/hardware-test-protocol.md`; no hardware evidence recorded yet. |

## What is mocked vs unimplemented (Phase 1)

- **Mocked:** MOCK input source; MOCK GT7 collector server (`tests/mock-collector/`). Both labelled MOCK.
- **Prototype (Phase 1 feasibility, hardware-unverified):** Gamepad adapter + diagnostics, optional calibration, single pitch tone, GT7 WebSocket client (draft protocol), WASM bridge.
- **Go core only (no UI/audio yet):** drills, targets, B/T invariant, overlap/completion/primary detection, session state machine (Phase 2).
- **Unimplemented:** metrics, graphs, sonification design (movement/smoothness, dual-tone, deviation), speech, voice/button commands, collector-side WebSocket, release/SBOM/signing/deploy.

## Decisions changed vs spec

- Default branch `master`, not `main` (ADR 0001).
- License: Business Source License 1.1 (ADR 0002). Repository visibility still open.
