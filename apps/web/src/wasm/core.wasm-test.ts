// Runs the real Go core.wasm under Node: shared fixtures + TS-produced mock frames.
import { readdirSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';
import { beforeAll, describe, expect, it } from 'vitest';
import { mockFrame } from '../input/mock/mockSource';
import { createSessionBridge, type SessionEvent, type TbtApi } from './sessionBridge';

const wasmDir = new URL('../../public/wasm/', import.meta.url);
const fixtures = new URL('../../../../tests/contracts/frames/', import.meta.url);
type Core = { version(): string; validateFrame(json: string): string | null; api: TbtApi };
let core: Core;

beforeAll(async () => {
  runInThisContext(readFileSync(new URL('wasm_exec.js', wasmDir), 'utf8'));
  const go = new (globalThis as unknown as { Go: new () => { importObject: WebAssembly.Imports; run(i: WebAssembly.Instance): Promise<void> } }).Go();
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL('core.wasm', wasmDir)), go.importObject);
  void go.run(instance);
  core = (globalThis as unknown as { tbtCore: Core }).tbtCore;
});

describe('core.wasm contract', () => {
  it('reports a version', () => expect(core.version()).not.toBe(''));

  for (const [dir, ok] of [['valid', true], ['invalid', false]] as const) {
    for (const f of readdirSync(new URL(`${dir}/`, fixtures))) {
      it(`${dir}/${f}`, () => {
        const err = core.validateFrame(readFileSync(new URL(`${dir}/${f}`, fixtures), 'utf8'));
        if (ok) expect(err).toBeNull();
        else expect(typeof err).toBe('string');
      });
    }
  }

  it('accepts TS mockFrame output across a full cycle', () => {
    for (let i = 0; i < 1000; i++) expect(core.validateFrame(JSON.stringify(mockFrame(i, i * 10)))).toBeNull();
  });
});

