# Requirements ledger

Source: spec section 2. Status reflects the repository, not intent.
Statuses: Not started / Partial / Done. "Mock" means implemented only against the mock source.

| ID | Priority | Requirement | Target phase | Status |
|---|---|---|---|---|
| R-001 | P0 | Browser-first, no trainer application backend required for direct hardware use | 0-1 | Partial: static bundle, no backend; served with security headers (`apps/web/public/_headers`). Hardware path implemented but unverified. |
| R-002 | P0 | Go core compiled to WASM; React + TypeScript frontend; browser APIs remain in TypeScript adapters | 0-2 | Partial: Go core WASM loaded in browser via `coreBridge` facade; contract fixtures checked in Go and via built WASM (`make test-wasm`). |
| R-003 | P0 | Read actual B/S/T controls from browser Gamepad API when available | 1 | Partial (unverified on hardware): Gamepad adapter reads axes + analog buttons, per-control device mapping, diagnostics screen. |
| R-004 | P0 | GT7 collector supported through its new optional WebSocket endpoint; separate repo | 5 | Partial: client consumes the collector-owned `gt7.inputs.v1` from gt7-telemetry-collector v0.3.0 (ADR 0011, supersedes ADR 0005); verified against all v0.3.0 contract fixtures/transcripts and a MOCK collector (Node + Chromium/Firefox/WebKit e2e). Not yet verified against a live PS5, from an HTTPS page, over LAN/`wss://`, or in Safari. |
| R-005 | P0 | Correct availability flags: never pass unverified vehicle measurements off as user steering | 1-5 | Partial: Go `Decode` + UI keep null as n/a; GT7 client forces steering unavailable regardless of collector claims. |
| R-006 | P0 | Freeform practice without a desired target | 3-4 | Partial (mock): freeform session (any legal selection, timed rounds) with continuous sonification of the selected controls via `SessionPanel` + `sessionRunner`; driven only by MOCK in automated tests. Freeform metrics/stats = Phase 4. |
| R-007 | P0 | Guided practice via presets and parameter-based drills | 4 | Done (mock-verified): preset catalog (`features/drills/presets.ts`) + parameter drill editor, validated by the core before Start (Start is refused aloud while a drill is invalid or validating). Preset values are PROPOSED examples, not coaching advice. |
| R-008 | P0 | Select B, S, T, B+S, S+T, or B+S+T; no B+T-only selection | 2 | Done (core): `drills.ValidateSelection` accepts only contiguous B/S/T ranges; B+T rejected. UI = Phase 4. |
| R-009 | P0 | Desired B and T never simultaneously positive; optional steering-only and coast phases | 2 | Done (core): `drills.Validate` rejects any desired B/T overlap; property + fuzz tested; coast/steering-only phases supported. |
| R-010 | P0 | Actual B+T overlap generates immediate distinctive warning; round continues | 2-3 | Partial (mock): core `OverlapDetector` onset -> `sessionRunner` -> immediate `overlap` audio alert (alert bus, not ducked, never spoken); e2e `eyes-free.spec.ts` shows one alert per injected MOCK episode and the round completes normally. Sound design unverified in listening tests. |
| R-011 | P0 | Primary audio input follows new/later control: B then S then T; other channels are still monitored | 2-3 | Partial (mock): core `GuidedPrimary`/`FreeformPrimary` -> `snapshot.primary` -> `AudioScene.primary` (foreground voice). Unit-tested pass-through; perceptual priority unverified in listening tests. |
| R-012 | P0 | Audio represents input position, movement direction, movement rate, and smoothness | 3 | Partial (unverified): `SonifyEngine` maps position, movement direction/rate (partial) and jitter (roughness) per voice, fed live by `sessionRunner`. All constants PROPOSED; no listening test recorded. |
| R-013 | P0 | Optional, toggleable unwanted-fluctuation alerts; rapid intentional changes not categorically wrong | 3 | Partial (unverified): optional `fluctuationAlerts` toggle in session setup -> core `FluctuationDetector` -> `fluctuation` alert. Thresholds PROPOSED; no hardware/listening evidence. |
| R-014 | P0 | Guided drills offer user-selectable dual tones or deviation-based feedback | 3 | Partial (unverified): guided timed sessions choose dual tone or deviation audio (`SessionPanel`), self-paced uses the terminal end-state cue only (no fabricated live target). Listening tests pending. |
| R-015 | P0 | Spoken instructions, countdowns and summaries plus reference tones; voice summary can be disabled | 3 | Partial (unverified): announcer speaks exercise/config, countdown, round outcome and session summary (each category can be switched off in Controls); tones duck during speech. Phrases asserted in e2e via test hook; actual browser speech output not verified. |
| R-016 | P0 | Time-based and self-paced drills | 2-4 | Done (mock-verified): timed and self-paced guided drills run end to end; timed compared on actual time, self-paced on normalized progress (`ShapeAt`) with timing N/A (e2e `drills.spec.ts`). |
| R-017 | P0 | Automatic final-state detection **and** manual completion for self-paced drills | 2 | Partial: core auto/manual/either completion + `complete` command reachable by keyboard (Enter), learned gamepad buttons, voice ("done"), and UI through one dispatcher. Hardware buttons and voice unverified. |
| R-018 | P0 | Voice commands **and** configurable keyboard/wheel/controller button mappings | 3 | Partial (unverified): one dispatcher (`controls/dispatcher.ts`) for keyboard (defaults G/Space/Enter/S/Escape, rebindable with conflict checks), learned gamepad buttons (own poll, independent of the training source; training inputs refused) and browser SpeechRecognition (privacy notice, stop confirmation, suppressed while the app speaks). Keyboard start/pause/resume/complete/skip/stop verified in e2e (MOCK); gamepad buttons and voice not verified on hardware/browsers. |
| R-019 | P0 | Repeated rounds in one session: configurable count, default **8** | 2 | Done (core): session rounds default 8, configurable 1..100. |
| R-020 | P0 | Configurable rest and countdown; automatic next round without checking input reset | 2 | Done (core + mock e2e): rest/countdown configurable in session setup (5 s/3 s proposed defaults from core presets); rounds auto-advance without input reset. |
| R-021 | P0 | Distinct Hold, Full-range Linear Sweep, Progressive Curve, and Multi-stage drill types | 2-4 | Done (mock-verified): hold, full-range sweep, progressive and multistage presets each complete in e2e with desired-vs-actual graphs per selected channel. |
| R-022 | P0 | Progressive curves use adjustable presets; no mandatory hand-drawn curve editor | 2-4 | Done (mock-verified): curve presets (linear, easeIn, easeOut, easeInOut) with intensity in the editor; setup preview sampled by the core (`previewSamples`). No hand-drawn editor. |
| R-023 | P0 | Beginner/intermediate/advanced presets plus per-control and per-drill precision overrides | 4 | Partial: beginner/intermediate/advanced presets + per-control and per-drill tolerance overrides in the editor. Preset values PROPOSED; not validated with users. |
| R-024 | P0 | Independent accuracy/smoothness/timing/consistency metrics; no combined total | 4 | Partial: separate accuracy, smoothness, timing and consistency metrics in `core/metrics` with documented formulas (`docs/metric-definitions.md`) and fixture tests (`core/metrics/testdata/fixtures_v1.json`); no combined total anywhere. Thresholds/filters PROPOSED, not validated on hardware data. |
| R-025 | P0 | Preserve per-round input telemetry and plot desired vs actual for each selected input after drills | 4 | Done (mock-verified): per-round traces kept in memory (full resolution in Go; UI gets downsampled display traces by default) and plotted desired vs actual per selected channel with gaps for invalid data, zoom, overlays and a table view. Discarded on reset/reload. |
| R-026 | P0 | Optional spoken performance feedback and post-session improvement suggestions only; no automatic difficulty changes | 4 | Partial: optional spoken round/session summaries from the core metrics (Spoken feedback toggle + announcer categories), concise for eyes-free use; recommendations are suggestions only and apply to the next session only after explicit confirm. Real browser speech unverified. |
| R-027 | P0 | Current-session data only, no retained historical results | 0-4 | Partial (mock-verified): no storage/backend; Phase 6 review found no localStorage/sessionStorage/IndexedDB/service worker/cookies/beacons in source or production bundle, and CSP blocks third-party connections except the Cloudflare Web Analytics beacon (production only, page-load metrics, no session data; ADR 0009) (`docs/security.md`). Results discarded on reload/reset. |
| R-028 | P0 | Calibration is optional; ability to set mapping, inversion, min/max, neutral, deadzone | 1 | Partial (unverified on hardware): optional mapping, inversion, range capture, center, deadzone. |
| R-029 | P0 | Source/connection loss and permission failures are audible and do not yield false success scores | 1-3 | Partial (mock-verified): device loss -> n/a; WS stale; session SOURCE_LOST invalidates attempt (retry cap 3) with audible alert + critical speech and `sourceRestored` on recovery (e2e: MOCK stopped mid-round). Phase 6 adds spoken permission/failure cues: microphone denied / voice error / speech service unreachable, session audio suspended/interrupted (spoken via speech synthesis), and start refused with the reason (missing channel e.g. GT7 steering, no live input). Every spec 8 failure has a visible recovery path (`docs/security.md` table; unit tests + e2e `recovery.spec.ts`: WASM load failure + Retry, failed app script, no gamepad). Not exercised on hardware or with real permission prompts. |
| R-030 | P0 | Go Modules + npm workspace dependency management; deterministic builds | 0 | Done (baseline): `core/go.mod`, npm workspaces + lockfile, `make setup` uses `npm ci` + `go mod verify`. |
| R-031 | P0 | GitHub Actions tests, static analysis, security scanning, SBOM, signing, provenance | 0-6 | Partial: CI runs make lint/test/build/test-wasm/test-e2e; security scans; CodeQL enabled (public repo). Phase 6: `release.yml` adds Syft SPDX SBOMs, Cosign keyless bundles, GitHub provenance/SBOM attestations, in-job verification (not yet run on a real tag). |
| R-032 | P0 | Version tags from `main` create GitHub Releases; Cloudflare Pages deploys the exact release bundle | 6 | Partial: tag -> gates -> build once -> GitHub Release -> deploy job verifies Release assets; `scripts/deploy.sh` deploys the verified bundle to Cloudflare Workers Static Assets via `cf` (ADR 0008; replaces Pages wording); rollback workflow. Not yet exercised by a real tag. See `docs/release-process.md`. |
| R-033 | P1 | Record-and-repeat custom target (advanced, later) | future | Not started |
| R-034 | P1 | Live visible target trace (optional advanced enhancement; post-session trace is P0) | future | Not started |
| R-035 | P2 | Native desktop application using reusable core | future | Not started |
| R-036 | P2 | GT7-specific mobile application using reusable core and collector connection | future | Not started |
| R-037 | P0 | Hardware and browser compatibility tested rather than assumed | 1-6 | Partial: manual protocol `docs/hardware-test-protocol.md`; automated e2e matrix (Chromium; Firefox/WebKit in CI) covers MOCK paths only. CSP verified in headless Chromium + Firefox (`tests/e2e/csp.spec.ts`). **No hardware or real-browser manual evidence recorded yet**: every wheel/pedal/browser/GT7 claim stays unverified until the final manual run. |

