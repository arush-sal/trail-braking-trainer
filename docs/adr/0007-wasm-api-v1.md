# 0007. WASM session API v1: one Runner, JSON strings, batched calls

- Status: accepted
- Date: 2026-11-14
- Requirements: R-010, R-011, R-013, R-016, R-017, R-027, R-029

## Context
Phase 3 audio, speech and controls need the Go core (session, drills,
detectors) from the browser. Spec 5 asks for a small stable API taking
batched frames, ticks, configs and commands and returning bounded batches of
typed events and target snapshots; spec 8 asks for a single bridge facade
with no second state machine in React. `docs/session-lifecycle.md` requires
time-ordered frames and fresh detectors per session.

## Decision
- A pure Go package `core/api` holds the whole contract (`Runner`: `Start`,
  `Command`, `Tick`, `Observe`/`ObserveJSON`, `Snapshot`; plus `Presets`,
  `ValidateDrill`), tested natively. `core/cmd/wasm` only checks argument
  types and marshals JSON (`tbtCore.api`).
- JSON strings across the boundary (camelCase, `apiVersion: 1`, unknown
  fields rejected), matching ADR 0005/0006. Frames are decoded per element
  with `input.Decode`, so missing fields are invalid, never zero.
- One `Runner` owns one session. `Start` always creates a new session and
  new overlap, fluctuation, completion and primary detectors; it is refused
  while a session is running.
- Bad frames never fail a batch: late frames are dropped and counted
  (`outOfOrder`), contract violations dropped and counted (`invalid`).
- Overlap and fluctuation detectors see only frames accepted while ACTIVE
  (no alerts during countdown/rest), and get fresh state on every session
  state change (attempt start, pause, resume, source loss/restore), so an
  episode never suppresses an alert in a later attempt. Freeform primary
  sees every frame.
- Input silence is detected in the core: `session.Config.maxFrameGapMs`
  (default 100 ms) turns ACTIVE silence into `invalidSourceLost`, and a
  timed round only completes with valid coverage up to its end
  (docs/session-lifecycle.md). Ticks alone never complete a round.
- Primary: timed guided = `GuidedPrimary` of the current phase (phase 0
  outside an attempt); self-paced guided and freeform = `FreeformPrimary`
  over the selected controls, since no time-to-phase mapping exists without
  a progress signal (spec 3.4).
- Event batches are capped (1024); the Snapshot is authoritative.
- TS: `sessionBridge.ts` buffers frames and at a fixed cadence (60 Hz,
  injected scheduler and clock) calls `observe(batch)` -> `tick(now)` ->
  `snapshot(now)`; commands flush frames first. Never one call per frame or
  per React render.
- Noise floor default 0.005 for overlap and fluctuation (provisional,
  public-info inference, to be measured in hardware test T2); overridable
  per session via `noiseFloor`.

## Consequences
- Breaking changes to the JSON shapes bump `apiVersion`.
- Three Go calls per 60 Hz step; measured cost in the WASM test log.
- Session attempts/frames are not exported yet (Phase 4 metrics).
- Primary-change events are stamped with the call time, not the exact phase
  boundary.

## Evidence / validation
- `go -C core test ./api ./engine ./session`.
- `make test-wasm`: a 2-round timed freeform session driven by TS
  `mockFrame` through the real `core.wasm`, asserting the event sequence and
  an overlap onset from a synthetic overlapping frame.
