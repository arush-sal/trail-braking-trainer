import type { Axis } from '../../input/types';

export const MIN_HZ = 220;
export const MAX_HZ = 660;
export const CENTRE_HZ = Math.sqrt(MIN_HZ * MAX_HZ);
export const DEFAULT_GAIN = 0.15;
export const MAX_GAIN = 0.3; // hard cap, ear/hearing safety

export const clampGain = (g: number) => (Number.isFinite(g) ? Math.min(MAX_GAIN, Math.max(0, g)) : 0);

/** Position -> Hz (exponential). null/NaN => null (silence), never treated as 0. */
export function positionToFreq(value: number | null, axis: Axis, neutral = 0): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (axis === 'steering') {
    const v = Math.min(1, Math.max(-1, value));
    return v >= 0 ? CENTRE_HZ * (MAX_HZ / CENTRE_HZ) ** v : CENTRE_HZ * (MIN_HZ / CENTRE_HZ) ** -v;
  }
  if (value < neutral) return null; // pedal rest zone: silent to reduce fatigue
  const t = Math.min(1, Math.max(0, value));
  return MIN_HZ * (MAX_HZ / MIN_HZ) ** t;
}

export type LatencySummary = { count: number; p50: number; p95: number; max: number };

/** Bounded ring buffer of control-update latencies (ms). */
export class LatencyStats {
  private buf: number[] = [];
  private i = 0;
  constructor(private cap = 2000) {}
  add(ms: number) {
    if (this.buf.length < this.cap) this.buf.push(ms);
    else this.buf[this.i] = ms;
    this.i = (this.i + 1) % this.cap;
  }
  summary(): LatencySummary {
    const n = this.buf.length;
    if (!n) return { count: 0, p50: 0, p95: 0, max: 0 };
    const s = [...this.buf].sort((a, b) => a - b);
    const q = (p: number) => s[Math.max(0, Math.ceil(p * n) - 1)];
    return { count: n, p50: q(0.5), p95: q(0.95), max: s[n - 1] };
  }
}
