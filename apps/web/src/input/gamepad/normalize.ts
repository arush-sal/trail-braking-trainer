import type { Axis } from '../types';

export type Kind = 'axis' | 'button';
export type Mapping = {
  deviceId: string; // deviceKey(): gamepad.id + '#' + ordinal among same-id pads
  kind: Kind;
  index: number;
  invert: boolean;
  min: number;
  max: number;
  center: number; // used for steering only
  deadzone: number; // fraction [0,1)
  calibrated?: boolean; // true once the user captured a range or set a center
};

// UNVERIFIED defaults (no hardware tested): axis raw [-1,1] -> pedal [0,1] assumes rest at -1.
// Many pedals rest at +1 and need `invert`. Analog buttons default to [0,1].
export function defaultMapping(deviceId: string, kind: Kind, index: number): Mapping {
  const min = kind === 'axis' ? -1 : 0;
  return { deviceId, kind, index, invert: false, min, max: 1, center: (min + 1) / 2, deadzone: 0 };
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Brake/throttle -> [0,1]; steering -> signed [-1,1] (provisional practice scale, ADR 0003; not degrees). */
export function normalize(raw: number | null | undefined, m: Mapping, axis: Axis): number | null {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return null;
  const dz = clamp(m.deadzone, 0, 0.99);
  if (axis === 'steering') {
    const half = raw >= m.center ? m.max - m.center : m.center - m.min;
    if (!(half > 0)) return null; // invalid calibration, do not fake 0
    let v = clamp((raw - m.center) / half, -1, 1);
    if (m.invert) v = -v;
    const a = Math.abs(v);
    return a <= dz ? 0 : (Math.sign(v) * (a - dz)) / (1 - dz);
  }
  const span = m.max - m.min;
  if (span === 0) return null;
  let t = clamp((raw - m.min) / span, 0, 1);
  if (m.invert) t = 1 - t;
  return t <= dz ? 0 : (t - dz) / (1 - dz);
}

export type RangeCapture = { add(raw: number): void; result(): { min: number; max: number } | null };
export function createRangeCapture(): RangeCapture {
  let min = Infinity;
  let max = -Infinity;
  return {
    add(raw) {
      if (!Number.isFinite(raw)) return;
      min = Math.min(min, raw);
      max = Math.max(max, raw);
    },
    result: () => (max > min ? { min, max } : null),
  };
}
export const applyRange = (m: Mapping, r: { min: number; max: number }): Mapping => ({ ...m, ...r, calibrated: true });
export const setCenter = (m: Mapping, raw: number): Mapping => ({ ...m, center: raw, calibrated: true });

export type PadSnapshot = { key: string; axes: readonly number[]; buttons: readonly number[] };
export type Detected = { deviceId: string; kind: Kind; index: number; delta: number };

/** Largest deliberate change vs baseline. Axis deltas are halved (span 2) so axes and buttons compare on [0,1]. */
export function detectChange(baseline: PadSnapshot[], live: PadSnapshot[], threshold = 0.25): Detected | null {
  let best: Detected | null = null;
  for (const l of live) {
    const b = baseline.find((p) => p.key === l.key);
    if (!b) continue;
    const consider = (kind: Kind, vals: readonly number[], base: readonly number[], scale: number) =>
      vals.forEach((v, index) => {
        const delta = Math.abs(v - (base[index] ?? v)) * scale;
        if (delta >= threshold && (!best || delta > best.delta)) best = { deviceId: l.key, kind, index, delta };
      });
    consider('axis', l.axes, b.axes, 0.5);
    consider('button', l.buttons, b.buttons, 1);
  }
  return best;
}
