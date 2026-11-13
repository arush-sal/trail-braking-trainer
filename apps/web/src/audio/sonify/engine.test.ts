import { describe, expect, it } from 'vitest';
import { MAX_GAIN } from '../synth/mapping';
import { outputLatencyMs } from '../synth/env';
import { fakeCtx } from './fakeCtx';
import { ALERT_SPECS } from './plan';
import { SonifyEngine } from './SonifyEngine';
import type { AlertKind, AudioScene } from './types';

const scene = (brake: number | null, nowMs = performance.now(), o: Partial<AudioScene> = {}): AudioScene => ({
  mode: 'freeform', primary: 'brake', actual: { brake, steering: null, throttle: null }, nowMs, ...o,
});
async function setup() {
  const f = fakeCtx();
  const e = new SonifyEngine(() => f.ctx);
  await e.unlock();
  return { f, e, master: f.nodes[1], duck: f.nodes[2], bus: f.nodes[3] };
}
const levels = (f: ReturnType<typeof fakeCtx>) => f.nodes.filter((n) => n.kind === 'gain' && n.out.some((o) => o === f.nodes[2]));

describe('SonifyEngine', () => {
  it('is lazy; update/alert before unlock are no-ops', async () => {
    const f = fakeCtx();
    let made = 0;
    const e = new SonifyEngine(() => (made++, f.ctx));
    e.update(scene(0.5));
    e.alert({ kind: 'overlap', atMs: 0 });
    expect(made).toBe(0);
    expect(e.state).toBe('locked');
    await e.unlock();
    expect(e.state).toBe('running');
  });
  it('caps and mutes master; defaults conservative', async () => {
    const { e, master } = await setup();
    expect(master.gain.value).toBeLessThanOrEqual(0.15);
    e.setVolume(9);
    expect(e.volume).toBe(MAX_GAIN);
    expect(master.gain.value).toBe(MAX_GAIN);
    e.setMuted(true);
    expect(master.gain.value).toBe(0);
  });
  it('null actual silences the channel; value sounds it', async () => {
    const { f, e } = await setup();
    e.update(scene(0.5));
    const brakeLevel = levels(f)[0];
    expect(brakeLevel.gain.value).toBeGreaterThan(0);
    e.update(scene(null));
    expect(brakeLevel.gain.value).toBe(0);
  });
  it('records control-update latency once per distinct timestamp', async () => {
    const { e } = await setup();
    const t = performance.now() - 7;
    e.update(scene(0.5, t));
    e.update(scene(0.5, t));
    expect(e.latency.summary().count).toBe(1);
    expect(e.latency.summary().max).toBeGreaterThanOrEqual(7);
  });
  it('duck lowers tones ~12 dB and restores; alerts bypass the duck', async () => {
    const { f, e, duck } = await setup();
    e.duck(true);
    expect(duck.gain.value).toBeCloseTo(10 ** (-12 / 20), 3);
    e.update(scene(0.5));
    const tone = f.nodes.find((n) => n.kind === 'osc' && n.started.length)!;
    expect(tone.reaches(duck)).toBe(true);
    const before = f.nodes.length;
    e.alert({ kind: 'overlap', atMs: performance.now() });
    const alertOscs = f.nodes.slice(before).filter((n) => n.kind === 'osc');
    expect(alertOscs.length).toBeGreaterThan(0);
    for (const o of alertOscs) { expect(o.reaches(duck)).toBe(false); expect(o.reaches(f.dest)).toBe(true); }
    e.duck(false);
    expect(duck.gain.value).toBe(1);
  });
  it('each alert kind schedules distinct params; overlap starts immediately', async () => {
    const { f, e } = await setup();
    const seen = new Set<string>();
    for (const kind of Object.keys(ALERT_SPECS) as AlertKind[]) {
      const before = f.nodes.length;
      e.alert({ kind, atMs: performance.now() });
      const oscs = f.nodes.slice(before).filter((n) => n.kind === 'osc');
      expect(oscs).toHaveLength(ALERT_SPECS[kind].notes.length);
      expect(oscs[0].started[0]).toBe(f.raw.currentTime);
      seen.add(oscs.map((o) => `${o.type}:${o.frequency.value}:${o.started[0]}`).join('|'));
    }
    expect(seen.size).toBe(7);
    expect(e.alertLatency.summary().count).toBe(7);
  });
  it('dispose stops, closes once, later calls are safe', async () => {
    const { f, e } = await setup();
    await e.dispose();
    await e.dispose();
    expect(f.raw.state).toBe('closed');
    expect(f.nodes.filter((n) => n.kind === 'osc').every((n) => n.stopped.length >= 1)).toBe(true);
    expect(() => { e.update(scene(0.5)); e.alert({ kind: 'overlap', atMs: 0 }); e.duck(true); }).not.toThrow();
  });
});

describe('latency, interrupted, visibility', () => {
  it('reports base+output latency or unknown', async () => {
    const { f, e } = await setup();
    expect(e.audioLatency().totalMs).toBe(10);
    (f.raw as unknown as { outputLatency: number }).outputLatency = 0.03;
    expect(e.audioLatency()).toMatchObject({ baseLatencyMs: 10, outputLatencyMs: 30, totalMs: 40 });
    delete (f.raw as { baseLatency?: number }).baseLatency;
    (f.raw as unknown as { outputLatency?: number }).outputLatency = undefined;
    expect(e.audioLatency().totalMs).toBeNull();
    expect(outputLatencyMs(null)).toBeNull();
  });
  it('treats interrupted like suspended and surfaces it', async () => {
    const { f, e } = await setup();
    const seen: string[] = [];
    e.onState((s) => seen.push(s));
    f.raw.state = 'interrupted';
    f.raw.onstatechange?.();
    expect(e.state).toBe('suspended');
    expect(e.interrupted).toBe(true);
    expect(seen).toContain('suspended');
    f.raw.state = 'running';
    expect(e.interrupted).toBe(false);
  });
  it('unlock survives a throwing resume', async () => {
    const f = fakeCtx();
    f.raw.resume = async () => { throw new Error('InvalidStateError'); };
    const e = new SonifyEngine(() => f.ctx);
    await expect(e.unlock()).resolves.toBeUndefined();
    expect(e.state).toBe('suspended');
  });
  it('reports backgroundRisk when hidden and notifies', async () => {
    const f = fakeCtx();
    const fns: Array<() => void> = [];
    const doc = { hidden: false, addEventListener: (_: string, fn: () => void) => void fns.push(fn), removeEventListener: () => {} };
    const e = new SonifyEngine(() => f.ctx, {}, doc);
    const seen: boolean[] = [];
    e.onBackgroundRisk((r) => seen.push(r));
    expect(e.backgroundRisk).toBe(false);
    doc.hidden = true;
    fns.forEach((fn) => fn());
    expect(e.backgroundRisk).toBe(true);
    expect(seen).toEqual([true]);
  });
});
