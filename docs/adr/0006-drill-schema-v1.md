# 0006. Drill schema v1: phases of per-control ramps

- Status: accepted
- Date: 2026-11-14
- Requirements: R-008, R-009, R-010, R-011, R-016, R-017, R-021, R-022, R-023

## Context
Spec 3.2-3.5 needs one deterministic, validated drill definition covering
hold, full-range sweep, progressive curve and multi-stage drills, timed and
self-paced, with a hard guarantee that desired brake and throttle never
overlap.

## Decision
- One schema (`DrillDefinition`, `schemaVersion: 1`, camelCase JSON) for all
  four drill types: an ordered list of phases, each mapping controls to a ramp
  `{from, to, curve, intensity}`. Single-phase types (hold/sweep/progressive)
  are constrained shapes of the same structure. A selected control absent
  from a phase is desired at 0, which gives coast and steering-only phases
  without extra fields.
- Curves are closed-form power easings (`linear`, `easeIn`, `easeOut`,
  `easeInOut`, exponent `1 + intensity`, intensity in `[0,4]`), monotone and
  range-preserving. Formulas in `docs/drill-catalog.md`.
- Phases must be continuous, and brake/throttle may not both be desired above
  zero within one phase. With monotone ramps this per-segment endpoint check
  is a sound analytic proof of the spec 3.2 invariant; it is deliberately
  conservative (B must reach 0 in an earlier phase than T rises).
- Phase order: controls first introduced in B -> S -> T order; no brake after
  throttle.
- Self-paced drills expose only `ShapeAt` (normalized progress); `TargetAt`
  refuses them (spec 3.4: no fabricated instantaneous target).
- Difficulty presets, rest/countdown defaults, curve intensity bound and all
  engine thresholds are PROPOSED and live in code as plain values.

## Consequences
- Schema changes require a new `schemaVersion`.
- Some technically non-overlapping single-phase B release + T apply shapes
  are rejected; users split them into two phases.
- Step changes in targets are not expressible; a "snap" needs a short ramp.

## Evidence / validation
- `go -C core test ./drills ./engine`: table tests, dense-sampling property
  test over 3000 random drills, `FuzzTargetsNeverOverlap`, `FuzzEaseMonotone`.
- Thresholds and presets: not user-validated (spec section 14).
