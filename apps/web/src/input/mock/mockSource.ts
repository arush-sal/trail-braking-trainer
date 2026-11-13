// MOCK input source: synthetic data only. Not a real device.
import type { Axis, InputFrame, Measurement } from '../types';

const CYCLE_MS = 10000;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};

function m(v: number): Measurement {
  return { available: true, rawValue: v, rawUnit: 'mock-normalized', normalized: v };
}

/** Repeating brake -> steer -> throttle pattern. Throttle is exactly 0 while brake > 0. */
export function mockFrame(seq: number, monoMs: number): InputFrame {
  const p = (((monoMs % CYCLE_MS) + CYCLE_MS) % CYCLE_MS) / CYCLE_MS;
  const brake = smooth(p / 0.2) * (1 - smooth((p - 0.2) / 0.3)); // up 0-0.2, down to 0 at 0.5
  const throttle = smooth((p - 0.5) / 0.3) * (1 - smooth((p - 0.9) / 0.1)); // up 0.5-0.8, off by 1.0
  const steering = Math.sin(Math.PI * clamp01((p - 0.15) / 0.65));
  return {
    schemaVersion: 1,
    source: 'mock',
    sourceId: 'mock-0',
    sequence: seq,
    receivedMonoMs: monoMs,
    brake: m(brake),
    steering: m(steering),
    throttle: m(throttle),
    quality: { gap: false, stale: false, calibrated: false },
  };
}

export type MockValues = Record<Axis, number>;
export type FollowOptions = { offset: number; noise: number; overlap?: boolean };

/**
 * MOCK "virtual driver" for hands-off guided sessions: follows a drill target with a
 * constant offset and uniform noise. Released (zero/absent) targets stay exactly 0 so the
 * mock never fakes a B+T overlap; `overlap` injects one on purpose.
 */
export function followValues(target: Partial<Record<Axis, number>> | null | undefined, o: FollowOptions): MockValues {
  const v = (a: Axis) => {
    const t = target?.[a] ?? 0;
    if (t === 0) return 0;
    const x = t + Math.sign(t) * o.offset + (Math.random() * 2 - 1) * o.noise;
    return a === 'steering' ? Math.max(-1, Math.min(1, x)) : clamp01(x);
  };
  const out = { brake: v('brake'), steering: v('steering'), throttle: v('throttle') };
  return o.overlap ? { ...out, brake: 0.6, throttle: 0.6 } : out;
}

/** `values` (if given and non-null) overrides the built-in cycle for that sample. */
export function startMockSource(onFrame: (f: InputFrame) => void, opts: { hz?: number; values?: () => MockValues | null } = {}): () => void {
  const hz = opts.hz ?? 60;
  let seq = 0;
  const id = setInterval(() => {
    const t = performance.now();
    const f = mockFrame(seq++, t);
    const v = opts.values?.();
    onFrame(v ? { ...f, brake: m(v.brake), steering: m(v.steering), throttle: m(v.throttle) } : f);
  }, 1000 / hz);
  return () => clearInterval(id);
}
