import { describe, expect, it } from 'vitest';
import { createCoreBridge, type CoreApi } from './coreBridge';
import { mockFrame } from '../input/mock/mockSource';

const fake: CoreApi = { version: () => 'v1', validateFrame: () => null };

describe('coreBridge', () => {
  it('starts idle, loads, exposes version and load time', async () => {
    const b = createCoreBridge(async () => fake);
    expect(b.getState().status).toBe('idle');
    const core = await b.load();
    expect(core.version()).toBe('v1');
    const s = b.getState();
    expect(s.status).toBe('ready');
    expect(s.version).toBe('v1');
    expect(s.loadMs).toBeGreaterThanOrEqual(0);
  });

  it('loads once and notifies subscribers', async () => {
    let calls = 0;
    const b = createCoreBridge(async () => (calls++, fake));
    let notified = 0;
    b.subscribe(() => notified++);
    await Promise.all([b.load(), b.load()]);
    expect(calls).toBe(1);
    expect(notified).toBeGreaterThanOrEqual(2);
  });

  it('reports a clear error on load failure and allows retry', async () => {
    let fail = true;
    const b = createCoreBridge(async () => {
      if (fail) throw new Error('fetch failed');
      return fake;
    });
    await expect(b.load()).rejects.toThrow('fetch failed');
    expect(b.getState()).toMatchObject({ status: 'error', error: 'fetch failed' });
    fail = false;
    await b.load();
    expect(b.getState().status).toBe('ready');
  });

  it('benchmarks validateFrame over n mock frames', async () => {
    const seen: unknown[] = [];
    const b = createCoreBridge(async () => ({ ...fake, validateFrame: (f) => (seen.push(f), null) }));
    await b.load();
    const r = b.benchmark(50, mockFrame);
    expect(seen).toHaveLength(50);
    expect(r.n).toBe(50);
    expect(r.meanUs).toBeGreaterThanOrEqual(0);
    expect(r.p95Us).toBeGreaterThanOrEqual(0);
    expect(b.getState().bench).toEqual(r);
  });

  it('benchmark throws when a frame is rejected, and before load', async () => {
    const b = createCoreBridge(async () => ({ ...fake, validateFrame: () => 'bad' }));
    expect(() => b.benchmark(1, mockFrame)).toThrow('not loaded');
    await b.load();
    expect(() => b.benchmark(1, mockFrame)).toThrow('bad');
  });
});
