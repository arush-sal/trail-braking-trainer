import { describe, expect, it } from 'vitest';
import { LEGAL, addPhase, buildDrill, defaultForm, fieldErrorPath, fromDrill, movePhase, removePhase, setPhaseRamp, setSelection } from './form';
import { PRESETS } from './presets';

describe('LEGAL selections', () => {
  it('are the six contiguous ranges and never B+T', () => {
    expect(LEGAL.map((c) => c.join('+'))).toEqual(['brake', 'steering', 'throttle', 'brake+steering', 'steering+throttle', 'brake+steering+throttle']);
    expect(LEGAL.some((c) => c.length === 2 && c[0] === 'brake' && c[1] === 'throttle')).toBe(false);
  });
});

describe('buildDrill', () => {
  it('is deterministic and builds a timed hold in normalized units', () => {
    const f = { ...defaultForm(), name: 'h', type: 'hold' as const, durationS: 6, single: { brake: { from: 40, to: 40 } } };
    expect(buildDrill(f)).toEqual(buildDrill(structuredClone(f)));
    expect(buildDrill(f)).toEqual({
      schemaVersion: 1, name: 'h', type: 'hold', timing: 'timed', controls: ['brake'], difficulty: 'beginner',
      rounds: 8, restMs: 5000, countdownMs: 3000,
      phases: [{ durationMs: 6000, targets: { brake: { from: 0.4, to: 0.4 } } }],
    });
  });

  it('progressive carries curve+intensity only on moving ramps; sweep is linear (curve omitted)', () => {
    const base = { ...defaultForm(), durationS: 3, single: { brake: { from: 80, to: 0 } } };
    expect(buildDrill({ ...base, type: 'progressive', curve: 'easeOut', intensity: 2 }).phases[0]!.targets).toEqual({ brake: { from: 0.8, to: 0, curve: 'easeOut', intensity: 2 } });
    expect(buildDrill({ ...base, type: 'sweep', curve: 'easeOut' }).phases[0]!.targets).toEqual({ brake: { from: 0.8, to: 0 } });
  });

  it('self-paced omits durations, adds completionHoldMs and tolerance overrides only for selected controls', () => {
    const f = { ...defaultForm(), timing: 'selfPaced' as const, holdMs: 700, tolerancePct: 8, controlTolerancePct: { brake: 4, throttle: 3 } };
    const d = buildDrill(f);
    expect(d.phases[0]!.durationMs).toBeUndefined();
    expect(d).toMatchObject({ completionHoldMs: 700, tolerance: 0.08, controlTolerance: { brake: 0.04 } });
    expect(d.controlTolerance).not.toHaveProperty('throttle');
  });

  it('steering is signed percent', () => {
    const f = { ...setSelection(defaultForm(), 1), type: 'sweep' as const, single: { steering: { from: -50, to: 50 } } };
    expect(buildDrill(f).phases[0]!.targets).toEqual({ steering: { from: -0.5, to: 0.5 } });
  });
});

describe('presets round trip through the form', () => {
  for (const p of PRESETS) {
    it(p.id, () => expect(buildDrill(fromDrill(p.def))).toMatchObject(p.def));
  }
});

describe('phase editing', () => {
  const full = () => fromDrill(PRESETS.find((p) => p.def.name === 'Full trail brake')!.def);

  it('add copies the final value as a hold, remove/move reorder', () => {
    let f = full();
    const n = f.phases.length;
    f = addPhase(f);
    expect(f.phases).toHaveLength(n + 1);
    expect(f.phases.at(-1)!.targets.throttle).toMatchObject({ from: 80, to: 80 });
    f = movePhase(f, n, -1);
    expect(f.phases[n - 1]!.targets.throttle).toMatchObject({ from: 80, to: 80 });
    expect(removePhase(f, 0).phases).toHaveLength(n);
  });

  it('keeps continuity: changing a ramp end moves a matching next start', () => {
    const f = setPhaseRamp(full(), 1, 'steering', { to: 40 });
    expect(f.phases[2]!.targets.steering!.from).toBe(40);
  });

  it('changing selection drops targets of unselected controls', () => {
    const f = setSelection(full(), 3); // B+S
    expect(f.phases.every((p) => !p.targets.throttle)).toBe(true);
    expect(buildDrill(f).controls).toEqual(['brake', 'steering']);
  });
});

describe('fieldErrorPath', () => {
  it('extracts the path prefix of a core message', () => {
    expect(fieldErrorPath('phases[1].targets.brake.from: 2 outside [0,1]')).toBe('phases[1].targets.brake.from');
    expect(fieldErrorPath('rounds: must be >= 1, got 0')).toBe('rounds');
    expect(fieldErrorPath('something odd')).toBe('');
  });
});