describe('session API through core.wasm', () => {
  // Manual cadence: a fake clock and an inert scheduler; the test calls step() itself.
  const manual = () => {
    let t = 0;
    const b = createSessionBridge(core.api, { now: () => t, every: () => () => undefined });
    return { b, at: (ms: number) => (t = ms) };
  };

  it('runs a 2-round timed freeform session from TS mock frames, with an overlap onset', () => {
    const { b, at } = manual();
    const events: SessionEvent[] = [];
    b.subscribe((x) => {
      expect(x.error).toBeUndefined();
      expect(x.outOfOrder ?? 0).toBe(0);
      events.push(...x.events);
    });
    const r = b.start({
      availableAxes: ['brake', 'steering', 'throttle'],
      controls: ['brake', 'steering', 'throttle'],
      session: { rounds: 2, countdownMs: 1000, roundDurationMs: 2000, restMs: 500 },
    });
    expect(r.error).toBeUndefined();
    b.command('start');
    for (let i = 0, t = 0; t <= 7000; i++, t = (i * 1000) / 60) {
      at(t);
      const f = mockFrame(i, t);
      if (t >= 1500 && t < 1600) f.throttle = { available: true, rawValue: 0.5, rawUnit: 'mock-normalized', normalized: 0.5 }; // synthetic B+T overlap
      b.pushFrame(f);
      b.step();
    }
    const kinds = events.filter((e) => e.kind !== 'primaryChanged').map((e) => (e.kind === 'stateChanged' ? `->${e.to}` : e.kind));
    expect(kinds).toEqual([
      '->COUNTDOWN', 'countdown', '->ACTIVE', 'roundStarted', 'overlapOnset', 'roundEnded', '->REST',
      '->COUNTDOWN', 'countdown', '->ACTIVE', 'roundStarted', 'roundEnded', '->COMPLETE', 'sessionComplete',
    ]);
    const onset = events.find((e) => e.kind === 'overlapOnset');
    expect(onset?.atMs).toBeGreaterThanOrEqual(1500);
    expect(onset?.atMs).toBeLessThan(1520);
    expect(events.filter((e) => e.kind === 'roundEnded').map((e) => e.kind === 'roundEnded' && e.outcome)).toEqual(['completedTimed', 'completedTimed']);
    expect(b.getSnapshot()).toMatchObject({ state: 'COMPLETE', roundsDone: 2, mode: 'freeform' });
  });

  it('serves timed guided targets and refuses an invalid drill', () => {
    const { b, at } = manual();
    const drill = {
      schemaVersion: 1 as const, type: 'sweep' as const, timing: 'timed' as const, controls: ['brake' as const],
      countdownMs: 0, rounds: 1, phases: [{ durationMs: 1000, targets: { brake: { from: 0, to: 1 } } }],
    };
    expect(b.validateDrill(drill).error).toBeUndefined();
    expect(b.validateDrill({ ...drill, controls: ['brake', 'throttle'] }).error).toMatch(/controls/);
    expect(b.start({ availableAxes: ['brake', 'throttle'], drill }).error).toBeUndefined();
    b.command('start');
    for (let t = 0; t <= 250; t += 50) {
      at(t);
      b.pushFrame(mockFrame(t, t)); // the core needs valid input coverage while ACTIVE
      b.step();
    }
    expect(b.getSnapshot()).toMatchObject({ state: 'ACTIVE', mode: 'guided', primary: 'brake', elapsedMs: 250, target: { phase: 0, values: { brake: 0.25 } } });
    b.command('stop');
    expect(b.presets().difficulties.beginner?.tolerance).toBe(0.1);
  });

  it('returns results for a timed guided session: separate metrics, N/A rules, bounded display', () => {
    const { b, at } = manual();
    const drill = {
      schemaVersion: 1 as const, type: 'sweep' as const, timing: 'timed' as const, controls: ['brake' as const],
      countdownMs: 0, restMs: 100, rounds: 2, phases: [{ name: 'press', durationMs: 1000, targets: { brake: { from: 0, to: 1 } } }],
    };
    expect(b.start({ availableAxes: ['brake'], drill }).error).toBeUndefined();
    b.command('start');
    const brake = (v: number) => ({ available: true, rawValue: v, rawUnit: 'mock-normalized', normalized: v });
    for (let t = 0; t <= 2100; t += 10) {
      at(t);
      // Round 1 (0..1000): exact sweep. Round 2 (1100..2100): stuck at 20%.
      b.pushFrame({ ...mockFrame(t / 10, t), brake: brake(t <= 1000 ? t / 1000 : 0.2) });
      b.step();
    }
    expect(b.getSnapshot().state).toBe('COMPLETE');
    const r = b.results();
    expect(r).toMatchObject({ apiVersion: 1, mode: 'guided', drill: { type: 'sweep' } });
    expect(r.rounds.map((x) => [x.round, x.outcome, x.durationMs])).toEqual([[1, 'completedTimed', 1000], [2, 'completedTimed', 1000]]);
    const m = (round: number, id: string) => r.rounds[round].accuracy.concat(r.rounds[round].smoothness, r.rounds[round].timing).find((x) => x.id === id && x.axis === 'brake');
    expect(m(0, 'accuracy.mae')?.value).toBeCloseTo(0, 6);
    expect(m(1, 'accuracy.mae')?.value).toBeGreaterThan(20);
    expect(m(0, 'timing.startDelay')).toMatchObject({ applicable: true, unit: 's', formulaVersion: 'timing/v1' });
    expect(m(0, 'accuracy.phaseTransition')).toMatchObject({ applicable: false, value: null });
    expect(r.rounds[0].traces).toBeUndefined(); // display-only by default
    const tr = b.results(true).rounds[0].traces!.brake!;
    expect(tr.t[0]).toBe(0);
    expect(tr.desired?.length).toBe(tr.t.length);
    expect(r.rounds[0].display.brake!.t.length).toBeLessThanOrEqual(1000);
    expect(r.consistency.find((x) => x.id === 'consistency.accuracy.mae')?.applicable).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/score|overall|composite/i);
    const p = b.previewSamples(drill, 3);
    expect(p).toMatchObject({ timed: true, xUnit: 'ms', x: [0, 500, 1000], values: { brake: [0, 0.5, 1] } });
  });

  it('measures per-step call overhead (observe + tick + snapshot)', () => {
    const { b, at } = manual();
    b.start({ availableAxes: ['brake', 'steering', 'throttle'], controls: ['brake'], session: { countdownMs: 0, roundDurationMs: 600000 } });
    b.command('start');
    const n = 600;
    const t0 = performance.now();
    for (let i = 1; i <= n; i++) {
      at(i * 16);
      b.pushFrame(mockFrame(i, i * 16));
      b.step();
    }
    const us = ((performance.now() - t0) * 1000) / n;
    console.log(`session step (1 frame): ${us.toFixed(1)} us mean over ${n} steps`);
    b.command('stop');
    expect(us).toBeGreaterThan(0);
  });
});
