# Trail Braking Trainer
## Complete implementation specification and AI coding-agent handoff

**Status:** Implementation-ready specification with explicit hardware validation gates  
**Date:** 13 November 2026  
**Primary delivery:** Browser-only training application  
**Companion repository:** `github.com/arush-sal/gt7-telemetry-collector`  
**Intended implementers:** Codex / Claude Code, working in reviewed phases

> **Non-negotiable product statement:** Build a muscle-memory trainer for precise, smooth, repeatable **brake, steering, and throttle input**. Do not build a racing line advisor, corner recommendation system, lap-time optimizer, physics simulator, or GT7 Race Engineer integration. The user defines the desired input pattern. The application measures the actual input, makes errors audible, and helps the user reduce the difference through practice.

---

# 0. Instructions to the coding agent

1. Treat the **Confirmed requirements** below as the source of truth. Treat **Proposals / defaults** as changeable design choices and **Validation gates** as unknown until tested. Do not quietly promote a guess into a requirement.
2. Read the existing collector repository before editing it. Preserve its existing UDP ingest, decryption, transport modes, public API, release policy, and normal behavior. Add browser streaming as an opt-in, backward-compatible capability.
3. Implement **one phase at a time**, ending each phase with passing tests, an evidence-based review, updated documentation, and a concise completion report. Never represent untested wheel or browser behavior as verified.
4. The primary agent is the orchestrator. It may delegate independent, bounded work to subagents chosen for complexity. It must integrate their outputs, run the full phase test suite, and have Codex/Claude peer-review the completed **phase**, not each trivial subtask. Resolve findings before advancing. Do not merge conflicting modifications blindly.
5. Prefer conventional, maintainable solutions. Avoid introducing services, databases, orchestration, analytics, auth accounts, or dependencies that the browser-only application does not need.
6. Preserve traceability: every implementation issue/PR should reference requirement IDs and acceptance criteria. Put open test questions in `docs/validation-log.md` with observed evidence, machine/browser/controller context, and next action.
7. The user is planning and delegating engineering work. Do not create external repositories, publish releases, change Cloudflare resources, or modify the existing collector without the required permissions and explicit execution instructions. This specification authorizes planning, not arbitrary deployment.

# 1. Product scope and success criteria

## 1.1 Confirmed product principles

- **Standalone skill builder.** Independent of the separate GT7 Race Engineer project.
- **Train inputs, not cars.** Care only about user-controlled brake (B), steering (S), and throttle (T). The trainer does not interpret wheel angle, vehicle rotation, racing line, grip, apex strategy, track, car, or weather.
- **Source-agnostic semantics.** Train against the supported user-input signal from the selected source, without attempting cross-source physical equivalence. Do **not** substitute front wheel steering angle, vehicle yaw, or other dynamics for actual steering input.
- **Audio-first and screen-optional in use.** Beginner training must work with eyes away from the display. Setup and post-session review may use a screen.
- **Skill progression.** Precise and controlled at slow speeds first, then faster execution without loss of control. Deliberate fast movement is not inherently a mistake.
- **No overall performance score.** Report accuracy, smoothness, timing (when relevant), and consistency separately.
- **No permanent training history.** Keep current session results and input traces in memory. Do not create a backend, account system, results database, automatic analytics uploads, or cross-session training history.
- **User discretion.** Choose practice modes, feedback presentation, drill patterns, difficulty presets and overrides, timing mode, control selection, and rounds. Never auto-increase difficulty; suggest changes after analysis.

## 1.2 Core success scenarios

**S1. No-display pedal practice:** User connects a wheel/pedal set, selects brake freeform practice, hears input position and movement, optionally enables fluctuation warnings, and practices without watching the UI.

**S2. Guided hold:** User selects a preset, configures e.g. 40% brake with adjustable tolerance, performs eight automatically repeated rounds, hears instruction and reference/deviation audio, and reviews per-round accuracy and smoothness.

**S3. Combined trail-braking drill:** User chooses B+S+T, configures a legal sequence with B+S and S+T overlap and optional steering-only/coast phases. The newly introduced control becomes the primary audio focus. Brake and throttle never overlap in the **desired** sequence; if the **actual** inputs overlap, play an immediate warning without stopping or resetting the attempt.

**S4. Self-paced learning:** User completes a non-timed progressive curve at their own pace. The round completes on a valid final-state hold or a mapped button/voice command. Scoring does not invent a timing penalty.

**S5. GT7 input:** A browser connects as consumer to an extended, separately running Go GT7 collector over WebSocket. It trains on verified input channels that collector actually provides. If verified driver steering is unavailable, the trainer marks steering unavailable and does not fabricate it.

**S6. Release integrity:** A protected version tag referencing `main` produces tests, security gates, a static bundle, SBOMs, checksums, signatures, attestations, GitHub Release, and deployment of the **identical** tested artifact to Cloudflare Pages.

# 2. Requirements ledger

