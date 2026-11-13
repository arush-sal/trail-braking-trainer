// MOCK input source: synthetic data only. Not a real device.
import type { InputFrame, Measurement } from '../types';

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

export function startMockSource(onFrame: (f: InputFrame) => void, opts: { hz?: number } = {}): () => void {
  const hz = opts.hz ?? 60;
  let seq = 0;
  const id = setInterval(() => onFrame(mockFrame(seq++, performance.now())), 1000 / hz);
  return () => clearInterval(id);
}
