# Metric definitions

Versions: `accuracy/v1`, `smoothness/v2`, `timing/v1`, `consistency/v1`,
`coverage/v2` (gates every per-round metric). Each metric carries its
`formulaVersion`. Fixture keys include it, so a version bump shows in the
fixture diff.

Implements spec 3.4, 3.6 and 7 (R-016, R-024..R-027). Code: `core/metrics`
(pure Go, deterministic). JSON shape: `docs/results-contract.md`. Expected
values for the synthetic fixtures are pinned in
`core/metrics/testdata/fixtures_v1.json` (regenerate with
`go -C core test ./metrics -run TestFixtures -update` only after an intended
formula change, and bump the formula version).

There is **no composite score, grade or total** anywhere. Accuracy,
smoothness, timing and consistency are reported separately, per round and
per axis. Every parameter below is **PROPOSED** and should be tuned with the
hardware test data (docs/hardware-test-protocol.md).

## Common rules

| Topic | Rule |
|---|---|
| Time base | Active time: `t = receivedMonoMs - attempt.startMs - (paused intervals that ended before the frame)`. Pauses are excluded. |
| Raw series | `actual` = the frame's `normalized` value. Brake/throttle `[0,1]`, steering the provisional signed `[-1,1]` scale (ADR 0003). |
| Missing data | A sample is valid only if the channel is available, `normalized` is present and the frame is not `gap`/`stale`. Invalid samples are `null` in traces (rendered as gaps, never 0), are never interpolated into a metric, and never extrapolated. |
| Units | `pp` = percentage points of the normalized scale (`100 x` normalized; 1.0 steering = 100 pp of the provisional scale). `s` seconds. `count`. `fraction` in `[0,1]`. |
| Direction of good | `better`: `lower`, `higher`, or `n/a` for signed descriptive values (bias, delays: 0 is ideal, the sign says early/late or above/below). |
| Sampling assumption | Frames are roughly evenly spaced. The nominal interval `dt` is the median interval between consecutive recorded frames. Accuracy statistics weight each valid sample equally. |
| Coverage (`coverage/v2`) | Per axis: `coverage = min(1, effectiveSamples / (floor(durationMs / dt) + 1))`. A valid sample is effective only if it is at least `dt/2` after the previous effective one, so bursty delivery (0, 1, 100, 101, ... ms, for example a throttled hidden tab) cannot fake full coverage with 99 ms blind spots. v1 counted every valid sample. Below **0.90** (`MinCoverage`) all accuracy, smoothness and timing metrics of that axis are `applicable: false` with reason `sample coverage x < 0.90`. Coverage is attached to every per-round metric. Truncated attempts (sample cap) lose coverage this way. |
| Invalid attempts | Only `completedTimed`, `completedAuto` and `completedManual` attempts are scored. `skipped`, `invalidSourceLost` and `aborted` attempts keep their traces (evidence) but every metric is N/A, `attempt <outcome>: not scored`. They are never counted as a success and are excluded from consistency. |
| Noise floor | `noiseFloor` from the session (default 0.005, the same as the alert detectors). It is subtracted from smoothness residuals and added to the reversal and onset thresholds. Accuracy does not subtract it: error is error. |
| Tolerance | `drill.ToleranceFor(axis)` (per-control > drill > preset). `withinTolerance` uses `abs(e) <= tolerance` per sample, with no hysteresis. Hysteresis belongs to auto-completion only (engine), so the metric is not inflated by it. |
| Phase boundaries | Timed: cumulative `durationMs` (`drills.PhaseStarts x total`), reported in `phases[].startMs`. Self-paced: the same fractions times the measured shape duration (below). A boundary instant belongs to the phase that starts there (as in `TargetAt`). |

## Self-paced normalization (spec 3.4)

There is no instantaneous desired position for a self-paced drill, and no
live delta is produced. Only after the round:

1. Measured shape duration `D = active duration`, minus the drill's
   completion hold (`CompletionHoldMsFor`) when the outcome is
   `completedAuto`. That hold only confirms the end state, and including it
   would make the same shape executed at different speeds score
   differently.
2. Each valid sample with `t <= D` gets `u = t / D` and is compared with
   `drills.ShapeAt(u)`. The mapping uses **time only**, never the actual
   input position, so it cannot produce tautological perfect accuracy. A user
   who never moves gets a large error (fixture test).
3. Total duration is reported descriptively (`durationMs`) and is never a
   timing penalty. Timing is N/A.
4. Combined-control relative coordination (`accuracy.coordination`) is N/A,
   because no documented noncircular primary-control progress parameter
   exists yet. Multistage phases are compared on normalized time only
   (`accuracy.phaseTransition` at `u_k`).