| ID | Priority | Requirement / acceptance intent |
|---|---|---|
| R-001 | P0 | Browser-first, no trainer application backend required for direct hardware use |
| R-002 | P0 | Go core compiled to WASM; React + TypeScript frontend; browser APIs remain in TypeScript adapters |
| R-003 | P0 | Read actual B/S/T controls from browser Gamepad API when available |
| R-004 | P0 | GT7 collector supported through its new optional WebSocket endpoint; separate repo |
| R-005 | P0 | Correct availability flags: never pass unverified vehicle measurements off as user steering |
| R-006 | P0 | Freeform practice without a desired target |
| R-007 | P0 | Guided practice via presets and parameter-based drills |
| R-008 | P0 | Select B, S, T, B+S, S+T, or B+S+T; no B+T-only selection |
| R-009 | P0 | Desired B and T never simultaneously positive; optional steering-only and coast phases |
| R-010 | P0 | Actual B+T overlap generates immediate distinctive warning; round continues |
| R-011 | P0 | Primary audio input follows new/later control: B then S then T; other channels are still monitored |
| R-012 | P0 | Audio represents input position, movement direction, movement rate, and smoothness |
| R-013 | P0 | Optional, toggleable unwanted-fluctuation alerts; rapid intentional changes not categorically wrong |
| R-014 | P0 | Guided drills offer user-selectable dual tones or deviation-based feedback |
| R-015 | P0 | Spoken instructions, countdowns and summaries plus reference tones; voice summary can be disabled |
| R-016 | P0 | Time-based and self-paced drills |
| R-017 | P0 | Automatic final-state detection **and** manual completion for self-paced drills |
| R-018 | P0 | Voice commands **and** configurable keyboard/wheel/controller button mappings |
| R-019 | P0 | Repeated rounds in one session: configurable count, default **8** |
| R-020 | P0 | Configurable rest and countdown; automatic next round without checking input reset |
| R-021 | P0 | Distinct Hold, Full-range Linear Sweep, Progressive Curve, and Multi-stage drill types |
| R-022 | P0 | Progressive curves use adjustable presets; no mandatory hand-drawn curve editor |
| R-023 | P0 | Beginner/intermediate/advanced presets plus per-control and per-drill precision overrides |
| R-024 | P0 | Independent accuracy/smoothness/timing/consistency metrics; no combined total |
| R-025 | P0 | Preserve per-round input telemetry and plot desired vs actual for each selected input after drills |
| R-026 | P0 | Optional spoken performance feedback and post-session improvement suggestions only; no automatic difficulty changes |
| R-027 | P0 | Current-session data only, no retained historical results |
| R-028 | P0 | Calibration is optional; ability to set mapping, inversion, min/max, neutral, deadzone |
| R-029 | P0 | Source/connection loss and permission failures are audible and do not yield false success scores |
| R-030 | P0 | Go Modules + npm workspace dependency management; deterministic builds |
| R-031 | P0 | GitHub Actions tests, static analysis, security scanning, SBOM, signing, provenance |
| R-032 | P0 | Version tags from `main` create GitHub Releases; Cloudflare Pages deploys the exact release bundle |
| R-033 | P1 | Record-and-repeat custom target (advanced, later) |
| R-034 | P1 | Live visible target trace (optional advanced enhancement; post-session trace is P0) |
| R-035 | P2 | Native desktop application using reusable core |
| R-036 | P2 | GT7-specific mobile application using reusable core and collector connection |
| R-037 | P0 | Hardware and browser compatibility tested rather than assumed |

**Meaning of P0/P1/P2 here:** P0 is the agreed initial product scope, with some P0 platform capabilities gated on hardware/browser feasibility. P1 is enhancement; P2 is a future platform project. Do not silently omit P0 features from the release; report blocked features explicitly when a validation gate fails.

# 3. UX and training behavior

## 3.1 Modes

**Freeform:** No desired target. Select one or a legal contiguous group of controls. Always emit input sonification. Add optional fluctuating-input alerts. May show actual traces and descriptive smoothness/movement statistics, but **accuracy to a desired curve is N/A**. Freeform practice must not claim a predefined goal.

**Guided:** Uses a preset or parameter-defined target with one or more input trajectories. Emits instructions and chosen target audio. Evaluates actual versus desired over the exercise. No mandatory visible graph during operation.

## 3.2 Allowed combinations and phase rules

Ordered controls: `B -> S -> T`. Valid selections are contiguous ranges `[B]`, `[S]`, `[T]`, `[B,S]`, `[S,T]`, `[B,S,T]`. Explicitly reject `B+T` as a selected pair. During B+S, primary = S; during S+T, primary = T. For a full B+S+T sequence the phase owner moves forward in that order, not via whichever control currently has the numerically largest magnitude. The primary designation should not bounce rapidly when values hover near zero.

Typical *illustrative*, non-mandatory phase pattern: `B -> B+S -> S -> S+T -> T`. Also legal: B+S transitioning directly to S+T when B reaches zero and T begins, without requiring an artificial steering-only duration; coast and steering-only phases may be deliberately inserted. User owns the pattern. Do not infer a correct corner strategy.

**Hard invariant for desired target:** at no scheduled instant may B and T both exceed target-zero tolerance. Validate every phase boundary and interpolation segment before allowing the drill to start. Use `B=0` before allowing `T>0`, not overlapping linear ramps due to smoothing. Preserve the full, unsuppressed **actual** values, flag an overlap when both exceed noise-adjusted activation thresholds, sound one immediate alert on entry, and re-arm on exit using hysteresis/cooldown. Do not punish an overlapping input by silently overriding throttle as some training references do.

## 3.3 Drill catalog

1. **Hold**: Reach a target level and maintain it for a target duration (timed) or until valid completion (self-paced). Track drift, settling, mean offset, and oscillation separately.
2. **Full-range linear sweep**: Simple straight-line targets primarily for 0-to-100 or 100-to-0 motions (and sign-aware steering when validated). It is a target, not a demand for humanly perfect mathematical linearity. Do not make arbitrary-range linearity the sole measure of motor skill.
3. **Progressive curve**: Parameterized presets such as fast-start/gentle-finish, gentle-start/fast-finish, and smooth-start-and-finish. Configure start/end, direction, intensity and, for timed drills, duration. Use deterministic, documented curve functions (e.g. eased interpolation), not undocumented hardcoded sample points.
4. **Multi-stage**: A configured sequence of holds, ramps, and control handoffs with per-phase targets and optional coast. Permit the user to adjust phase order only within the B→S→T rules and target B/T exclusion.

