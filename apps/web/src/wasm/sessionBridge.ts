// Single session facade over tbtCore.api (spec 5 and 8, ADR 0007). The Go core owns the
// session state machine and detectors; this file only batches frames, drives the clock
// at a fixed cadence and fans out typed events. React and audio read from here and never
// keep their own session state machine.
import type { Axis, InputFrame } from '../input/types';

export const API_VERSION = 1;

/** tbtCore.api as exposed by core/cmd/wasm: JSON strings in, JSON strings out. */
export type TbtApi = {
  apiVersion: number;
  start(cfg: string): string;
  command(name: string, nowMs: number): string;
  tick(nowMs: number): string;
  observe(framesJson: string): string;
  snapshot(nowMs: number): string;
  presets(): string;
  validateDrill(drill: string): string;
  /** includeFull: also return full-resolution traces (large); default display-only. */
  results(includeFull: boolean): string;
  previewSamples(drill: string, n: number): string;
};

export type SessionState = 'IDLE' | 'PREPARE' | 'COUNTDOWN' | 'ACTIVE' | 'REST' | 'PAUSED' | 'SOURCE_LOST' | 'COMPLETE' | 'ABORTED';
export type Outcome = 'completedTimed' | 'completedAuto' | 'completedManual' | 'skipped' | 'invalidSourceLost' | 'aborted';
export type Command = 'start' | 'pause' | 'resume' | 'completeRound' | 'skipRound' | 'stop' | 'sourceLost' | 'sourceRestored';
export type CompletionMode = 'auto' | 'manual' | 'either';
export type Curve = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';
export type Difficulty = 'beginner' | 'intermediate' | 'advanced';

export type Ramp = { from: number; to: number; curve?: Curve; intensity?: number };
export type Phase = { name?: string; durationMs?: number; targets?: Partial<Record<Axis, Ramp>> };
/** Drill schema v1 (ADR 0006, docs/drill-catalog.md). */
export type DrillDefinition = {
  schemaVersion: 1;
  name?: string;
  type: 'hold' | 'sweep' | 'progressive' | 'multistage';
  timing: 'timed' | 'selfPaced';
  controls: Axis[];
  phases: Phase[];
  difficulty?: Difficulty;
  tolerance?: number;
  controlTolerance?: Partial<Record<Axis, number>>;
  completionHoldMs?: number;
  rounds?: number;
  restMs?: number;
  countdownMs?: number;
};

/** Freeform session settings; omitted fields use the core defaults (see presets()). */
export type SessionSettings = {
  rounds?: number;
  restMs?: number;
  countdownMs?: number;
  timing?: 'timed' | 'selfPaced';
  roundDurationMs?: number;
  completion?: CompletionMode;
  maxSamplesPerRound?: number;
  maxAttemptsPerRound?: number;
  /** ACTIVE silence (no valid frame) longer than this is a source loss; default 100 ms. */
  maxFrameGapMs?: number;
};

type Common = { availableAxes: Axis[]; fluctuationAlerts?: boolean; noiseFloor?: number };
export type SessionConfig = Common & ({ controls: Axis[]; session?: SessionSettings } | { drill: DrillDefinition; completion?: CompletionMode });

type At = { atMs: number };
export type SessionEvent =
  | (At & { kind: 'stateChanged'; from: SessionState; to: SessionState })
  | (At & { kind: 'countdown'; round: number; remaining: number })
  | (At & { kind: 'roundStarted'; round: number })
  | (At & { kind: 'roundEnded'; round: number; outcome: Outcome })
  | (At & { kind: 'sessionComplete' })
  | (At & { kind: 'overlapOnset'; brake: number; throttle: number })
  | (At & { kind: 'fluctuation'; axis: Axis })
  | (At & { kind: 'primaryChanged'; axis: Axis });

export type TargetSample = { phase: number; values: Partial<Record<Axis, number>>; terminal: Axis[] | null; done: boolean };

