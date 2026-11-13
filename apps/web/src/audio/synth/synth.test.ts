import { describe, expect, it, vi } from 'vitest';
import { LatencyStats, positionToFreq, clampGain, MAX_GAIN, MIN_HZ, MAX_HZ, CENTRE_HZ } from './mapping';
import { ToneEngine, type CtxLike } from './ToneEngine';
import type { InputFrame } from '../../input/types';

describe('positionToFreq', () => {
  it('pedal is bounded and monotonic', () => {
    expect(positionToFreq(0, 'brake')).toBeCloseTo(MIN_HZ);
    expect(positionToFreq(1, 'brake')).toBeCloseTo(MAX_HZ);
    expect(positionToFreq(2, 'brake')).toBeCloseTo(MAX_HZ);
    let prev = 0;
    for (let v = 0; v <= 1; v += 0.1) {
      const f = positionToFreq(v, 'throttle')!;
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });
  it('steering is signed around centre', () => {
    expect(positionToFreq(0, 'steering')).toBeCloseTo(CENTRE_HZ);
    expect(positionToFreq(0.5, 'steering')!).toBeGreaterThan(CENTRE_HZ);
    expect(positionToFreq(-0.5, 'steering')!).toBeLessThan(CENTRE_HZ);
    expect(positionToFreq(-5, 'steering')).toBeCloseTo(MIN_HZ);
  });
  it('null/NaN is silence, not 0', () => {
    expect(positionToFreq(null, 'brake')).toBeNull();
    expect(positionToFreq(NaN, 'steering')).toBeNull();
  });
  it('pedal neutral zone is silent', () => {
    expect(positionToFreq(0.02, 'brake', 0.05)).toBeNull();
    expect(positionToFreq(0.5, 'brake', 0.05)).not.toBeNull();
  });
});

describe('clampGain', () => {
  it('caps and floors', () => {
    expect(clampGain(5)).toBe(MAX_GAIN);
    expect(clampGain(-1)).toBe(0);
    expect(clampGain(NaN)).toBe(0);
  });
});

describe('LatencyStats', () => {
  it('percentiles and bounded ring', () => {
    const s = new LatencyStats(100);
    for (let i = 1; i <= 100; i++) s.add(i);
    expect(s.summary()).toMatchObject({ count: 100, p50: 50, p95: 95, max: 100 });
    s.add(1000);
    const r = s.summary();
    expect(r.count).toBe(100);
    expect(r.max).toBe(1000);
  });
  it('empty', () => expect(new LatencyStats().summary().count).toBe(0));
});

function fakeCtx() {
  const calls: Array<[string, number]> = [];
  const spies = { stop: vi.fn(), disc: vi.fn() };
  const param = (name: string, v = 0) => ({
    value: v,
    setTargetAtTime: (t: number) => void calls.push([name, t]),
    cancelScheduledValues: () => {},
  });
  const ctx = {
    state: 'suspended' as string,
    currentTime: 0,
    baseLatency: 0.01,
    destination: {},
    onstatechange: null as null | (() => void),
    resume: async () => {
      ctx.state = 'running';
      ctx.onstatechange?.();
    },
    close: async () => {
      ctx.state = 'closed';
      ctx.onstatechange?.();
    },
    createOscillator: () => ({ type: 'sine', frequency: param('freq'), connect: () => {}, disconnect: spies.disc, start: () => {}, stop: spies.stop }),
    createGain: () => ({ gain: param('gain'), connect: () => {}, disconnect: spies.disc }),
  };
  return { ctx: ctx as unknown as CtxLike, raw: ctx, calls, spies };
}
const frame = (brake: number | null, t: number): InputFrame => ({
  schemaVersion: 1, source: 'mock', sourceId: 'm', receivedMonoMs: t,
  brake: { available: brake !== null, rawValue: brake, rawUnit: '', normalized: brake },
  steering: { available: false, rawValue: null, rawUnit: '', normalized: null },
  throttle: { available: false, rawValue: null, rawUnit: '', normalized: null },
  quality: { gap: false, stale: false, calibrated: true },
});

describe('ToneEngine', () => {
  it('is lazy and unlock resumes with state transitions', async () => {
    const f = fakeCtx();
    let made = 0;
    const e = new ToneEngine(() => (made++, f.ctx));
    expect(made).toBe(0);
    expect(e.state).toBe('locked');
    const seen: string[] = [];
    e.onState((s) => seen.push(s));
    await e.unlock();
    expect(made).toBe(1);
    expect(e.state).toBe('running');
    f.raw.state = 'suspended';
    f.raw.onstatechange?.();
    expect(e.state).toBe('suspended');
    await f.raw.close();
    expect(e.state).toBe('closed');
    expect(seen).toContain('running');
  });
  it('caps volume and records latency; null silences', async () => {
    const f = fakeCtx();
    const e = new ToneEngine(() => f.ctx);
    await e.unlock();
    e.setVolume(9);
    expect(e.volume).toBe(MAX_GAIN);
    const perf = performance.now();
    e.setFrame(frame(0.5, perf - 5), 'brake');
    expect(e.latency.summary().count).toBe(1);
    expect(e.latency.summary().max).toBeGreaterThanOrEqual(5);
    e.setFrame(frame(null, perf), 'brake');
    expect(e.latency.summary().count).toBe(1);
    expect(e.audioLatency().baseLatencyMs).toBe(10);
  });
  it('dispose stops, disconnects, closes, idempotent', async () => {
    const f = fakeCtx();
    const e = new ToneEngine(() => f.ctx);
    await e.unlock();
    await e.dispose();
    await e.dispose();
    expect(f.spies.stop).toHaveBeenCalledTimes(1);
    expect(f.spies.disc).toHaveBeenCalled();
    expect(e.state).toBe('closed');
  });
  it('records latency once per frame but still updates pitch', async () => {
    const f = fakeCtx();
    const e = new ToneEngine(() => f.ctx);
    await e.unlock();
    const fr = frame(0.5, performance.now());
    e.setFrame(fr, 'brake');
    const n = f.calls.length;
    e.setFrame(fr, 'brake');
    expect(e.latency.summary().count).toBe(1);
    expect(f.calls.length).toBeGreaterThan(n);
    e.setFrame(frame(0.6, performance.now()), 'brake');
    expect(e.latency.summary().count).toBe(2);
  });
  it('test tone is not overridden by input for 400 ms', async () => {
    const f = fakeCtx();
    const e = new ToneEngine(() => f.ctx);
    await e.unlock();
    let now = 1000;
    const spy = vi.spyOn(performance, 'now').mockImplementation(() => now);
    e.playTestTone();
    const n = f.calls.length;
    now += 100;
    e.setFrame(frame(0.5, now), 'brake');
    e.silence();
    expect(f.calls.length).toBe(n);
    now += 400;
    e.setFrame(frame(0.7, now), 'brake');
    expect(f.calls.length).toBeGreaterThan(n);
    spy.mockRestore();
  });
});
