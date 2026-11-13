# Drill catalog and DrillDefinition schema v1

Source: spec 3.2-3.5, R-008..R-011, R-016, R-017, R-021..R-023. Decision: ADR 0006.
Code: `core/drills` (schema, validation, targets), `core/engine` (overlap,
completion, primary selection). Values marked **PROPOSED** are tunable
defaults, not validated thresholds.

## Schema (JSON, camelCase)

```jsonc
{
  "schemaVersion": 1,
  "name": "trail brake",
  "type": "multistage",          // hold | sweep | progressive | multistage
  "timing": "timed",             // timed | selfPaced
  "controls": ["brake", "steering", "throttle"],
  "difficulty": "beginner",      // beginner | intermediate | advanced (default beginner)
  "tolerance": 0.07,             // optional drill-wide override
  "controlTolerance": {"steering": 0.05}, // optional per-control override
  "completionHoldMs": 600,       // optional override of the preset
  "rounds": 8, "restMs": 5000, "countdownMs": 3000,
  "phases": [
    {"durationMs": 1000, "targets": {"brake": {"from": 0.8, "to": 0.8}}},
    {"durationMs": 1500, "targets": {
      "brake": {"from": 0.8, "to": 0, "curve": "easeOut", "intensity": 1},
      "steering": {"from": 0, "to": 0.5}}},
    {"durationMs": 1000, "targets": {"steering": {"from": 0.5, "to": 0.5}}},
    {"durationMs": 1500, "targets": {
      "steering": {"from": 0.5, "to": 0},
      "throttle": {"from": 0, "to": 1, "curve": "easeIn", "intensity": 1}}},
    {"durationMs": 1000, "targets": {"throttle": {"from": 1, "to": 1}}}
  ]
}
```

- A **phase** maps controls to **ramps** `{from, to, curve, intensity}`. A hold
  is `from == to`. A selected control absent from a phase is desired at `0`
  (released / centred) for that phase: a phase with no targets is a **coast**
  phase, one with only steering is **steering-only**.
- Value ranges: brake/throttle `[0,1]`; steering `[-1,1]` (provisional signed
  practice scale, ADR 0003).
- `durationMs`: required and `> 0` for every phase of a timed drill. For a
  self-paced drill it is optional; if set on all phases it weights the phases
  for normalized-progress comparison, otherwise phases are weighted equally.
- Numeric bounds: every number must be finite (NaN/Inf rejected). Each phase
  `durationMs`, the sum of all phase durations, `completionHoldMs`, `restMs`
  and `countdownMs` must be `<= MaxDurationMs` (3,600,000 ms = 1 hour,
  matching the session limit), so cumulative sums can never overflow.
- Defaults (`WithDefaults`): `rounds` 8 (R-019); `restMs` 5000 and
  `countdownMs` 3000 (**PROPOSED**, spec 14); `difficulty` beginner. `restMs`
  and `countdownMs` may be explicitly `0`.

## Drill types (R-021)

| Type | Phases | Rule |
|---|---|---|
| hold | 1 | every target `from == to` |
| sweep | 1 | at least one moving target; all moving targets linear |
| progressive | 1 | at least one moving target; any curve (R-022 presets) |
| multistage | >= 2 | holds, ramps, coast and steering-only phases |

## Curves

Each curve `f` maps progress `u` in `[0,1]` onto `[0,1]`, with `f(0)=0`,
`f(1)=1`, monotone non-decreasing (so ramps never overshoot). A ramp's value is
`from + (to - from) * f(u)`. With `p = 1 + intensity`, intensity in `[0, 4]`
(**PROPOSED** bound; 0 = linear, preset default 1 = quadratic):

| Curve | Preset name | f(u) |
|---|---|---|
| `linear` (or omitted) | straight line | `u` |
| `easeIn` | gentle start / fast finish | `u^p` |
| `easeOut` | fast start / gentle finish | `1 - (1-u)^p` |
| `easeInOut` | smooth start and finish | `2^(p-1) u^p` for `u < 1/2`; `1 - 2^(p-1) (1-u)^p` otherwise |

No hardcoded sample points.

## Difficulty presets (R-023) - PROPOSED

| Preset | Tolerance (normalized) | Auto-completion hold |
|---|---|---|
| beginner | 0.10 | 500 ms |
| intermediate | 0.05 | 750 ms |
| advanced | 0.025 | 1000 ms |