export type Snapshot = {
  apiVersion: number;
  state: SessionState;
  mode?: 'freeform' | 'guided';
  controls?: Axis[];
  round: number;
  rounds: number;
  roundsDone: number;
  primary?: Axis;
  elapsedMs?: number;
  /** Timed guided drills only, while an attempt is open. */
  target?: TargetSample;
  /** No instantaneous target exists (spec 3.4); use terminalTargets. */
  selfPaced?: boolean;
  terminalTargets?: Partial<Record<Axis, number>>;
  tolerance?: Partial<Record<Axis, number>>;
  error?: string;
};

export type Result = {
  apiVersion: number;
  events: SessionEvent[];
  outOfOrder?: number;
  invalid?: number;
  frameError?: string;
  eventsDropped?: number;
  error?: string;
};

export type Presets = {
  apiVersion: number;
  difficulties: Partial<Record<Difficulty, { tolerance: number; completionHoldMs: number }>>;
  session?: SessionSettings;
  overlap?: Record<string, number>;
  fluctuation?: Record<string, number>;
};

/** Results contract v1 (docs/results-contract.md, docs/metric-definitions.md). No composite score exists. */
export type Trace = {
  /** ms since attempt start (active time, pauses excluded). */
  t: number[];
  /** Raw normalized actual; null = unavailable/gap (render as a gap, never 0). */
  actual: (number | null)[];
  /** Monotone movement trend used by the smoothness metric (label it "filtered"). */
  filtered?: (number | null)[];
  /** Timed guided only: desired at t. */
  desired?: (number | null)[];
  valid: boolean[];
};
export type ShapeTrace = { u: number[]; actual: (number | null)[]; desired: number[] };
export type Metric = {
  id: string;
  label: string;
  axis?: Axis;
  value: number | null;
  unit: string;
  better: 'lower' | 'higher' | 'n/a';
  /** false => render "N/A" with reason, never 100%. */
  applicable: boolean;
  reason?: string;
  coverage?: number;
  formulaVersion: string;
};
export type RoundResult = {
  round: number;
  attempt: number;
  outcome: Outcome;
  selfPaced: boolean;
  durationMs: number;
  phases: { index: number; name?: string; startMs: number }[];
  /** Full resolution; present only with results(true) (can be very large). */
  traces?: Partial<Record<Axis, Trace>>;
  /** Downsampled (<= ~1000 points per axis); always present. */
  display: Partial<Record<Axis, Trace>>;
  shape?: Partial<Record<Axis, ShapeTrace>>;
  accuracy: Metric[];
  smoothness: Metric[];
  timing: Metric[];
};
export type Recommendation = { id: string; text: string; change?: { path: string; from: unknown; to: unknown } };
export type SessionResults = {
  apiVersion: 1;
  mode: 'freeform' | 'guided';
  drill?: DrillDefinition;
  rounds: RoundResult[];
  consistency: Metric[];
  recommendations: Recommendation[];
  /** Set when there is no session. */
  error?: string;
};
/** Desired trajectory for a setup preview: x is ms (timed) or normalized progress u in [0,1] (self-paced). */
export type DrillPreview = {
  apiVersion: number;
  timed: boolean;
  xUnit: 'ms' | 'u';
  x: number[];
  values: Partial<Record<Axis, number[]>>;
  phases: { index: number; name?: string; startX: number }[];
  error?: string;
};

/** What subscribers get once per step (and per command). */
export type StepBatch = Result & { snapshot: Snapshot; bufferDropped: number };

/** Repeating scheduler; returns a cancel function. */
export type Every = (fn: () => void, ms: number) => () => void;

export type SessionBridgeOptions = { now?: () => number; every?: Every; hz?: number; maxBuffered?: number };

const TERMINAL: SessionState[] = ['COMPLETE', 'ABORTED'];
const idle: Snapshot = { apiVersion: API_VERSION, state: 'IDLE', round: 0, rounds: 0, roundsDone: 0 };
const defaultEvery: Every = (fn, ms) => {
  const id = setInterval(fn, ms);
  return () => clearInterval(id);
};

