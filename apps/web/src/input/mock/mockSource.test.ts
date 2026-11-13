import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFrame, startMockSource } from './mockSource';
import type { InputFrame } from '../types';

const axes = ['brake', 'steering', 'throttle'] as const;

describe('mockFrame', () => {
  it('is labeled as a mock with valid ranges', () => {
    for (let t = 0; t < 20000; t += 7) {
      const f = mockFrame(1, t);
      expect(f.schemaVersion).toBe(1);
      expect(f.source).toBe('mock');
      expect(f.sourceId).toBe('mock-0');
      expect(f.quality).toEqual({ gap: false, stale: false, calibrated: false });
      for (const a of axes) {
        expect(f[a].available).toBe(true);
        expect(f[a].rawUnit).toBe('mock-normalized');
        expect(f[a].rawValue).toBe(f[a].normalized);
      }
      for (const a of ['brake', 'throttle'] as const) {
        expect(f[a].normalized!).toBeGreaterThanOrEqual(0);
        expect(f[a].normalized!).toBeLessThanOrEqual(1);
      }
      expect(Math.abs(f.steering.normalized!)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and carries seq/time', () => {
    expect(mockFrame(5, 1234)).toEqual(mockFrame(5, 1234));
    const f = mockFrame(5, 1234);
    expect(f.sequence).toBe(5);
    expect(f.receivedMonoMs).toBe(1234);
  });

  it('never has brake and throttle both > 0 over a full cycle, and exercises all phases', () => {
    let sawBrake = false, sawThrottle = false, sawSteer = false;
    for (let t = 0; t < 30000; t += 1) {
      const f = mockFrame(0, t);
      expect(f.brake.normalized! > 0 && f.throttle.normalized! > 0).toBe(false);
      sawBrake ||= f.brake.normalized! > 0.5;
      sawThrottle ||= f.throttle.normalized! > 0.5;
      sawSteer ||= Math.abs(f.steering.normalized!) > 0.5;
    }
    expect(sawBrake && sawThrottle && sawSteer).toBe(true);
  });

  it('repeats', () => {
    const a = mockFrame(0, 100).brake.normalized;
    let period = 0;
    for (let p = 1000; p < 30000 && !period; p++) {
      if (mockFrame(0, 100 + p).brake.normalized === a && mockFrame(0, 100 + p).throttle.normalized === mockFrame(0, 100).throttle.normalized) period = p;
    }
    expect(period).toBeGreaterThan(0);
  });
});

describe('startMockSource', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  });
  afterEach(() => vi.useRealTimers());

  it('emits at ~60 Hz with incrementing sequence and stops', () => {
    const frames: InputFrame[] = [];
    const stop = startMockSource((f) => frames.push(f));
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBeGreaterThanOrEqual(55);
    expect(frames.length).toBeLessThanOrEqual(65);
    frames.forEach((f, i) => expect(f.sequence).toBe(i));
    stop();
    const n = frames.length;
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(n);
  });

  it('honors configured rate', () => {
    const frames: InputFrame[] = [];
    const stop = startMockSource((f) => frames.push(f), { hz: 10 });
    vi.advanceTimersByTime(1000);
    stop();
    expect(frames.length).toBe(10);
  });
});
