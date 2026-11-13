import { describe, expect, it } from 'vitest';
import { MAX_HZ, MIN_HZ } from '../synth/mapping';
import { ALERT_SPECS, IN_TOL_HZ, ScenePlanner, type Plan } from './plan';
import type { AlertKind, AudioScene } from './types';

const base = (o: Partial<AudioScene> = {}): AudioScene => ({
  mode: 'freeform', primary: 'brake', actual: { brake: null, steering: null, throttle: null }, nowMs: 0, ...o,
});
/** Feed a trace at 60 Hz; returns last plan. */
function run(p: ScenePlanner, f: (t: number) => number | null, secs: number, o: Partial<AudioScene> = {}, axis: 'brake' | 'steering' = 'brake', t0 = 0): Plan {
  let plan!: Plan;
  for (let t = 0; t <= secs; t += 1 / 60) {
    plan = p.plan(base({ ...o, primary: o.primary === undefined ? axis : o.primary, actual: { brake: null, steering: null, throttle: null, [axis]: f(t) }, nowMs: t0 + t * 1000 }));
  }
  return plan;
}
const at = (v: number, o: Partial<AudioScene> = {}, axis: 'brake' | 'steering' = 'brake') => run(new ScenePlanner(), () => v, 0.2, o, axis);

describe('freeform position', () => {
  it('bounded, monotonic, primary foreground', () => {
    let prev = 0;
    for (const v of [0.1, 0.3, 0.5, 0.8, 1, 1.5]) {
      const vp = at(v).voices.brake;
      expect(vp.freq!).toBeGreaterThan(prev - 1e-9);
      expect(vp.freq!).toBeGreaterThanOrEqual(MIN_HZ);
      expect(vp.freq!).toBeLessThanOrEqual(MAX_HZ);
      expect(vp.gain).toBe(1);
      prev = vp.freq!;
    }
  });
  it('rest zone silent with hysteresis; steering centre silent', () => {
    const p = new ScenePlanner();
    expect(run(p, () => 0.01, 0.1).voices.brake.freq).toBeNull();
    expect(run(p, () => 0.05, 0.1, {}, 'brake', 1000).voices.brake.freq).not.toBeNull();
    expect(run(p, () => 0.025, 0.1, {}, 'brake', 2000).voices.brake.freq).not.toBeNull(); // held by hysteresis
    expect(run(p, () => 0.01, 0.1, {}, 'brake', 3000).voices.brake.freq).toBeNull();
    expect(at(0, {}, 'steering').voices.steering.freq).toBeNull();
    expect(at(-0.5, {}, 'steering').voices.steering.freq!).toBeLessThan(at(0.5, {}, 'steering').voices.steering.freq!);
  });
  it('null is silence, never 0', () => {
    const v = at(NaN).voices.brake;
    expect(v.freq).toBeNull();
    expect(v.gain).toBe(0);
    expect(run(new ScenePlanner(), () => null, 0.1).voices.brake.freq).toBeNull();
  });
  it('config neutral 0 disables the rest zone', () => {
    expect(run(new ScenePlanner({ neutral: 0 }), () => 0.01, 0.1).voices.brake.freq).not.toBeNull();
  });
});