**Future P1:** Record a control trace, turn it into a repeatable reference after optional cleanup/normalization, and replay it as a target. This requires a distinct acceptance process; not silently in v0.1.

## 3.4 Target authoring

Preset selection is the beginner path. Parameter-based customization exposes control subset, drill type, start/end/hold values, curve profile/intensity, timing mode, tolerance, rounds, rest, countdown, warning toggle, audio mode, and feedback toggle. Show an optional setup preview. All generated targets must be validated and should be deterministic from a `DrillDefinition` plus its selected timing/profile settings.

For **time-based** drills, desired values are a function of elapsed exercise time. Evaluate shape, endpoint, and transition timing independently.

For **self-paced** drills, elapsed duration is **not** scored as timing error, but desired-vs-actual comparison requires care:

- On a single-axis moving target, there is no objectively defined *instantaneous desired position* without a reference clock or progress signal. Do **not** pretend that one exists or produce misleading live delta tones. During such movement, give position/movement/smoothness audio, direction/end-state guidance, and optional milestone cues. At the end, align actual elapsed time to `[0,1]` over **the measured round duration** and compare the executed curve's shape to the desired normalized-time profile. Total duration is reported descriptively, not penalized. Do not use actual input position as its own target-progress coordinate, which would produce tautological perfect accuracy.
- For combined-control self-paced patterns, phases and relative coordination can be compared using configured milestones and, where monotonic and meaningful, a specifically documented primary-control progress parameter. Compare secondary input to the relative-position target. Treat reversals, stalls, and skipped landmarks as data, not details to erase by alignment.
- There is no exact continuously moving reference tone for the full trajectory until its reference time is defined. Self-paced guided feedback must be honest about this limitation. A user who wants continuous instantaneous *desired vs actual* delta on a dynamic curve can select **time-based mode**.
- Retain original timestamps, pause/hold events, source gaps, and signal direction changes. Consider constrained dynamic-time-warping only as a future, tested refinement; it must not hide errors.


## 3.5 Session lifecycle

State machine: `IDLE -> PREPARE -> COUNTDOWN -> ACTIVE -> REST -> COUNTDOWN -> ... -> COMPLETE`. Include `PAUSED`, `ABORTED` and `SOURCE_LOST` handling. Only valid transitions are accepted. Make timers pause-aware and use a monotonic clock; avoid drift from chained setTimeouts.