## Spec 13 agent completion checklist (status 2026-11-14)

"Mock" = automated against the MOCK source only. No item is verified on hardware or by a listening test.

| Checklist item | Status | Evidence / gap |
|---|---|---|
| Freeform and guided practice work; audio alone is sufficient for baseline sessions | Partial (mock) | e2e `eyes-free.spec.ts`, `drills.spec.ts`; no listening test |
| All permitted B/S/T selections work; B+T only is disallowed | Done (core + UI) | `drills.ValidateSelection`, freeform selector |
| All generated desired curves satisfy zero brake/throttle overlap | Done (core) | property + fuzz tests |
| Actual overlap causes immediate audio warning and does not restart a drill | Partial (mock) | e2e overlap episode; sound unverified by listening |
| Primary audio follows B->S->T control handoffs | Partial | core + unit tests; perceptual priority unverified |
| Continuous audio conveys position and movement; optional explicit fluctuation warnings | Partial | implemented; constants PROPOSED, no listening test |
| Guided dual-tone and deviation-based audio available | Partial | implemented; no listening test |
| Hold, full-range sweep, progressive curves and multi-stage drills | Done (mock) | e2e `drills.spec.ts` |
| Timed/self-paced modes; automatic and manual self-paced completion | Done (mock) | e2e + core tests |
| Eight rounds default; configurable rest/countdown; automatic progression | Done (core + mock e2e) | |
| Voice + configurable button commands; safe fallbacks and permission warnings | Partial | keyboard verified in e2e; voice/gamepad buttons unverified; permission failures shown + spoken (Phase 6) |
| Independent metrics and session-only graphs; no overall score or saved history | Done (mock) | metrics fixtures; storage review in `docs/security.md` |
| Calibrate on request, not mandatory; missing input channels are marked unavailable | Partial | implemented; unverified on hardware |
| Collector WS is optional, secure, versioned, and backward compatible | Not done | trainer client only; collector endpoint = separate repo (Phase 5) |
| CI checks both Go Modules and npm; scans, signed SBOMs, provenance and protected tag release | Partial | see R-031/R-032; not yet run on a real tag |
| Cloudflare deploy uses exactly the GitHub Release's tested static artifact | Partial | see R-032; not yet exercised |
| No claims about Fanatec, Logitech, browsers, or GT7 steering without live evidence | Holding | README/UI state everything unverified; GT7 steering unavailable |

## What is mocked vs unimplemented (Phase 3)

- **Mocked:** MOCK input source (incl. a MOCK "follow the drill target" driver and injected overlap for hands-off sessions); MOCK GT7 collector server (`tests/mock-collector/`). All labelled MOCK.
- **Implemented, unverified on hardware / by listening / in real browsers' speech:** Gamepad adapter + diagnostics, optional calibration, GT7 WebSocket client (draft protocol), sonification (`audio/sonify`), speech announcer, keyboard/gamepad bindings, voice commands, session runner glue (`features/session`).
- **Verified only against MOCK (automated):** a 2-round guided timed session started by keyboard completes eyes-free with one overlap alert per episode (`tests/e2e/eyes-free.spec.ts`).
- **Verified only against MOCK (automated, Phase 4):** hold, sweep, progressive and multistage timed presets, a self-paced preset and a freeform session complete and render results (`tests/e2e/drills.spec.ts`).
- **Unimplemented:** collector-side WebSocket (Phase 5), release/SBOM/signing/deploy (Phase 6).

## Decisions changed vs spec

- Default branch `master`, not `main` (ADR 0001).
- License: Business Source License 1.1 (ADR 0002). Repository visibility still open.
