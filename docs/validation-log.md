# Validation log

Evidence for hardware, browser, and GT7 behavior (spec 11.2, R-037). Nothing
here is verified until an entry with evidence exists.

| Date | Item | Context (OS / browser / device / firmware) | Observation | Evidence | Status | Next action |
|---|---|---|---|---|---|---|
| 2026-11-14 | Fanatec model (CSL DD vs ClubSport DD+) | - | Not identified | - | Open | Confirm during Phase 1 manual test |
| 2026-11-14 | Logitech G923 axes/rates | - | Not tested | - | Open | Phase 1 diagnostics capture |
| 2026-11-14 | Steering units / training range | - | Unresolved | - | Open | Measure on hardware before defining scale |
| 2026-11-14 | GT7 driver steering input | - | Not verified in collector; `wheel_rotation` unconfirmed | - | Open | Keep `steering.available=false` for GT7 |
| 2026-11-14 | Hidden-tab / background polling + audio | - | Not tested | - | Open | Phase 1 spike |
| 2026-11-14 | SpeechRecognition support / privacy | - | Not tested | - | Open | Phase 1/3 feature detection |
| 2026-11-14 | HTTPS -> LAN ws:// permission | - | Not tested | - | Open | Phase 1 spike with mock server |
| 2026-11-14 | GitHub attestations on repo plan/visibility | - | Visibility undecided | - | Open | Decide before Phase 6 |
| 2026-11-14 | Pedal default range (axis rests at -1, full at +1; button pedal 0..1) | Code default, no device | Assumption only; many pedals rest at +1 and need invert | - | Open | T1/T3 in hardware-test-protocol.md |
| 2026-11-14 | Steering default center (axis 0, button 0.5), signed [-1,1] | Code default | Provisional (ADR 0003) | - | Open | T1 on Fanatec + G923 |
| 2026-11-14 | Auto-detect threshold 0.25 | Code default | Guess | - | Open | Tune during T1 |
| 2026-11-14 | Chrome `Gamepad.timestamp` only changes on state change | - | Assumed; adapter emits a frame per poll regardless | - | Open | T2 |
| 2026-11-14 | Audio control-update latency | Fake AudioContext only | Not measured on hardware; acoustic latency needs loopback | - | Open | T6 |
| 2026-11-14 | WASM load + call overhead | Linux, headless Chromium (Playwright 1.65), preview server, no device | Load ~139 ms; validateFrame (JSON + JS->Go + decode) mean ~374 us, p95 ~700 us (coarse timer) | Agent run of `make test-e2e` + benchmark | Measured (synthetic) | Re-measure on target machines; batch calls if needed |
| 2026-11-14 | GT7 WS from HTTPS page to ws://127.0.0.1 and ws://LAN (Chrome LNA prompt, Firefox, Safari) | MOCK server only | Not tested in a real browser | - | Open | T8; checklist in docs/input-protocol.md |
| 2026-11-14 | `navigator.permissions.query({name:'local-network'})` support | - | Not queried by prototype | - | Open | T8 |