Default rounds: **8** (within user's proposed 5–10 range). **Proposed, not yet fixed:** rest 5 seconds, start countdown 3 seconds; both configurable. Do not require controls to return to a start state between rounds. When countdown expires with an incorrect initial input, start the round, record that initial offset and score it appropriately. Never block the next round waiting for readiness.

Self-paced completion configuration: `auto`, `manual`, or `either`. `auto` requires all defined terminal controls within configured tolerance **continuously** for a configurable hold time, with hysteresis/debounce to prevent fly-through completion. `manual` completes via an input mapping or accepted voice command and records any remaining endpoint error. `either` supports both. Automatic completion is not equivalent to a perfect result. During source interruption, suspend or invalidate the attempt rather than inventing samples.

Core session commands: start, pause, resume, complete round, skip round, stop session. Implement **voice commands** and **configurable physical/keyboard buttons** through a single command dispatcher with state validation. A skip is not a completed valid attempt. Keep command controls separate from pedal/steering training input so accidental control motion cannot trigger session commands unless explicitly mapped.

## 3.6 End-of-round and session feedback

Optional verbal summary per completed round and at session end. Graphs are P0 post-round/session, not mandatory during driving. Show brake, steering, and throttle on separate aligned panels or an intelligible combined selector; each has desired and actual traces, units, phase boundaries, and the raw vs filtered distinction. Show each round, overlaid comparisons, and session trends. Do not make a graph that's visually attractive but unable to compare point for point.

Metrics separately: **accuracy, smoothness, timing (timed drills only), and repeatability/consistency across rounds**. Do not compute or display a composite grade. Explain units, direction of good/bad, sample coverage, and whether a metric is applicable. For self-paced drills, display timing as `N/A`, not 100%. For freeform, target accuracy is `N/A`. Difficulty recommendations are derived from this session only and never applied without user action.

# 4. Inputs, measurement, and normalization

## 4.1 Internal frame contract

Implement one source-independent input frame contract, but **do not assume** sources are physically equivalent. Proposed TypeScript representation (mirror semantics in Go; adjust exact serialization after ADR):

```ts
type Axis = 'brake' | 'steering' | 'throttle';
type InputSource = 'gamepad' | 'gt7' | 'mock';
type Measurement = {
  available: boolean;
  rawValue: number | null;
  rawUnit: string;
  normalized: number | null;
  calibrationId?: string;
};
type InputFrame = {
  schemaVersion: 1;
  source: InputSource;
  sourceId: string;
  sequence?: number;
  receivedMonoMs: number;
  sourceTimestampMs?: number;
  brake: Measurement;      // normalized [0,1] when supported
  steering: Measurement;   // signed and unit semantics unresolved until live validation
  throttle: Measurement;   // normalized [0,1] when supported
  quality: { gap: boolean; stale: boolean; calibrated: boolean };
};
```

The normalized **brake and throttle** scale can be `[0,1]` internally and displayed as 0–100%. Preserve raw values and original units. For **steering**, retain raw unit/mapping; define a signed practice scale or degrees **only after** device and collector tests. Never silently clamp missing values to zero. The training engine must declare which channels are available and reject drills requiring unavailable channels.

Use monotonic arrival timestamps for local control timing; retain source timestamps for diagnostics and jitter estimates. Track missing samples, duplicate sequences and reconnect events. Do not interpret a dropped sample as a deliberately steady input. Introduce a single sample ingestion boundary; React should not re-render once per hardware sample.

## 4.2 Browser Gamepad adapter

- Discover controllers through `gamepadconnected`/`gamepaddisconnected` and poll `navigator.getGamepads()` on a deliberately measured cadence.
- Inspect both `axes` and analog `buttons`. Offer per-control axis/button mapping, inversion, raw min/max capture, center/deadzone; user-initiated calibration is **optional**.
- Support separate devices for wheel and pedals where exposed. Track stable user selection while devices connect/disconnect; never silently remap to another controller.
- Detect noisy or drifting input and suggest optional calibration without forcing it.
- Provide an input diagnostics screen displaying device name/index, mappings, live raw values, normalized values, measured update frequency, and missed frames.
- Test foreground, unfocused window, hidden tab, full-screen game focus, and power-saving behavior. `requestAnimationFrame` may pause in hidden tabs; do not pretend background input is reliable without evidence. If reliability cannot be achieved, issue clear audible/visible limitation and determine a native-adapter path later.

## 4.3 GT7 collector WebSocket extension (separate repo)

**Existing behavior to preserve:** collector receives PS5 UDP frames, decrypts/decodes, and publishes canonical telemetry via configured gRPC, Unix, or HTTP streaming transports. WebSocket support must be additive and opt-in. Do not import the entire trainer or its Go engine into the collector.

**Proposed implementation:** optional read-only WebSocket endpoint on a configured local bind address/port, such as `/v1/inputs`. Browser initiates WebSocket connection; the collector publishes a bounded stream of input snapshots to subscribed clients. This is the browser acting as the *logical sink*, not a browser running an HTTP server. Keep collector push transport behavior unchanged and permit both modes concurrently where reasonable.

**Wire protocol v1**: versioned handshake with input channel availability/capabilities, followed by timestamped, sequenced frames. Only expose B/S/T, source identity, validity, timing and gap metadata; keep the original protobuf schema unchanged unless change is justified. Choose compact JSON initially or binary protobuf based on measured performance; document the choice in an ADR. Implement explicit readiness/heartbeat/disconnect semantics and bounded queues with drop-oldest plus gap signals, never unbounded buffering.

**Critical steering gate:** current collector protobuf confirms `brake` and `throttle` fields, but does **not** establish a verified physical driver steering input. `wheel_rotation` is described as unconfirmed; verified front-wheel angles measure vehicle output rather than controller input. Do not map either into steering for this trainer without physical signal validation. Expose `steering.available=false` until a genuine steering-command signal is verified. The browser must gracefully offer brake/throttle-only drills where feasible and explain the steering limitation.

**Network/security:** endpoint binds to loopback by default, with explicit LAN opt-in; check `Origin` against an allowlist; reject unsolicited browser origins; do not confuse CORS with WebSocket origin protection. Use a pairing/authorization mechanism for LAN use, prevent accidental internet exposure, throttle clients, cap frame size and connections, and avoid putting long-lived secrets into URLs. Document mixed-content/local-network permission behavior and WSS requirements. Some HTTPS-to-local `ws://` connections are supported only under recognized local addresses and browser permission rules; include tested connection examples instead of assuming universal compatibility. No telemetry should go to Cloudflare or another server as part of normal operation.

## 4.4 Input dropouts and source safety

On device disconnect, telemetry gaps, stale frames, lost WS, suspended audio context, or browser throttle: emit a distinct actionable warning, mark samples invalid, and pause/invalidate the affected round according to a documented policy. Do not silently extrapolate stale values into accurate scores. Reconnection must not overwrite the previous attempt. Background input limitations require a user-facing warning, not an invisible fallback.

# 5. Go core and WebAssembly boundary

Use **one Go module** at `core/go.mod`. Write deterministic, platform-neutral pure Go for drill definitions and validation, target generation, input comparison, state transitions, and metrics. No `syscall/js`, browser globals, file I/O, or networking in core domain packages.

Suggested Go packages:

- `core/input`: typed source-neutral frames, validity, units and noise handling.
- `core/drills`: presets, curve generation, multi-stage sequencing, B/T target invariant validation.
- `core/engine`: command interpreter, target evaluation, audio cue events, stable phase/primary selection.
- `core/session`: round/session state machine, countdown, rest, completion, pause/skip.
- `core/metrics`: trace analysis and independent metric calculations with versioned formulas.
- `core/cmd/wasm`: thin `syscall/js` entry point and controlled JS callback registration.

**Boundary contract:** TypeScript sends batched `InputFrame`s, clock ticks, configs and commands to WASM through a small stable API. Go returns typed events / target snapshots / metric results, ideally as bounded batches. Do not call Go for every audio sample or React state update. Do not generate sound from Go/WASM; TypeScript controls audio synthesis. Copy the version-matched `wasm_exec.js` from the installed Go toolchain, and build with `GOOS=js GOARCH=wasm`.

**Determinism:** inject clock and synthetic input traces. No dependence on wall-clock scheduling. Ensure numeric stability, monotonic time, bounded memory, and no state leakage between sessions. Run pure Go tests natively with race detector; separately smoke-test browser WASM integration.

# 6. Real-time audio and control design

## 6.1 Audio behaviors

1. **Freeform position mapping:** continuous audible mapping of selected primary control position. Use bounded, pleasant pitch/timbre/volume mapping, and allow neutral/silence regions to reduce fatigue.
2. **Movement signal:** separate auditory dimension for direction and rate of change. Smoothness should be perceivable in the changing sound, while explicit fluctuation *warnings* remain toggleable.
3. **Guided dual-tone mode:** distinct target and actual tonal identities; use an audible convergence behavior as the signals approach. Avoid dissonant or painfully high frequencies.
4. **Guided deviation mode:** audible magnitude and **sign** of actual-minus-desired delta. Ensure high versus low is distinguishable without sight and that zero/error-in-tolerance has a clear signal.
5. **Primary channel priority:** after B→S or S→T handoff, new control becomes main foreground sound; others remain measured with quieter/event-driven cues as appropriate. No continual alternation based on momentary amplitude.
6. **Alerts:** immediately warn on actual B/T overlap, device loss and invalid source. One-shot overlap onset alert with re-arm/hysteresis instead of an incessant alarm.
7. **Spoken cues:** announce exercise and config, countdown, stage transition if needed, completion, optional per-round/session summary. Duck or pause tones briefly during speech without hiding critical overlap alert.

**Architecture:** Audio management is a TypeScript service using Web Audio API, with gain limits, mute control, test output, and parameter scheduling. Use `AudioWorklet` if measured latency/jitter requires it. Do not promise an AudioWorklet eliminates source polling delays. Browser audio requires a user gesture to unlock; show an audio test/setup control before start. Provide headphones-first but not headphones-required UX. Respect safe volume and default conservative gain.

## 6.2 Voice and buttons

Use one command dispatcher for start/pause/resume/complete/skip/stop. User configures buttons from any supported Gamepad device, plus keyboard mappings, with conflict checks. Voice commands can be enabled through supported browser SpeechRecognition after microphone permission; provide a visible microphone/connection status. Browser speech recognition support varies and may use a remote service. Do not claim it works offline or on every browser. Prefer on-device recognition when available; offer explicit privacy notice and button fallback. Suppress command recognition while the application speaks or adopt verified echo cancellation/push-to-talk; reject low-confidence/destructive triggers and prevent the application's own TTS from issuing commands. Test no-display workflows end to end.

# 7. Metrics and graph specification

The core must emit **separate** measures, with definitions and units visible in the UI:

- **Accuracy:** time aligned deviation for timed drills, and normalized-duration shape or phase/relative-coordination deviation for appropriate self-paced drills. For example, mean absolute error and p95 absolute error in input percentage points; report endpoint and phase transition error separately. If no noncircular target comparison is defined, mark a specific submetric `N/A` rather than generating a score. In freeform mode `N/A`.
- **Smoothness:** measures unintended jitter/oscillation and control irregularity, segmented by hold versus ramp. Initial candidate: noise-aware residual to a local movement trend, plus reversal counts and spike magnitude. **Do not** treat high intentional derivative as error. Report confidence when sampling resolution is insufficient.
- **Timing:** for timed drills, start/end delay and phase transition deviation in seconds; for self-paced `N/A`.
- **Consistency:** dispersion across valid repeated rounds for corresponding metrics/trajectory landmarks; at least two eligible rounds required, otherwise `N/A`. Do not compute one pseudo-grade that blends everything.

Every algorithm must document: raw vs filtered series, sensor-noise floor, sampling-rate assumptions, phase boundaries, tolerance/hysteresis, handling of missing data, and normalization for self-paced alignment. Report both within-tolerance time and representative error where useful, not only pass/fail. Avoid double-penalizing the same issue in two metrics without explanation.

**Graphs:** preserve raw sampled input + desired target + frame validity in memory for the current session, with per-round selection, input-channel selector, zoom and phase markers. Compare desired vs actual point by point on actual time for timed drills, and on normalized progress for self-paced drills with raw-time option. Show unavailable data as gaps, not zeros. Clearly label that graphs are retrospective, not mandatory during active training. Max memory is bounded by rounds × duration × sample rate; downsample display traces without losing original session samples required for calculation. Discard data on explicit session reset or page reload. No background upload.

# 8. Browser UI and accessibility

**Views:** (1) home/source select, (2) hardware and optional calibration/diagnostics, (3) mode and drill catalog, (4) parameter/difficulty/audio/rounds configuration, (5) audio check + ready, (6) minimal active session with pause/stop (not required to look at), (7) post-session graphs, metrics, drill recommendations. Show source availability and critical warnings prominently; use large, keyboard-accessible controls and readable contrast. Include audio cues for connection state and round transitions.

**State ownership:** Go core owns drill/session determinism and metric decisions. TypeScript adapters own Gamepad/WebSocket/browser speech/audio, React owns view state and controls. Use a single bridge facade to avoid separate divergent state machines in React. Store no current-session telemetry in localStorage/IndexedDB or telemetry service workers. Application preferences such as audio volume and mappings may be persisted **only as a separate opt-in setting**, if approved; initial release can keep them ephemeral. This is distinct from forbidden persistent session history.

**Error handling:** no Gamepad available, microphone denied, unsupported voice API, audio suspended, collector not reachable, local-network permissions denied, missing steering channel, incompatible WebAssembly, slow input, and offline static resources must all have clear recovery paths.

# 9. Proposed repository layout

```text
trail-braking-trainer/
├── AGENTS.md                       # agent execution and review rules
├── CLAUDE.md                       # points to AGENTS.md; no conflicting instructions
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── LICENSE                         # pending project licensing decision
├── Makefile
├── package.json                    # npm workspaces
├── package-lock.json
├── .node-version
├── .gitignore
├── .golangci.yml
├── apps/
│   └── web/
│       ├── package.json
│       ├── vite.config.ts
│       ├── index.html
│       ├── public/
│       └── src/
│           ├── app/
│           ├── features/{devices,drills,sessions,results}/
│           ├── input/{gamepad,gt7,mock}/
│           ├── audio/{synth,speech,worklet}/
│           ├── controls/{keyboard,buttons,voice}/
│           ├── wasm/
│           ├── graphs/
│           └── main.tsx
├── core/
│   ├── go.mod
│   ├── go.sum
│   ├── input/
│   ├── drills/
│   ├── engine/
│   ├── metrics/
│   ├── session/
│   └── cmd/wasm/main.go
├── tests/{fixtures,e2e,contracts}/
├── scripts/{build-wasm.sh,package-release.sh,verify-release.sh}/
├── docs/
│   ├── requirements.md
│   ├── architecture.md
│   ├── drill-catalog.md
│   ├── audio-feedback.md
│   ├── input-protocol.md
│   ├── device-support.md
│   ├── validation-log.md
│   ├── metric-definitions.md
│   ├── security.md
│   ├── release-process.md
│   └── adr/
└── .github/
    ├── workflows/{test,security,build,release,deploy}.yml
    ├── dependabot.yml
    ├── CODEOWNERS
    └── pull_request_template.md
```

Do **not** copy collector source into the monorepo. Document the minimum compatible collector version and its WS protocol version. Use a dependency/compatibility matrix rather than a git submodule unless tests demonstrate a compelling need. 

**Local command contract** (implementation names, not commands already present):

```sh
make setup            # npm ci + go mod download/verify
make dev              # Vite dev server + WASM build/watch
make test             # Go and frontend unit suites
make lint             # Go lint/vet + TS lint/typecheck
make test-e2e         # Playwright + mock devices/collector
make test-wasm        # WASM browser smoke test
make security         # Trivy, OSV-Scanner, govulncheck, zizmor
make sbom             # source + build SBOMs
make build            # reproducible, versioned dist bundle
make verify-dist      # archive checksums and content manifest
```

Pin compatible Go, Node, npm, test browsers and CI tooling in the repository. Use `go mod tidy`, `go mod verify`, and `npm ci`; no floating dependency installations in release workflows.

# 10. CI, security, supply chain, and release

## 10.1 CI workflow policy

Use the collector repo's **test/security/build/release/docs** workflows as a baseline for standards, adapted for npm/React and a static bundle. Third-party GitHub Actions must be pinned by **full commit SHA** with version comments. Restrict `GITHUB_TOKEN` permissions per job; checkout with persisted credentials disabled; configure branch protection, required checks, reviews, protected tags, and environments. Never expose Cloudflare credentials to untrusted fork PR jobs.

| Event | Required behavior |
|---|---|
| Pull request to `main` | Go tests/race/vet/lint, TypeScript checks, Vitest, browser smoke/E2E, security, WASM build, optional trusted PR preview |
| Push/merge to `main` | Full CI, reproducible snapshot/static build, optional preview, no production deployment |
| Weekly schedule | Dependency and workflow security scans; Dependabot updates |
| Protected tag `vX.Y.Z` pointing to tested `main` commit | Re-run uncached release gates, build exactly once, SBOM, hash, sign, attest, GitHub Release, production deploy of same bytes |
| Manual dispatch | Approved diagnostic or preview only, never bypass release gates |

**Security scanners:** Trivy filesystem (vulnerabilities/secrets/misconfigurations), OSV-Scanner (Go/npm lockfiles), `govulncheck`, CodeQL for Go/JS/TS if enabled, `zizmor` for Actions, Dependabot for npm/go modules/Actions, standard secret scanning, `go vet` and `golangci-lint`. Block unreviewed HIGH/CRITICAL actionable issues and document the exception policy (false positive, accepted risk with expiry, patch availability). Scan workflow/config files, dependencies, and built deliverables, not merely Go source. SBOM is generated by Syft; this does not replace the other scanners.

**SBOM and trust chain:** generate source/dependency and distributed-artifact SBOMs in SPDX JSON (include npm and Go/WASM components), build SHA256 checksums, keyless sign published archive/checksum/SBOM files with Cosign and attach `.sigstore.json` bundles, and attach GitHub Actions SLSA provenance / SBOM attestations using supported `actions/attest` functionality. Verify signatures and attestations in CI using the expected repository/workflow/tag identity. Ensure the release artifact includes exact version, commit, build time, and manifest, without exposing secrets.

**Release artifacts** (example):

```text
trail-braking-trainer_0.1.0_web.tar.gz
trail-braking-trainer_0.1.0_web.spdx.json
checksums.txt
trail-braking-trainer_0.1.0_web.tar.gz.sigstore.json
trail-braking-trainer_0.1.0_web.spdx.json.sigstore.json
checksums.txt.sigstore.json
```

Build the static bundle once on a trusted tag runner, scan/sign/attest it, publish it as a GitHub Release, then deploy **those same extracted bytes** to Cloudflare Pages via Wrangler Direct Upload. Prefer immutable, auditable versioned releases. Provide README verification instructions (`sha256sum`, `cosign verify-blob`, `gh attestation verify`) adapted to the new repository identity. GitHub artifact attestations require eligible repository/plan configuration; if unavailable for a private repo, report this explicitly and use Cosign bundles without claiming GitHub attestations succeeded.

**Deployment notes:** Static hosting on Cloudflare Pages, no Workers required. Secure HTTPS and correct `application/wasm` MIME type; cache hashed assets aggressively but avoid stale `index.html`/WASM runtime mismatches; include security headers/CSP compatible with WASM and Web Audio. Production deployment only through tagged release. Preview deployments limited to trusted PRs or nonsecret build-only previews. Keep collector credentials and any Cloudflare token out of browser bundles. Serve version info in the app.

**Repository licensing:** user has not picked public/private visibility or license. Do not assign MIT/Apache/BSL without explicit decision. Do not copy code from TrailBraking.uk simply because its behavior inspired the product; reproduce functionality independently under compatible licensing.

# 11. Testing and validation

## 11.1 Automated test layers

**Core unit/property tests:** target generation boundaries; curve monotonicity where intended; legal/illegal combinations; every B/T transition; non-overlap invariant under interpolation; primary input handoffs; hold tolerance/hysteresis; state machine; pause and clock drift; time-based and self-paced scoring; valid/invalid frames; numeric edge cases; consistent metrics without overall grade.

**Synthetic trace fixtures:** exact target; offset hold; wobble on hold; smooth fast motion; smooth slow motion; deliberate rapid movement; jerky reversal; B+T overlap; sensor noise; dropped frames; out-of-order frames; inconsistent rounds; early/late manual completion; false terminal fly-through; steering missing; dropouts; hidden-tab throttling simulation. Save expected independent metric results and audio/command events as versioned test fixtures.

**TypeScript/browser tests:** Gamepad axes and analog button mapping; multiple devices; calibration opt-in and deadzone; event routing; voice capability detection; speech feedback not issuing commands; AudioContext unlock; graph alignment; error messages; WS handshake/version/auth/reconnection; no third-party telemetry requests. Playwright Chromium baseline, Firefox/WebKit where APIs allow; mocks must be labeled as mocks.

**Go/WASM:** test pure Go natively and exercise actual browser-compiled WASM in a smoke suite. `go test -race` applies to native Go runs, not as proof that js/wasm is race-free. Track bundle size, cold-start load, CPU use, memory and cross-language event overhead. Ensure WASM runtime JS matches Go version.

**Security tests:** unauthorized WS Origin, wrong pairing secret, overly large frame, slow reader, many clients, stale data, CSWSH attempts, mixed content/local network permission denial, no secret logging, protected GitHub deployment. Test genuine artifact/signature/attestation verification before publishing a stable release.

## 11.2 Manual hardware and browser validation gate

**Initial targets:** Fanatec setup (precise CSL DD vs ClubSport DD+ identification to be confirmed), Logitech G923, optional DualSense/DualShock 4. Capture OS, driver, firmware, wheel mode, browser version, input axis layout, reported resolution and frequency, deadzones, inversion, center, range, hidden-tab behavior, and end-to-end perceived/recorded sound latency. Validate pedals separately from steering. Do not infer physical ±degrees from Gamepad's `[-1,1]` axis scale.

**GT7 gate:** compare direct input movement against collector decoded telemetry when possible, but **do not build an automatic correlation engine**. Goal is to determine whether a driver steering-input channel exists and how to expose its values honestly. GT7 B/T tests can proceed independently. Record precise evidence of channels that are unsupported.

**Proposed performance acceptance targets, subject to measurement:** visible-tab feedback with no audible glitches during a representative eight-round session, p95 input-event-to-sound control-update under ~100 ms on test hardware, stable sound output, and bounded CPU/memory growth. These are test goals, not established product claims. Background/hidden tab behavior is a separately reported capability, not an assumed pass.

# 12. Phased execution plan and deliverables

## Phase 0. Foundation and decisions
**Tasks:** Initialize repo and protected branch structure; create `AGENTS.md`, `CLAUDE.md`, docs ledger, ADR template, Makefile, Go module, npm/Vite/React/TS, initial mock mode, baseline tests and workflows. Set toolchain pins. Record unresolved license/visibility and hardware identifiers.  
**Done when:** `make setup`, `make test`, `make build` work from clean checkout; docs explicitly say which features are mocked and which are unimplemented; CI blocks obvious failures.

## Phase 1. Technical spikes and input/audio feasibility
**Tasks:** Browser Gamepad readout/diagnostics, optional calibration, Web Audio tone prototype, Go WASM round-trip prototype; inspect Fanatec/G923 axes and sample rates; test permission, device connection, hidden tab/audio response. Prototype one collector WebSocket client with mock server; verify HTTPS-to-LAN browser permission.  
**Done when:** Real test observations recorded with supporting captures, core WASM called from browser, input changes produce tone, and each unsupported case has a fallback or explicit blocker. Do not defer all hardware tests until final release.

## Phase 2. Pure Go training core
**Tasks:** Versioned input and drill schemas, deterministic curves/presets, B/S/T sequence validation, primary-control selection, state machine, timed and self-paced completion, source quality. Build synthetic trace fixtures and strict unit/property tests.  
**Done when:** Go test suite proves target non-overlap, legal selections, correct round transitions, and stable phase behavior without browser involvement.

## Phase 3. Audio, speech, and session controls
**Tasks:** Continuous sonification, movement/smoothness feedback, toggled alerts, dual tone/deviation modes, voice announcements, command dispatcher, keyboard/gamepad bindings, guarded speech recognition. Test audio priority and speech ducking.  
**Done when:** Mock device can complete a multi-round session eyes-free; overlap alerts immediately and session continues; commands operate without visible controls on supported environment.

## Phase 4. Guided drill UX, scoring, and graphs
**Tasks:** Presets and parametric configuration, difficulty override UI, time/self-paced selector, optional final feedback, separate metrics, round-by-round and session graphs, recommendations without automatic changes. Implement settings validation and tests.  
**Done when:** Hold, full-range sweep, progressive, and multi-stage guided sessions run end-to-end and graph actual versus desired for every valid source channel. Metrics have documented formulas and fixture checks.

## Phase 5. GT7 collector WebSocket support (separate repository)
**Tasks:** Add opt-in read-only endpoint, versioned capabilities/frames, bounded fan-out, auth/origin controls, CLI flags, tests, docs and release workflow updates. Consume in trainer adapter with reconnect/permission/availability handling. Treat steering as unavailable until verified. Maintain collector compatibility with existing RTPS transports.  
**Done when:** Existing collector tests still pass, no security regression, browser receives real B/T packets, channel availability is truthful, and collector can still run without enabling WS.

## Phase 6. Hardening, security, releases, deployment
**Tasks:** E2E/browser matrix, hardware acceptance tests, load/audio measurements, privacy/security review, CI action SHA pinning, Trivy/OSV/Govulncheck/CodeQL/Zizmor, Dependabot, SBOM, Cosign, GitHub attestations, tag rules, Cloudflare Direct Upload, release verification and rollback procedure, README quickstart and known limitations.  
**Done when:** A protected `v0.1.0` candidate passes all release gates, downloaded archive verifies, deployed website corresponds to same checksummed artifact, and supported/unsupported hardware paths are stated accurately.

## Future work (not initial release)

- Record-and-repeat user-defined target; advanced visible live target graph/curve editor.
- Native desktop app with stronger background input guarantees, if browser tests show limitations; reuse pure Go core, avoid a parallel implementation of drill rules.
- GT7-focused mobile app connecting to collector on LAN; mobile platform-specific audio, speech and network permissions. No requirement for mobile to read a wheel physically.
- Advanced timing/trajectory alignment, carefully calibrated per-device steering ranges, additional controller profiles, nonpersistent export only if expressly requested.

# 13. Phase review requirements

Every completed phase must produce:

1. A short **implementation report** with changed paths, requirement IDs fulfilled, test commands and results, performance observations, security changes, and known limitations.
2. A **test evidence record** separating automated tests, manual hardware tests, and untested assumptions.
3. **Peer review** of the integrated phase by the complementary coding agent, plus a response to each substantive finding. Phase ownership and acceptance remain with orchestrator.
4. Updated requirements ledger, ADRs, and `docs/validation-log.md` for any change in interpretation.
5. No release/deployment step without the prescribed checks and user-approved access.

## Agent completion checklist

- [ ] Freeform and guided practice work; audio alone is sufficient for baseline sessions.
- [ ] All permitted B/S/T selections work; B+T only is disallowed.
- [ ] All generated desired curves satisfy zero brake/throttle overlap.
- [ ] Actual overlap causes immediate audio warning and does not restart a drill.
- [ ] Primary audio follows B→S→T control handoffs.
- [ ] Continuous audio conveys position and movement; optional explicit fluctuation warnings.
- [ ] Guided dual-tone and deviation-based audio available.
- [ ] Hold, full-range sweep, progressive curves and multi-stage drills.
- [ ] Timed/self-paced modes; automatic and manual self-paced completion.
- [ ] Eight rounds default; configurable rest/countdown; automatic progression.
- [ ] Voice + configurable button commands; safe fallbacks and permission warnings.
- [ ] Independent metrics and session-only graphs; no overall score or saved history.
- [ ] Calibrate on request, not mandatory; missing input channels are marked unavailable.
- [ ] Collector WS is optional, secure, versioned, and backward compatible.
- [ ] CI checks both Go Modules and npm; scans, signed SBOMs, provenance and protected tag release.
- [ ] Cloudflare deploy uses exactly the GitHub Release's tested static artifact.
- [ ] No claims about Fanatec, Logitech, browsers, or GT7 steering without live evidence.

# 14. Pending decisions and evidence gates

The following are **not** implementation excuses, but must be recorded before claiming completed support:

| Item | Current decision / action |
|---|---|
| Repository visibility and license | **Open.** Ask user before publication; preserve compatibility with collector license if using shared code, but do not copy without review. |
| Exact wheel model name | Confirm whether the Fanatec hardware is CSL DD or ClubSport DD+ during manual test. |
| Steering units and useful training range | Deliberately unresolved; measure direct hardware first and document reporting/normalization. |
| GT7 driver steering input | Not verified in collector; return unavailable until confirmed. |
| Browser background polling and audio | Measure, report supported workflows, define native fallback if unreliable. |
| Voice recognition support/privacy | Feature detect; warn if recognition uses online service; button fallback. |
| Rest/countdown numeric defaults | 5s/3s proposed; configurable, subject to user feedback. |
| Default audio mapping, smoothing and alert thresholds | Prototype and tune with real users; never hardcode universal claims. |
| Self-paced progress alignment | Dynamic live desired-vs-actual is undefined without a reference clock; use live movement/end-state cues and retrospective normalized-duration shape/phase analysis. Do not report a fabricated instantaneous delta. |
| Pairing/security details for local collector | Validate exact browser/local network environment before freezing endpoint and token UX. |
| Release hosting permissions | GitHub repo/Cloudflare project and allowed permissions need owner authorization. |

# 15. Reference sources and external documentation

- Existing collector source and CI: https://github.com/arush-sal/gt7-telemetry-collector
- Existing collector workflows: https://github.com/arush-sal/gt7-telemetry-collector/tree/master/.github/workflows
- Existing GoReleaser config: https://github.com/arush-sal/gt7-telemetry-collector/blob/master/.goreleaser.yaml
- TrailBraking.uk reference (behavioral inspiration only): https://trailbraking.uk/guide and https://trailbraking.uk/device
- Go WASM: https://go.dev/wiki/WebAssembly
- Gamepad API: https://developer.mozilla.org/en-US/docs/Web/API/Gamepad_API/Using_the_Gamepad_API
- AudioWorklet: https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet
- Speech recognition constraints: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition
- Browser LAN/WSS permissions: https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access
- Cloudflare Pages Direct Upload: https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- GitHub attestations: https://github.com/actions/attest

---

**Implementation instruction:** Start with Phase 0 and Phase 1 validation work, not with a speculative complete application. Preserve the full requirements above as acceptance tests and execute the subsequent phases once prerequisite evidence is available. Never quietly narrow the agreed scope, never invent a GT7 steering input, and never turn this muscle-memory trainer into a race engineer.