/** Merge several call results into one (events in call order, counters summed, first error kept). */
function merge(rs: Result[]): Result {
  const out: Result = { apiVersion: API_VERSION, events: [] };
  for (const r of rs) {
    out.events.push(...r.events);
    for (const k of ['outOfOrder', 'invalid', 'eventsDropped'] as const) if (r[k]) out[k] = (out[k] ?? 0) + (r[k] ?? 0);
    out.frameError ??= r.frameError;
    out.error ??= r.error;
  }
  return out;
}

export function createSessionBridge(api: TbtApi, opts: SessionBridgeOptions = {}) {
  const now = opts.now ?? (() => performance.now());
  const every = opts.every ?? defaultEvery;
  const hz = opts.hz ?? 60;
  const maxBuffered = opts.maxBuffered ?? 1024;
  const subs = new Set<(b: StepBatch) => void>();
  let buf: InputFrame[] = [];
  let bufferDropped = 0;
  let snap: Snapshot = idle;
  let cancel: (() => void) | undefined;

  const parse = <T>(s: string) => JSON.parse(s) as T;

  function stopPump() {
    cancel?.();
    cancel = undefined;
  }

  /** Observe buffered frames (if any) before anything else at time t. */
  function flush(): Result[] {
    if (buf.length === 0) return [];
    const frames = buf;
    buf = [];
    return [parse<Result>(api.observe(JSON.stringify(frames)))];
  }

  function publish(rs: Result[], t: number): Result {
    const r = merge(rs);
    snap = parse<Snapshot>(api.snapshot(t));
    const batch: StepBatch = { ...r, snapshot: snap, bufferDropped };
    bufferDropped = 0;
    if (TERMINAL.includes(snap.state)) stopPump();
    subs.forEach((f) => f(batch));
    return r;
  }

  /** One cadence step: observe(batch) -> tick(now) -> snapshot(now). */
  function step(): Result {
    const t = now();
    const rs = flush();
    rs.push(parse<Result>(api.tick(t)));
    return publish(rs, t);
  }

  return {
    /** Configure a fresh session (PREPARE) and start the fixed-cadence pump. Send command('start') to begin. */
    start(cfg: SessionConfig): Result {
      stopPump();
      buf = [];
      const r = parse<Result>(api.start(JSON.stringify({ apiVersion: API_VERSION, ...cfg })));
      if (r.error) return r;
      snap = parse<Snapshot>(api.snapshot(now()));
      cancel = every(step, 1000 / hz);
      return r;
    },
    /** The single command dispatcher (voice, keys, buttons all come here). */
    command(name: Command): Result {
      const t = now();
      const rs = flush();
      rs.push(parse<Result>(api.command(name, t)));
      return publish(rs, t);
    },
    /** Buffer a frame for the next step. Ignored unless a session is pumping. */
    pushFrame(f: InputFrame) {
      if (!cancel) return;
      if (buf.length >= maxBuffered) {
        buf.shift();
        bufferDropped++;
      }
      buf.push(f);
    },
    step,
    getSnapshot: () => snap,
    subscribe(fn: (b: StepBatch) => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
    presets: () => parse<Presets>(api.presets()),
    validateDrill: (d: DrillDefinition) => parse<Result>(api.validateDrill(JSON.stringify(d))),
    /** Metrics and traces of the finished attempts (read-only; in memory only, gone on the next start). */
    results: (includeFull = false) => parse<SessionResults>(api.results(includeFull)),
    /** Desired values at n (<= 500) evenly spaced points, computed by the core (no curve math in TS). */
    previewSamples: (d: DrillDefinition, n: number) => parse<DrillPreview>(api.previewSamples(JSON.stringify(d), n)),
    dispose: stopPump,
  };
}

export type SessionBridge = ReturnType<typeof createSessionBridge>;
