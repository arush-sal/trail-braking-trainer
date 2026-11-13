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
| R-006 | P0 | Freeform practice without a desired target | 3-4 | Partial (mock): freeform session (any legal selection, timed rounds) with continuous sonification of the selected controls via `SessionPanel` + `sessionRunner`; driven only by MOCK in automated tests. Freeform metrics/stats = Phase 4. |
| R-007 | P0 | Guided practice via presets and parameter-based drills | 4 | Partial (core): drill schema v1, presets (proposed values), parameter targets in `core/drills`. UI = Phase 4. |
| R-008 | P0 | Select B, S, T, B+S, S+T, or B+S+T; no B+T-only selection | 2 | Done (core): `drills.ValidateSelection` accepts only contiguous B/S/T ranges; B+T rejected. UI = Phase 4. |
| R-009 | P0 | Desired B and T never simultaneously positive; optional steering-only and coast phases | 2 | Done (core): `drills.Validate` rejects any desired B/T overlap; property + fuzz tested; coast/steering-only phases supported. |
| R-010 | P0 | Actual B+T overlap generates immediate distinctive warning; round continues | 2-3 | Partial (mock): core `OverlapDetector` onset -> `sessionRunner` -> immediate `overlap` audio alert (alert bus, not ducked, never spoken); e2e `eyes-free.spec.ts` shows one alert per injected MOCK episode and the round completes normally. Sound design unverified in listening tests. |
| R-011 | P0 | Primary audio input follows new/later control: B then S then T; other channels are still monitored | 2-3 | Partial (mock): core `GuidedPrimary`/`FreeformPrimary` -> `snapshot.primary` -> `AudioScene.primary` (foreground voice). Unit-tested pass-through; perceptual priority unverified in listening tests. |
| R-012 | P0 | Audio represents input position, movement direction, movement rate, and smoothness | 3 | Partial (unverified): `SonifyEngine` maps position, movement direction/rate (partial) and jitter (roughness) per voice, fed live by `sessionRunner`. All constants PROPOSED; no listening test recorded. |
| R-013 | P0 | Optional, toggleable unwanted-fluctuation alerts; rapid intentional changes not categorically wrong | 3 | Partial (unverified): optional `fluctuationAlerts` toggle in session setup -> core `FluctuationDetector` -> `fluctuation` alert. Thresholds PROPOSED; no hardware/listening evidence. |
| R-014 | P0 | Guided drills offer user-selectable dual tones or deviation-based feedback | 3 | Partial (unverified): guided timed sessions choose dual tone or deviation audio (`SessionPanel`), self-paced uses the terminal end-state cue only (no fabricated live target). Listening tests pending. |
| R-015 | P0 | Spoken instructions, countdowns and summaries plus reference tones; voice summary can be disabled | 3 | Partial (unverified): announcer speaks exercise/config, countdown, round outcome and session summary (each category can be switched off in Controls); tones duck during speech. Phrases asserted in e2e via test hook; actual browser speech output not verified. |
| R-016 | P0 | Time-based and self-paced drills | 2-4 | Partial (core): timed `TargetAt` and self-paced `ShapeAt` (retrospective only); session timed/selfPaced modes. |
| R-017 | P0 | Automatic final-state detection **and** manual completion for self-paced drills | 2 | Partial: core auto/manual/either completion + `complete` command reachable by keyboard (Enter), learned gamepad buttons, voice ("done"), and UI through one dispatcher. Hardware buttons and voice unverified. |
| R-018 | P0 | Voice commands **and** configurable keyboard/wheel/controller button mappings | 3 | Partial (unverified): one dispatcher (`controls/dispatcher.ts`) for keyboard (defaults G/Space/Enter/S/Escape, rebindable with conflict checks), learned gamepad buttons (own poll, independent of the training source; training inputs refused) and browser SpeechRecognition (privacy notice, stop confirmation, suppressed while the app speaks). Keyboard start/pause/resume/complete/skip/stop verified in e2e (MOCK); gamepad buttons and voice not verified on hardware/browsers. |
| R-019 | P0 | Repeated rounds in one session: configurable count, default **8** | 2 | Done (core): session rounds default 8, configurable 1..100. |
| R-020 | P0 | Configurable rest and countdown; automatic next round without checking input reset | 2 | Done (core + mock e2e): rest/countdown configurable in session setup (5 s/3 s proposed defaults from core presets); rounds auto-advance without input reset. |
| R-021 | P0 | Distinct Hold, Full-range Linear Sweep, Progressive Curve, and Multi-stage drill types | 2-4 | Partial (core): hold, sweep, progressive, multistage definitions + targets. UX = Phase 4. |
| R-022 | P0 | Progressive curves use adjustable presets; no mandatory hand-drawn curve editor | 2-4 | Partial (core): documented eased curves (linear, easeIn, easeOut, easeInOut, intensity). UX = Phase 4. |
| R-023 | P0 | Beginner/intermediate/advanced presets plus per-control and per-drill precision overrides | 4 | Partial (core): beginner/intermediate/advanced presets (proposed values) + per-control/per-drill overrides. |
| R-024 | P0 | Independent accuracy/smoothness/timing/consistency metrics; no combined total | 4 | Not started |
| R-025 | P0 | Preserve per-round input telemetry and plot desired vs actual for each selected input after drills | 4 | Not started |
| R-026 | P0 | Optional spoken performance feedback and post-session improvement suggestions only; no automatic difficulty changes | 4 | Not started |
| R-027 | P0 | Current-session data only, no retained historical results | 0-4 | Partial: no storage/backend exists; mock frames live in memory only. |
| R-028 | P0 | Calibration is optional; ability to set mapping, inversion, min/max, neutral, deadzone | 1 | Partial (unverified on hardware): optional mapping, inversion, range capture, center, deadzone. |
| R-029 | P0 | Source/connection loss and permission failures are audible and do not yield false success scores | 1-3 | Partial: device loss -> n/a; WS stale; session SOURCE_LOST invalidates attempt (retry cap 3); `sessionRunner` reports silence > 250 ms, stale frames or unavailable required channels as `sourceLost` (once) with an audible alert + critical speech, and `sourceRestored` on recovery. Unit-tested with fakes; e2e: MOCK stopped mid-round -> `invalidSourceLost` + one audible alert, round retried and completed. Not exercised on hardware. |
| R-030 | P0 | Go Modules + npm workspace dependency management; deterministic builds | 0 | Done (baseline): `core/go.mod`, npm workspaces + lockfile, `make setup` uses `npm ci` + `go mod verify`. |
| R-031 | P0 | GitHub Actions tests, static analysis, security scanning, SBOM, signing, provenance | 0-6 | Partial: CI runs make lint/test/build/test-wasm/test-e2e; security scans; CodeQL enabled (public repo). SBOM/signing/provenance = Phase 6. |
| R-032 | P0 | Version tags from `main` create GitHub Releases; Cloudflare Pages deploys the exact release bundle | 6 | Not started |
| R-033 | P1 | Record-and-repeat custom target (advanced, later) | future | Not started |
| R-034 | P1 | Live visible target trace (optional advanced enhancement; post-session trace is P0) | future | Not started |
| R-035 | P2 | Native desktop application using reusable core | future | Not started |
| R-036 | P2 | GT7-specific mobile application using reusable core and collector connection | future | Not started |
| R-037 | P0 | Hardware and browser compatibility tested rather than assumed | 1-6 | Partial: manual protocol `docs/hardware-test-protocol.md`; no hardware evidence recorded yet. |

## What is mocked vs unimplemented (Phase 3)

- **Mocked:** MOCK input source (incl. a MOCK "follow the drill target" driver and injected overlap for hands-off sessions); MOCK GT7 collector server (`tests/mock-collector/`). All labelled MOCK.
- **Implemented, unverified on hardware / by listening / in real browsers' speech:** Gamepad adapter + diagnostics, optional calibration, GT7 WebSocket client (draft protocol), sonification (`audio/sonify`), speech announcer, keyboard/gamepad bindings, voice commands, session runner glue (`features/session`).
- **Verified only against MOCK (automated):** a 2-round guided timed session started by keyboard completes eyes-free with one overlap alert per episode (`tests/e2e/eyes-free.spec.ts`).
- **Unimplemented:** metrics, graphs, drill editor/catalog UX (Phase 4), collector-side WebSocket (Phase 5), release/SBOM/signing/deploy (Phase 6).

## Decisions changed vs spec

- Default branch `master`, not `main` (ADR 0001).
- License: Business Source License 1.1 (ADR 0002). Repository visibility still open.