## Accuracy (`accuracy/v1`), guided only

Per axis, `e = actual - desired`. Desired is `TargetAt(t)` for timed drills
and `ShapeAt(t/D)` for self-paced ones. For freeform there is one metric,
`accuracy`, which is N/A (`freeform: there is no target`).

| id (timed / self-paced) | Formula | Unit | Better |
|---|---|---|---|
| `accuracy.mae` / `accuracy.shapeMae` | mean abs(e) | pp | lower |
| `accuracy.p95` / `accuracy.shapeP95` | nearest-rank 95th percentile of abs(e) | pp | lower |
| `accuracy.bias` / `accuracy.shapeBias` | mean e (+ = above target) | pp | n/a (0 ideal) |
| `accuracy.withinTolerance` / `accuracy.shapeWithinTolerance` | fraction of samples with abs(e) <= tolerance | fraction | higher |
| `accuracy.endpoint` | abs(mean e) over the final `min(250 ms, 10% of duration)`. For `completedAuto` this is the completion hold. | pp | lower |
| `accuracy.phaseTransition` | mean abs(actual - desired) at each internal phase boundary (actual linearly interpolated between valid samples no more than 2 dt apart). N/A for one phase, or if any boundary has no valid sample. | pp | lower |
| `accuracy.coordination` (self-paced multistage) | N/A, see above | pp | lower |

Self-paced shape metrics use samples with `t <= D`. The endpoint uses the
final window of the whole attempt.

## Smoothness (`smoothness/v2`), all modes

Measures unintended irregularity. Deliberate fast motion is **not** an
error: any monotone movement scores 0 on every smoothness metric, whatever
its speed or curvature.

1. **Reversals:** a zig-zag filter on the valid raw samples finds direction
   reversals whose swing is at least `ReversalMin + noiseFloor` (0.02 +
   0.005) on both sides. A desired direction change (for example steering
   up, hold, back down) allows exactly **one** reversal in the window from the
   end of one ramp to the start of the next opposite ramp, +/- 100 ms
   (`PeakExclusionMs`). Extra reversals in that window still count.
2. **Filtered series / local trend:** the reversals split the trace into
   runs. Each run is fitted with its best least-squares monotone trend
   (isotonic regression, non-decreasing or non-increasing, whichever fits
   better). This trend is the `filtered` series in the traces.
3. **Jitter:** `RMS(max(0, abs(actual - trend) - noiseFloor))`, in pp. This is
   roughness below the reversal threshold, such as tremor or chatter.
4. **Spike (v2):** per sample, take the smaller deviation from the two local
   linear trends: one extrapolated from the two samples before it, one from
   the two samples after it. Spike = `max(that - noiseFloor)`, in pp, and 0
   within two samples of either end. A sampled trajectory with a consistent
   slope on at least one side scores 0. That covers monotone motion of any
   speed, corners, and a fast intended 0 -> 1 -> 0 reversal in 100 ms (the
   v1 5-sample median scored that 9.5-19.5 pp). A one- or two-sample outlier
   that returns to the prior level is a spike. A 3+ sample excursion is a
   plateau, not a spike, and shows in reversals.

Segmentation: guided samples are classed by the desired phase. A phase is
`hold` when the axis's ramp has `from == to` (including absent = 0, coast),
otherwise `ramp`. The completion hold of a self-paced auto round is `hold`.
Freeform uses one `all` segment. The ids are
`smoothness.{hold|ramp|all}.{jitter|spike|reversals}`, and a segment is emitted
only if it has samples.

Applicability (v2): smoothness is N/A (`sample rate too low`) when more
than 10% of the round (`1 - MinSmoothTime`) lies in valid-sample intervals
longer than 50 ms (`MaxSmoothIntervalMs`). The round's start and end count as
interval edges. Tremor up to ~8 Hz cannot be seen at under 20 Hz. v1 used
the median interval, which bursty sampling fools.

**No double counting:** an oscillation larger than the reversal threshold
splits into monotone runs, so it shows in `reversals` and not in `jitter`.
Smaller roughness shows in `jitter` and not in `reversals`. An isolated
glitch above the reversal threshold reports its size as `spike` and also
counts as one reversal. These are two views of one event (size vs count),
and neither is added to the other. Accuracy MAE does
include oscillation amplitude, because it is real position error. `bias` is
reported next to it so a centred wobble (bias ~0, MAE > 0, reversals > 0)
is not mistaken for a target offset (bias = MAE).

## Timing (`timing/v1`), timed guided only