describe('movement', () => {
  const ramp = (rate: number) => (t: number) => 0.5 + rate * t;
  it('direction and rate', () => {
    const up = run(new ScenePlanner(), ramp(0.5), 1).voices.brake;
    const down = run(new ScenePlanner(), ramp(-0.3), 1).voices.brake;
    const fast = run(new ScenePlanner(), ramp(0.9), 0.9).voices.brake;
    const still = at(0.5).voices.brake;
    expect(up.partialRatio).toBeGreaterThan(1);
    expect(down.partialRatio).toBeLessThan(1);
    expect(up.partialLevel).toBeGreaterThan(0.3);
    expect(fast.partialLevel).toBeGreaterThan(up.partialLevel);
    expect(still.partialLevel).toBe(0);
  });
  it('jitter is rough, smooth ramp is not', () => {
    const smooth = run(new ScenePlanner(), ramp(0.3), 1.5).voices.brake;
    const jitter = run(new ScenePlanner(), (t) => 0.5 + 0.3 * t + (Math.round(t * 60) % 2 ? 0.02 : -0.02), 1.5).voices.brake;
    expect(smooth.roughDepth).toBeLessThan(0.1);
    expect(jitter.roughDepth).toBeGreaterThan(0.6);
  });
  it('gap resets tracker; non-primary has no movement signal', () => {
    const p = new ScenePlanner();
    run(p, ramp(0.5), 1);
    expect(run(p, () => 0.5, 0.05, {}, 'brake', 5000).voices.brake.partialLevel).toBe(0);
    const moving = run(new ScenePlanner(), ramp(0.5), 1, { primary: 'steering' }).voices.brake;
    expect(moving.partialLevel).toBe(0);
    expect(moving.gain).toBeLessThan(0.5);
  });
});

describe('primary priority', () => {
  it('primary louder than others and stable across amplitude', () => {
    const p = new ScenePlanner();
    for (const [b, s] of [[0.9, 0.1], [0.1, 0.9], [0.5, 0.5]]) {
      const plan = p.plan(base({ primary: 'steering', actual: { brake: b, steering: s, throttle: null }, nowMs: Math.random() * 1e6 }));
      expect(plan.voices.steering.gain).toBeGreaterThan(plan.voices.brake.gain);
      expect(plan.diag.primary).toBe('steering');
    }
  });
});

describe('guided dual-tone', () => {
  const dual = (a: number, d: number, tol = 0.05) => at(a, { mode: 'guided-dual', desired: { brake: d }, tolerance: { brake: tol } });
  it('distinct timbres, beat grows with error, merges within tolerance', () => {
    const near = dual(0.5, 0.5);
    expect(near.voices.target.wave).not.toBe(near.voices.brake.wave);
    expect(near.diag.beatHz).toBe(0);
    expect(near.voices.target.freq).toBeCloseTo(near.voices.brake.freq!);
    expect(dual(0.52, 0.5).diag.beatHz).toBe(0);
    let prev = -1;
    for (const a of [0.52, 0.56, 0.6, 0.7, 0.9]) {
      const b = dual(a, 0.5).diag.beatHz!;
      expect(b).toBeGreaterThanOrEqual(prev);
      prev = b;
    }
    expect(prev).toBeGreaterThan(20);
  });
  it('no painful frequencies, target not louder than primary', () => {
    for (const a of [0.1, 1]) for (const d of [0.1, 1]) {
      const pl = dual(a, d);
      for (const v of Object.values(pl.voices)) if (v.freq) expect(v.freq * Math.max(1, v.partialRatio)).toBeLessThanOrEqual(2000);
      expect(pl.voices.target.gain).toBeLessThanOrEqual(pl.voices.brake.gain);
    }
  });
  it('falls back to position only without desired', () => {
    const pl = at(0.5, { mode: 'guided-dual' });
    expect(pl.voices.target.freq).toBeNull();
    expect(pl.diag.beatHz).toBeNull();
  });
});

