// Pure drill form model (spec 3.4): form state in friendly units (percent, seconds) -> DrillDefinition.
// buildDrill is deterministic; legality (B/T exclusion, B->S->T order, continuity) is decided by the Go
// core's validation, never re-implemented here. Only legal contiguous selections are constructible.
import type { Axis } from '../../input/types';
import type { CompletionMode, Curve, Difficulty, DrillDefinition, Phase, Ramp } from '../../wasm/sessionBridge';

export const LEGAL: Axis[][] = [['brake'], ['steering'], ['throttle'], ['brake', 'steering'], ['steering', 'throttle'], ['brake', 'steering', 'throttle']];
export const AXES: Axis[] = ['brake', 'steering', 'throttle'];
export const SHORT = (c: Axis[]) => c.map((a) => a[0]!.toUpperCase()).join('+');

export type DrillType = DrillDefinition['type'];
export type RampForm = { from: number; to: number; curve: Curve; intensity: number };
export type PhaseForm = { durationS: number; targets: Partial<Record<Axis, RampForm>> };
export type Levels = Partial<Record<Axis, { from: number; to: number }>>;

/** Values are percent of full travel (steering: signed percent, provisional scale). */
export type FormState = {
  name: string;
  selection: number; // index into LEGAL
  type: DrillType;
  timing: 'timed' | 'selfPaced';
  durationS: number; // single-phase types, timed
  single: Levels; // hold uses from; sweep/progressive use from -> to
  curve: Curve; // progressive
  intensity: number;
  phases: PhaseForm[]; // multistage
  completion: CompletionMode; // selfPaced
  holdMs: number | null; // selfPaced auto-completion hold override
  difficulty: Difficulty;
  tolerancePct: number | null;
  controlTolerancePct: Partial<Record<Axis, number>>;
  rounds: number;
  restS: number;
  countdownS: number;
};

export const defaultForm = (): FormState => ({
  name: 'Custom drill', selection: 0, type: 'hold', timing: 'timed', durationS: 6, single: { brake: { from: 40, to: 40 } },
  curve: 'easeOut', intensity: 1, phases: [], completion: 'either', holdMs: null, difficulty: 'beginner', tolerancePct: null,
  controlTolerancePct: {}, rounds: 8, restS: 5, countdownS: 3,
});

const pct = (v: number) => Math.round(v * 1e4) / 1e6; // 40 -> 0.4 without float noise
const unpct = (v: number) => Math.round(v * 1e6) / 1e4;
const ms = (s: number) => Math.round(s * 1000);
export const controlsOf = (f: Pick<FormState, 'selection'>) => LEGAL[f.selection]!;

function ramp(r: { from: number; to: number }, curve: Curve | null, intensity: number): Ramp {
  const out: Ramp = { from: pct(r.from), to: pct(r.to) };
  if (curve && curve !== 'linear' && r.from !== r.to) {
    out.curve = curve;
    out.intensity = intensity;
  }
  return out;
}

export function buildDrill(f: FormState): DrillDefinition {
  const controls = controlsOf(f);
  const timed = f.timing === 'timed';
  let phases: Phase[];
  if (f.type === 'multistage') {
    phases = f.phases.map((p) => {
      const targets: Phase['targets'] = {};
      for (const a of controls) {
        const r = p.targets[a];
        if (r) targets[a] = ramp(r, r.curve, r.intensity);
      }
      return { ...(timed ? { durationMs: ms(p.durationS) } : {}), targets };
    });
  } else {
    const targets: Phase['targets'] = {};
    for (const a of controls) {
      const r = f.single[a] ?? { from: 0, to: 0 };
      const level = f.type === 'hold' ? { from: r.from, to: r.from } : r;
      targets[a] = ramp(level, f.type === 'progressive' ? f.curve : null, f.intensity);
    }
    phases = [{ ...(timed ? { durationMs: ms(f.durationS) } : {}), targets }];
  }
  const d: DrillDefinition = {
    schemaVersion: 1, name: f.name, type: f.type, timing: f.timing, controls: [...controls], phases, difficulty: f.difficulty,
    rounds: f.rounds, restMs: ms(f.restS), countdownMs: ms(f.countdownS),
  };
  if (f.tolerancePct !== null) d.tolerance = pct(f.tolerancePct);
  const ct = controls.filter((a) => f.controlTolerancePct[a] != null);
  if (ct.length) d.controlTolerance = Object.fromEntries(ct.map((a) => [a, pct(f.controlTolerancePct[a]!)]));
  if (!timed && f.holdMs !== null) d.completionHoldMs = f.holdMs;
  return d;
}

