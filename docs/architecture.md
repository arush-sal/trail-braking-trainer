# Architecture

```text
apps/web (React + TS)                          core (Go -> WASM)
  input/* adapters --InputFrame--> wasm/sessionBridge.ts
                                     | observe(batch) -> tick(now) -> snapshot(now)
                                     v  at a fixed cadence (60 Hz), JSON strings
                              tbtCore.api  (cmd/wasm, glue only)
                                     v
                              api.Runner  --> session.Session (state machine)
                                          --> engine detectors (overlap,
                                              fluctuation, completion, primary)
                                          --> drills (validation, TargetAt)
  audio / speech / controls  <-- typed events + Snapshot (subscribe/getSnapshot)
```

Ownership (spec 8): Go core owns drill/session determinism and metrics;
TypeScript adapters own Gamepad/WebSocket/speech/audio; React owns views.
`sessionBridge.ts` is the **single bridge facade**: React, audio and the
command dispatcher read state from its `Snapshot` and events and never run
their own session state machine. No backend, no storage of session
telemetry. Target layout: spec section 9.

## WASM loading and caching

`scripts/build-wasm.sh` writes `core.wasm` and the toolchain's `wasm_exec.js`
to `apps/web/public/wasm/` (served as-is by `vite dev`, read by
`make test-wasm`). For builds, `apps/web/vite/wasmAssets.ts` emits both as
content-hashed `assets/wasm_exec-<sha256/16>.js` and `assets/core-<sha256/16>.wasm`,
bakes those URLs into the app JS (`import.meta.env.VITE_*_URL`) and removes the
unhashed `dist/wasm/`. So each `index.html` -> app JS -> runtime + core chain is
fixed by content, and everything under `/assets/` is cached immutably; only
`index.html` and `version.json` revalidate (`apps/web/public/_headers`). An
old tab keeps its own consistent set; if a deploy removed those files, the core
load fails with an alert that asks for Retry or a reload. Retry reuses an
already-loaded `wasm_exec.js` (it is the same hashed file for this page) but
always re-fetches `core.wasm` into a fresh `Go` instance.

## Session runner (Phase 3 glue)

`features/session/sessionRunner.ts` wires the bridge to audio, speech and
commands; it holds no session state (it reads `Snapshot` every step):

- Frames: every frame from the active source (unavailable/stale included)
  -> `bridge.pushFrame`; the latest frame is also kept for audio.
- Each bridge step: events -> `SonifyEngine.alert` (`overlapOnset`,
  `fluctuation`, round start/end, session complete, entering `SOURCE_LOST`)
  and announcer phrases (countdown, Go, round outcome, session summary,
  source lost/restored; overlap is never spoken). Then an `AudioScene` from
  the snapshot (`primary`, `controls`, timed `target` -> desired, self-paced
  `terminalTargets`) + latest frame (`nowMs = receivedMonoMs`) ->
  `SonifyEngine.update` while COUNTDOWN/ACTIVE/REST; silence otherwise.
- Source safety: no frame for > 250 ms, a stale or gap frame, or a required
  channel unavailable while running -> `sourceLost` command once; first
  good frame while `SOURCE_LOST` -> `sourceRestored`. Stale input is never
  sonified. (The core itself also invalidates ACTIVE attempts on bad frames.)
- Commands: one `createDispatcher`; `allowed()` from `snapshot.state`, sink
  -> `bridge.command` (`complete`/`skip` -> `completeRound`/`skipRound`);
  `start` outside PREPARE first calls `bridge.start(setup)` with the axes the
  live source provides. Rejections (state or core error) are spoken.
- Speech start/end -> `SonifyEngine.duck` + voice `suppress`/`release`.

`app/services.ts` owns one `SonifyEngine`, announcer, voice and binding set
(keyboard on `window`; gamepad command buttons from a separate poll that
runs only while a button is bound or being learned, whatever the training
source; the Devices panel only supplies training mappings so those inputs
cannot be bound as commands). Voice "stop" asks for confirmation aloud.
Source restore needs 3 consecutive good frames received after the loss.
Only the `--mode e2e` build exposes `window.__tbtTest` (bounded phrases,
alerts with AudioContext scheduling/latency, events, snapshot, audio
stats); `make test-e2e` builds `--mode e2e` into `dist-e2e` for Playwright
and fails if the production `dist` contains the hook.

## Bridge contract (API v1, ADR 0007)

`tbtCore.api` methods, all JSON strings in and out, mapping 1:1 onto
`core/api.Runner`:

| JS | Go | Returns |
|---|---|---|
| `start(cfgJson)` | `Start` | `Result` |
| `command(name, nowMs)` | `Command` | `Result` |
| `tick(nowMs)` | `Tick` | `Result` |
| `observe(framesJsonArray)` | `ObserveJSON` | `Result` |
| `snapshot(nowMs)` | `Snapshot` | `Snapshot` |
| `presets()` | `Presets` | `PresetsInfo` |
| `validateDrill(drillJson)` | `ValidateDrill` | `Result` |

`tbtCore.version()` and `tbtCore.validateFrame()` are unchanged.

- **Start config:** `{apiVersion: 1, availableAxes, fluctuationAlerts?,
  noiseFloor?}` plus either freeform `{controls, session?}` or guided
  `{drill, completion?}`. Freeform `session` fields default to
  `session.DefaultConfig`; `requiredAxes` is always the selection. Guided
  rounds/rest/countdown/timing/round duration come from the drill;
  `completion` (self-paced only) defaults to `either`. Unknown fields,
  `B+T` selections and controls missing from `availableAxes` are rejected.
  `start` is refused while a session is running (stop first) and always
  builds a new session with fresh detectors.
- **Result:** `{apiVersion, events[], outOfOrder?, invalid?, frameError?,
  eventsDropped?, error?}`. At most 1024 events per call.
- **Events** (`kind` + `atMs`): `stateChanged{from,to}`,
  `countdown{round,remaining}`, `roundStarted{round}`,
  `roundEnded{round,outcome}`, `sessionComplete`,
  `overlapOnset{brake,throttle}` (R-010, ACTIVE frames only),
  `fluctuation{axis}` (R-013, only when enabled, ACTIVE frames only),
  `primaryChanged{axis}` (R-011).
- **Snapshot:** `{apiVersion, state, mode, controls, round, rounds,
  roundsDone, primary, elapsedMs?, target?, selfPaced?, terminalTargets?,
  tolerance?}`. `target` (from `drills.TargetAt`) only for timed guided
  drills while an attempt is open; self-paced drills never get one (spec
  3.4), only `terminalTargets` and `selfPaced: true`.
- **Ordering:** frames older than the session clock are dropped and
  counted (`outOfOrder`), invalid frames dropped and counted (`invalid`);
  a batch never fails as a whole. The TS bridge sends `observe` before
  every `tick` and `command`.
- **Commands:** `start`, `pause`, `resume`, `completeRound`, `skipRound`,
  `stop`, plus source reports `sourceLost`, `sourceRestored`.
- **Input coverage:** while ACTIVE the core needs a valid frame at least
  every `session.maxFrameGapMs` (default 100 ms); otherwise the attempt
  becomes `invalidSourceLost` (SOURCE_LOST). Overlap/fluctuation alert state
  resets on every state change.