describe('guided deviation', () => {
  const dev = (a: number, d: number, axis: 'brake' | 'steering' = 'brake') => at(a, { mode: 'guided-deviation', primary: axis, desired: { [axis]: d }, tolerance: { [axis]: 0.05 } }, axis);
  it('sign = pitch, magnitude = pulse rate, symmetric', () => {
    const above = dev(0.7, 0.5).voices.cue, below = dev(0.3, 0.5).voices.cue;
    expect(above.freq!).toBeGreaterThan(below.freq!);
    expect(above.pulseRate).toBeCloseTo(below.pulseRate);
    expect(above.pulseRate).toBeGreaterThan(0);
    expect(dev(0.9, 0.5).voices.cue.pulseRate).toBeGreaterThan(above.pulseRate);
    expect(dev(0.2, 0.5).voices.cue.pulseRate).toBeGreaterThan(below.pulseRate);
    expect(dev(0.7, 0.5).diag.deviation).toBeCloseTo(0.2);
    expect(dev(0.3, 0.5).diag.deviation).toBeCloseTo(-0.2);
    const s1 = dev(0.4, 0.1, 'steering').voices.cue, s2 = dev(-0.2, 0.1, 'steering').voices.cue;
    expect(s1.pulseRate).toBeCloseTo(s2.pulseRate);
    expect(s1.freq).not.toBe(s2.freq);
  });
  it('in tolerance is a distinct steady tone between above and below pitches, hysteresis', () => {
    const inn = dev(0.52, 0.5);
    const c = inn.voices.cue;
    expect(inn.diag.inTolerance).toBe(true);
    expect(c.freq).toBe(IN_TOL_HZ);
    expect(c.pulseRate).toBe(0);
    expect(c.freq!).toBeGreaterThan(dev(0.3, 0.5).voices.cue.freq!);
    expect(c.freq!).toBeLessThan(dev(0.7, 0.5).voices.cue.freq!);
    const p = new ScenePlanner();
    const sc = (a: number, t: number) => p.plan(base({ mode: 'guided-deviation', desired: { brake: 0.5 }, tolerance: { brake: 0.05 }, actual: { brake: a, steering: null, throttle: null }, nowMs: t }));
    sc(0.5, 0);
    expect(sc(0.555, 16).diag.inTolerance).toBe(true); // 0.055 < 0.05*1.25
    expect(sc(0.57, 32).diag.inTolerance).toBe(false);
  });
});

describe('self-paced honesty', () => {
  const sp = (a: number, o: Partial<AudioScene> = {}) => at(a, { mode: 'guided-selfpaced', ...o });
  it('never uses desired', () => {
    const a = sp(0.4, { desired: { brake: 0.9 }, tolerance: { brake: 0.05 } });
    const b = sp(0.4, { tolerance: { brake: 0.05 } });
    expect(a).toEqual(b);
    expect(a.voices.target.freq).toBeNull();
    expect(a.voices.cue.freq).toBeNull();
    expect(a.diag.deviation).toBeNull();
    expect(a.diag.beatHz).toBeNull();
  });
  it('end-state cue only near terminal; closer = faster; steady at terminal', () => {
    const t = { terminal: { brake: 1 } };
    expect(sp(0.2, t).voices.cue.freq).toBeNull();
    const far = sp(0.7, t).voices.cue, near = sp(0.9, t).voices.cue;
    expect(far.pulseRate).toBeGreaterThan(0);
    expect(near.pulseRate).toBeGreaterThan(far.pulseRate);
    const done = sp(0.98, t);
    expect(done.voices.cue.freq).toBe(IN_TOL_HZ);
    expect(done.voices.cue.pulseRate).toBe(0);
    expect(done.diag.terminalDistance).toBeCloseTo(-0.02);
    expect(sp(1.2, t).voices.cue.freq!).toBeGreaterThan(sp(0.9, t).voices.cue.freq!); // overshoot pitch differs
  });
});

describe('alert specs', () => {
  const kinds = Object.keys(ALERT_SPECS) as AlertKind[];
  it('covers all kinds with distinct signatures', () => {
    expect(kinds).toHaveLength(7);
    const sig = kinds.map((k) => JSON.stringify(ALERT_SPECS[k]));
    expect(new Set(sig).size).toBe(7);
  });
  it('overlap is loudest, starts at 0, no painful pitch', () => {
    for (const k of kinds) {
      expect(ALERT_SPECS[k].notes[0].atMs).toBe(0);
      expect(ALERT_SPECS.overlap.gain).toBeGreaterThanOrEqual(ALERT_SPECS[k].gain);
      for (const n of ALERT_SPECS[k].notes) expect(n.freq).toBeLessThanOrEqual(1200);
    }
    const o = new Set(ALERT_SPECS.overlap.notes.map((n) => n.freq));
    for (const k of kinds.filter((x) => x !== 'overlap')) expect(ALERT_SPECS[k].notes.map((n) => n.freq).join()).not.toBe([...o].join());
  });
});