Tolerance resolution: `controlTolerance[control]` > `tolerance` > preset.
Overrides must be in `(0, 1]`.

## Validation and invariants (`drills.Validate(def, availableChannels)`)

1. **Selection (R-008):** exactly `[B]`, `[S]`, `[T]`, `[B,S]`, `[S,T]` or
   `[B,S,T]`, in that order. `B+T` is rejected.
2. **Availability (spec 4.1):** every selected control must be in the source's
   available channels (e.g. GT7 steering unavailable -> any steering drill is
   rejected).
3. **Ranges / durations / types** as above; unknown curves, intensity out of
   range, targets on unselected controls are rejected.
4. **Continuity:** each control's value at the end of a phase equals its value
   at the start of the next (no scheduled steps).
5. **Hard B/T exclusion (R-009, spec 3.2):** in no phase may brake and
   throttle both be desired above target-zero (`1e-9`, float rounding only).
   Because curves are monotone, a control at zero at both endpoints of a ramp
   is zero throughout, so this per-segment check covers every instant.
   Consequence: B must reach 0 in an earlier phase before T rises; overlapping
   release/apply ramps are rejected. Proven by a dense-sampling property test
   and fuzz target over random continuous drills (every boundary +/- 1e-6 ms
   plus 2001 samples per drill), and a mutation check (disabling the rule makes
   the property fail).
6. **Phase order (spec 3.3 item 4):** controls are first introduced (desired
   above zero) in B -> S -> T order, and brake is never desired again after
   throttle has been introduced. `B+S` may hand off directly to `S+T`.
7. **Self-paced** drills need at least one terminal target (a control listed in
   the last phase).

## Targets

- `TargetAt(def, tMs)` - timed drills only: desired value per selected control
  (absent = not part of drill), phase index (a boundary instant belongs to the
  phase starting there), terminal controls, `done` after the end (then the
  final values are held).
- `ShapeAt(def, u)` - normalized progress `u` in `[0,1]`, for retrospective
  self-paced comparison (spec 3.4). There is deliberately **no** live
  instantaneous target for self-paced drills; `TargetAt` refuses them.
- `TerminalTargets(def)` - final values of the controls listed in the last phase.

## Engine detectors (`core/engine`) - thresholds PROPOSED

| Detector | Rule | Defaults |
|---|---|---|
| `OverlapDetector` (R-010) | Unsuppressed actual B and T both `>= enter + noiseFloor` -> one onset event; exits when either `< exit + noiseFloor`; a re-entry within `cooldownMs` of the exit continues the same episode (no new event). Never modifies input, never ends the attempt. Null channels and gap/stale frames never count as active. | enter 0.05, exit 0.02, noiseFloor 0 (until measured), cooldown 500 ms |
| `CompletionDetector` (R-017, spec 3.5 `auto`) | All terminal controls within tolerance, kept while within `tolerance x exitScale`, continuously for the completion hold time. Gap/stale frames, unavailable terminal channel, out-of-order frames, or a frame gap > `maxFrameGapMs` reset the hold. Latches until `Reset`. `Observe` is usable as the session's `func(input.Frame) bool` hook. | exitScale 1.25, maxFrameGapMs 100 |
| `GuidedPrimary(def, phase)` (R-011) | Latest control in B->S->T order introduced in phases `0..phase`; only moves forward, only at phase boundaries. Leading coast -> first control to be introduced. | - |
| `FreeformPrimary` (R-011) | Most recently engaged control still engaged (engage `|v| >= enter`, disengage `|v| < exit`); keeps the previous primary when nothing is engaged; switches at most once per `minDwellMs`. | enter 0.08, exit 0.03, dwell 250 ms |

All detectors use only frame `receivedMonoMs`; older frames than the last
accepted one are ignored.

Synthetic fixtures (spec 11.1) live in `core/engine/fixtures_test.go`: exact
target, offset hold, wobble, smooth fast/slow motion, deliberate rapid
movement, jerky reversal, B+T overlap (incl. flapping near threshold), sensor
noise, dropped frames, gap flags, out-of-order frames, false terminal
fly-through, steering missing. Expected events are inline tables in
`core/engine/engine_test.go`.
