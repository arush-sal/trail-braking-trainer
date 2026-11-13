# Session results contract (Phase 4, v1)

JSON returned by `tbtCore.api.results(includeFull)` (bridge: `results(includeFull = false)`) and consumed
by the results UI. Go (`core/metrics`, `core/api`) produces it; TypeScript
mirrors it in `apps/web/src/wasm/sessionBridge.ts`. Changes require updating
both sides and this file. Formulas, ids and units: `docs/metric-definitions.md`.
Only finished attempts are included (an open attempt appears when it ends).

```ts
type Axis = 'brake' | 'steering' | 'throttle';

type Trace = {
  t: number[];                    // ms since attempt start (active time, pauses excluded)
  actual: (number | null)[];      // raw normalized actual; null = unavailable/gap (render as gap, never 0)
  filtered?: (number | null)[];   // monotone movement trend used by smoothness (labelled "filtered")
  desired?: (number | null)[];    // timed guided: desired at t; self-paced: omitted
  valid: boolean[];               // frame validity
};

type ShapeTrace = {               // self-paced guided only: retrospective normalized comparison
  u: number[];                    // [0,1] normalized over measured round duration
  actual: (number | null)[];
  desired: number[];              // drills.ShapeAt(u)
};

type Metric = {
  id: string;                     // e.g. 'accuracy.mae'
  label: string;
  axis?: Axis;                    // absent on mode-level N/A metrics ('accuracy', 'timing', 'consistency', 'accuracy.coordination')
  value: number | null;
  unit: string;                   // 'pp' (percentage points), 's', 'count', ...
  better: 'lower' | 'higher' | 'n/a';
  applicable: boolean;            // false => render "N/A" with reason, never 100%
  reason?: string;
  coverage?: number;              // fraction of expected samples present [0,1]
  formulaVersion: string;         // e.g. 'accuracy/v1'
};

type RoundResult = {
  round: number;                  // 1-based
  attempt: number;                // 1-based attempt within round
  outcome: Outcome;               // session Outcome
  selfPaced: boolean;
  durationMs: number;
  phases: { index: number; name?: string; startMs: number }[]; // desired phase boundaries (timed); [] otherwise
  traces?: Partial<Record<Axis, Trace>>;       // full-resolution, bounded by session caps; ONLY with includeFull=true
                                               // (omitted by default: long rounds would be tens of MB of JSON)
  display: Partial<Record<Axis, Trace>>;       // downsampled for plotting (<= ~1000 pts/axis)
  shape?: Partial<Record<Axis, ShapeTrace>>;  // self-paced guided, scored attempts only
  accuracy: Metric[];
  smoothness: Metric[];
  timing: Metric[];               // self-paced/freeform => applicable:false
};

type Recommendation = {
  id: string;
  text: string;                   // suggestion only; never auto-applied
  change?: { path: string; from: unknown; to: unknown }; // UI may offer a user-confirmed apply
};

type SessionResults = {
  apiVersion: 1;
  mode: 'freeform' | 'guided';
  drill?: DrillDefinition;        // DrillDefinition used (with defaults)
  rounds: RoundResult[];
  consistency: Metric[];          // needs >= 2 valid rounds, else applicable:false
  recommendations: Recommendation[];
  error?: string;                 // e.g. no session yet; other fields are then empty
};
```

Metrics are always computed in Go from the full-resolution data whatever
`includeFull` is; the default (display-only) response is what the UI uses.

## Drill preview

`tbtCore.api.previewSamples(drillJson, n)` (bridge: `previewSamples(def, n)`)
validates the drill (all channels assumed available) and samples the desired
values from the core, so the UI never duplicates curve math. `n` is clamped
to `[2, 500]`.

```ts
type DrillPreview = {
  apiVersion: 1;
  timed: boolean;
  xUnit: 'ms' | 'u';              // timed: elapsed ms via TargetAt; self-paced: progress u in [0,1] via ShapeAt
  x: number[];
  values: Partial<Record<Axis, number[]>>;
  phases: { index: number; name?: string; startX: number }[];
  error?: string;                 // invalid drill; other fields empty
};
```

Rules: no composite score anywhere; freeform accuracy N/A; self-paced timing
N/A; low coverage => N/A or flagged, never success; results live in memory only
and are discarded on reset/reload.
