import { describe, expect, it } from 'vitest';
import { applyRange, createRangeCapture, defaultMapping, detectChange, normalize, setCenter } from './normalize';

const ax = (o = {}) => ({ ...defaultMapping('p#0', 'axis', 0), ...o });

describe('normalize', () => {
  it('maps default axis [-1,1] to pedal [0,1]', () => {
    expect(normalize(-1, ax(), 'brake')).toBe(0);
    expect(normalize(0, ax(), 'brake')).toBe(0.5);
    expect(normalize(1, ax(), 'throttle')).toBe(1);
  });
  it('inverts, clamps and applies deadzone', () => {
    expect(normalize(1, ax({ invert: true }), 'brake')).toBe(0);
    expect(normalize(5, ax(), 'brake')).toBe(1);
    expect(normalize(-0.9, ax({ deadzone: 0.1 }), 'brake')).toBe(0);
    expect(normalize(0, ax({ deadzone: 0.5 }), 'brake')).toBe(0);
    expect(normalize(1, ax({ deadzone: 0.5 }), 'brake')).toBe(1);
  });
  it('button as pedal uses [0,1]', () => {
    const b = defaultMapping('p#0', 'button', 6);
    expect(normalize(0.25, b, 'brake')).toBe(0.25);
  });
  it('steering is signed around center with asymmetric halves', () => {
    const m = ax({ center: 0.2, min: -1, max: 1 });
    expect(normalize(0.2, m, 'steering')).toBe(0);
    expect(normalize(1, m, 'steering')).toBe(1);
    expect(normalize(-1, m, 'steering')).toBe(-1);
    expect(normalize(-0.4, m, 'steering')).toBeCloseTo(-0.5);
    expect(normalize(1, ax({ invert: true }), 'steering')).toBe(-1);
    expect(normalize(0.05, ax({ deadzone: 0.1 }), 'steering')).toBe(0);
  });
  it('null / non-finite / degenerate range is null, not 0', () => {
    expect(normalize(null, ax(), 'brake')).toBeNull();
    expect(normalize(NaN, ax(), 'brake')).toBeNull();
    expect(normalize(0, ax({ min: 1, max: 1 }), 'brake')).toBeNull();
    expect(normalize(1, ax({ center: 1, max: 1 }), 'steering')).toBeNull();
  });
});

describe('calibration', () => {
  it('captures range and center', () => {
    const c = createRangeCapture();
    expect(c.result()).toBeNull();
    [0.1, 0.7, 0.3].forEach((v) => c.add(v));
    const r = c.result()!;
    expect(r).toEqual({ min: 0.1, max: 0.7 });
    const m = applyRange(ax(), r);
    expect(m.calibrated).toBe(true);
    expect(normalize(0.7, m, 'brake')).toBe(1);
    expect(setCenter(ax(), 0.3)).toMatchObject({ center: 0.3, calibrated: true });
  });
});

describe('detectChange', () => {
  const base = [{ key: 'a#0', axes: [0, 0.1], buttons: [0, 0] }];
  it('picks the largest deliberate change and ignores jitter', () => {
    expect(detectChange(base, [{ key: 'a#0', axes: [0.02, 0.1], buttons: [0.05, 0] }])).toBeNull();
    const hit = detectChange(base, [{ key: 'a#0', axes: [0.3, 1.1], buttons: [0.3, 0] }]);
    expect(hit).toMatchObject({ deviceId: 'a#0', kind: 'axis', index: 1 });
    const b = detectChange(base, [{ key: 'a#0', axes: [0, 0.1], buttons: [0, 0.9] }]);
    expect(b).toMatchObject({ kind: 'button', index: 1 });
  });
});