Self-paced: a single `timing` metric, N/A (`self-paced: duration is reported
descriptively`). Freeform: `timing` N/A.

For each phase where the axis's ramp moves (`from != to`), with direction
`dir` and `th = min(|to-from|/2, OnsetMin + noiseFloor)` (`OnsetMin` 0.02),
three landmark levels are defined:

- onset `from + dir*th`
- mid `(from+to)/2`
- arrival `to - dir*th`

The desired crossing time is found by bisection on the ramp's monotone
curve. The actual crossing is the valid-sample crossing in the same
direction (linearly interpolated, across intervals of no more than 2 dt)
nearest to it within +/- `max(1 s, phase duration)`. The deviation is
`actual - desired`, in seconds, positive = late.

| id | Formula | Unit | Better |
|---|---|---|---|
| `timing.startDelay` | onset deviation of the axis's first moving phase | s | n/a (0 ideal) |
| `timing.endDelay` | arrival deviation of the axis's last moving phase | s | n/a (0 ideal) |
| `timing.phaseTransition` | mean abs(mid-level deviation) over all moving phases. N/A if any is missed. | s | lower |

An axis with no desired movement (a hold) has timing N/A. Its initial offset
is in accuracy. A landmark the actual input never crosses near the desired
time is N/A with a reason, never 0.

## Consistency (`consistency/v1`), session level

Uses valid (completed) rounds only. With fewer than 2, there is one
`consistency` metric, N/A (`needs >= 2 valid rounds`).

- `consistency.<metric id>` (per axis): sample standard deviation (n-1) of
  that per-round metric over the valid rounds where it is applicable, in
  the metric's unit. Lower = more repeatable. Metrics that are N/A in every
  round (for example self-paced timing) are omitted, not shown as 0.
- `consistency.trajectory` (per axis): the actual value at 25/50/75/100% of
  each round's (shape) duration. This is the mean of the per-landmark standard
  deviations, in pp. Rounds whose axis coverage is below the threshold are
  excluded.

## Recommendations (R-026)

These are derived from this session only. They are suggestions and are
**never** applied. A `change` (`{path, from, to}`) is something the UI may
offer to apply on explicit user confirmation.

Eligibility: each selected axis needs `withinTolerance` (or the shape
variant) applicable in >= 2 rounds. Completed rounds that are N/A, for
example low coverage, do not count. One scorable round plus one unscorable
round never yields a difficulty suggestion.

| id | Rule | change |
|---|---|---|
| `difficulty.harder` | eligible and every `withinTolerance` (or shape variant) > 0.95, no tolerance override, not advanced | `difficulty`: current -> next preset |
| `tolerance.tighter` | same, but tolerance overridden | none |
| `difficulty.easier` | eligible, mean `withinTolerance` < 0.5, not beginner, no override | `difficulty`: current -> previous preset |
| `tolerance.wider` | same, but beginner or overridden | none |
| `source.lost` | any `invalidSourceLost` attempt | none |

## Display traces

`traces` keep every recorded sample (bounded by `maxSamplesPerRound`).
`display` traces are for plotting only, with at most 1000 points per axis
(min-max bucketing). Both ends are kept, plus, per bucket, the min and max
actual sample and its gap, so spikes and gaps stay visible. A bucket with
two or more separate gaps is emitted as one null point (unavailable), so a
plotted line never bridges missing data. That bucket's extremes are then
only in the full trace. All series
share the kept indices. Metrics are always computed on the full traces.

## Synthetic fixtures (spec 11.1)

`core/metrics/metrics_test.go` covers each of these:

- exact target (all errors and delays ~0, no smoothness findings)
- offset hold (MAE = bias = offset)
- 5 Hz wobble (same bias as steady; reversals) and sub-threshold tremor (jitter)
- single- and two-sample glitch (spike)
- fast intended 0 -> 1 -> 0 reversal in 100 ms (spike 0)
- bursty 0/1/100/101 ms sampling (coverage 0.51, N/A)
- two gaps in one display bucket (no bridged line)
- one perfect plus one low-coverage round (no recommendation)
- smooth fast sweep and a freeform 100 ms full application (smoothness 0)
- late execution (+0.2 s delays)
- dropped frames (coverage N/A) and low sample rate (smoothness N/A)
- self-paced slow vs fast (same shape accuracy, timing N/A)
- idle self-paced (no tautological alignment)
- self-paced multistage (coordination N/A)
- freeform (accuracy/timing N/A)
- invalid/skipped attempts (never scored)
- inconsistent rounds (consistency std)
- recommendations (suggest only, drill unchanged)
- display downsampling
- no composite score

Pinned values: `testdata/fixtures_v1.json`.