/** Load a definition (e.g. a preset) into the editor. Inverse of buildDrill for schema-v1 drills. */
export function fromDrill(d: DrillDefinition): FormState {
  const base = defaultForm();
  const selection = LEGAL.findIndex((c) => c.join() === d.controls.join());
  const toForm = (r: Ramp): RampForm => ({ from: unpct(r.from), to: unpct(r.to), curve: r.curve ?? 'linear', intensity: r.intensity ?? 1 });
  const first = d.phases[0]?.targets ?? {};
  const f: FormState = {
    ...base, name: d.name ?? base.name, selection: Math.max(0, selection), type: d.type, timing: d.timing,
    durationS: (d.phases[0]?.durationMs ?? 6000) / 1000, difficulty: d.difficulty ?? 'beginner',
    tolerancePct: d.tolerance != null ? unpct(d.tolerance) : null,
    controlTolerancePct: Object.fromEntries(Object.entries(d.controlTolerance ?? {}).map(([a, v]) => [a, unpct(v)])),
    holdMs: d.completionHoldMs ?? null, rounds: d.rounds ?? base.rounds,
    restS: (d.restMs ?? 5000) / 1000, countdownS: (d.countdownMs ?? 3000) / 1000,
    single: {}, phases: [],
  };
  if (d.type === 'multistage') {
    f.phases = d.phases.map((p) => ({
      durationS: (p.durationMs ?? 1000) / 1000,
      targets: Object.fromEntries(Object.entries(p.targets ?? {}).map(([a, r]) => [a, toForm(r)])),
    }));
  } else {
    for (const a of d.controls) f.single[a] = { from: unpct(first[a]?.from ?? 0), to: unpct(first[a]?.to ?? 0) };
    const moving = Object.values(first).find((r) => r.curve && r.curve !== 'linear');
    if (moving) Object.assign(f, { curve: moving.curve, intensity: moving.intensity ?? 1 });
  }
  return f;
}

const hold = (v: number): RampForm => ({ from: v, to: v, curve: 'linear', intensity: 1 });

/** Change the control subset; drop targets of deselected controls and give new ones neutral values. */
export function setSelection(f: FormState, selection: number): FormState {
  const controls = LEGAL[selection]!;
  const keep = <T>(m: Partial<Record<Axis, T>>) => Object.fromEntries(Object.entries(m).filter(([a]) => controls.includes(a as Axis))) as Partial<Record<Axis, T>>;
  const single = keep(f.single);
  for (const a of controls) single[a] ??= { from: 0, to: 0 };
  return {
    ...f, selection, single, controlTolerancePct: keep(f.controlTolerancePct),
    phases: f.phases.map((p) => ({ ...p, targets: keep(p.targets) })),
  };
}

/** Switching to multistage seeds a two-phase hold-then-release from the single-phase levels. */
export function setType(f: FormState, type: DrillType): FormState {
  if (type !== 'multistage' || f.phases.length) return { ...f, type };
  const a = controlsOf(f)[0]!;
  const v = f.single[a]?.from || 40;
  return { ...f, type, phases: [{ durationS: 1, targets: { [a]: hold(v) } }, { durationS: 1, targets: { [a]: { ...hold(v), to: 0 } } }] };
}

export function addPhase(f: FormState): FormState {
  const last = f.phases.at(-1);
  const targets = Object.fromEntries(Object.entries(last?.targets ?? {}).map(([a, r]) => [a, hold(r.to)]));
  return { ...f, phases: [...f.phases, { durationS: 1, targets }] };
}

export const removePhase = (f: FormState, i: number): FormState => ({ ...f, phases: f.phases.filter((_, j) => j !== i) });

export function movePhase(f: FormState, i: number, dir: -1 | 1): FormState {
  const j = i + dir;
  if (j < 0 || j >= f.phases.length) return f;
  const phases = [...f.phases];
  [phases[i], phases[j]] = [phases[j]!, phases[i]!];
  return { ...f, phases };
}

export const setPhase = (f: FormState, i: number, patch: Partial<PhaseForm>): FormState => ({ ...f, phases: f.phases.map((p, j) => (j === i ? { ...p, ...patch } : p)) });

/** Edit one control's ramp in a phase; following phases that start where this one ended keep continuity (holds cascade). */
export function setPhaseRamp(f: FormState, i: number, a: Axis, patch: Partial<RampForm>): FormState {
  const old = f.phases[i]?.targets[a];
  if (!old) return f;
  const neu = { ...old, ...patch };
  let out: FormState = { ...f, phases: f.phases.map((p, j) => (j === i ? { ...p, targets: { ...p.targets, [a]: neu } } : p)) };
  const nx = f.phases[i + 1]?.targets[a];
  if (patch.to !== undefined && nx && nx.from === old.to) {
    out = setPhaseRamp(out, i + 1, a, nx.from === nx.to ? { from: neu.to, to: neu.to } : { from: neu.to });
  }
  return out;
}

export function togglePhaseControl(f: FormState, i: number, a: Axis, on: boolean): FormState {
  const prevEnd = f.phases[i - 1]?.targets[a]?.to ?? 0;
  return {
    ...f,
    phases: f.phases.map((p, j) => {
      if (j !== i) return p;
      const targets = { ...p.targets };
      if (on) targets[a] = hold(prevEnd);
      else delete targets[a];
      return { ...p, targets };
    }),
  };
}

/** The "path" prefix of a core validation message ("phases[1].targets.brake.from: ..."), or "". */
export function fieldErrorPath(msg: string): string {
  return /^([A-Za-z][A-Za-z0-9_.[\]*]*): /.exec(msg)?.[1] ?? '';
}
