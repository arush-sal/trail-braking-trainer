import { describe, expect, it } from 'vitest';
import { createSessionBridge, type SessionEvent, type Snapshot, type StepBatch, type TbtApi } from './sessionBridge';
import { mockFrame } from '../input/mock/mockSource';

const ok = (events: SessionEvent[] = []) => JSON.stringify({ apiVersion: 1, events });
const snap = (state: Snapshot['state']): Snapshot => ({ apiVersion: 1, state, round: 0, rounds: 2, roundsDone: 0 });

function fakeApi() {
  const calls: string[] = [];
  let state: Snapshot['state'] = 'IDLE';
  let next: SessionEvent[] = [];
  const api: TbtApi = {
    apiVersion: 1,
    start: (c) => (calls.push(`start ${c}`), (state = 'PREPARE'), ok()),
    command: (n, t) => (calls.push(`command ${n} ${t}`), ok()),
    tick: (t) => {
      calls.push(`tick ${t}`);
      const e = next;
      next = [];
      return ok(e);
    },
    observe: (f) => (calls.push(`observe ${(JSON.parse(f) as unknown[]).length}`), ok()),
    snapshot: (t) => (calls.push(`snapshot ${t}`), JSON.stringify(snap(state))),
    presets: () => JSON.stringify({ apiVersion: 1, difficulties: {} }),
    validateDrill: (d) => (calls.push(`validateDrill ${d}`), ok()),
  };
  return {
    api,
    calls,
    setState: (s: Snapshot['state']) => (state = s),
    emitOnTick: (e: SessionEvent[]) => (next = e),
  };
}

function fakeScheduler() {
  const s = { fn: undefined as (() => void) | undefined, ms: 0, cancelled: 0 };
  const every = (fn: () => void, ms: number) => ((s.fn = fn), (s.ms = ms), () => void s.cancelled++);
  return { s, every };
}

function setup() {
  const f = fakeApi();
  const sch = fakeScheduler();
  let now = 0;
  const b = createSessionBridge(f.api, { now: () => now, every: sch.every });
  return { ...f, ...sch, b, setNow: (t: number) => (now = t) };
}

const freeform = { availableAxes: ['brake' as const], controls: ['brake' as const] };

describe('sessionBridge', () => {
  it('start sends the versioned config and starts a 60 Hz pump', () => {
    const { b, calls, s } = setup();
    const r = b.start(freeform);
    expect(r.error).toBeUndefined();
    expect(JSON.parse(calls[0].slice(6))).toEqual({ apiVersion: 1, ...freeform });
    expect(s.ms).toBeCloseTo(1000 / 60);
    expect(b.getSnapshot().state).toBe('PREPARE');
  });

  it('batches frames between ticks: observe(batch) then tick(now) then snapshot(now), once per cadence', () => {
    const { b, calls, s, setNow } = setup();
    b.start(freeform);
    calls.length = 0;
    b.pushFrame(mockFrame(0, 1));
    b.pushFrame(mockFrame(1, 2));
    b.pushFrame(mockFrame(2, 3));
    expect(calls).toEqual([]); // never one Go call per frame
    setNow(16);
    s.fn!();
    expect(calls).toEqual(['observe 3', 'tick 16', 'snapshot 16']);
    calls.length = 0;
    s.fn!(); // no frames: observe skipped
    expect(calls).toEqual(['tick 16', 'snapshot 16']);
  });

  it('commands flush buffered frames first so ordering holds', () => {
    const { b, calls, setNow } = setup();
    b.start(freeform);
    calls.length = 0;
    b.pushFrame(mockFrame(0, 5));
    setNow(7);
    b.command('start');
    expect(calls).toEqual(['observe 1', 'command start 7', 'snapshot 7']);
  });

  it('delivers events and snapshot to subscribers; stops the pump at a terminal state', () => {
    const { b, s, setState, emitOnTick } = setup();
    const got: StepBatch[] = [];
    const unsub = b.subscribe((x) => got.push(x));
    b.start(freeform);
    const ev: SessionEvent = { kind: 'sessionComplete', atMs: 9 };
    emitOnTick([ev]);
    setState('COMPLETE');
    s.fn!();
    expect(got.at(-1)?.events).toEqual([ev]);
    expect(got.at(-1)?.snapshot.state).toBe('COMPLETE');
    expect(s.cancelled).toBe(1);
    unsub();
    b.step();
    expect(got.at(-1)?.events).toEqual([ev]);
  });

  it('ignores frames when no session is pumping and bounds the buffer (drop oldest, counted)', () => {
    const f = fakeApi();
    const sch = fakeScheduler();
    const b = createSessionBridge(f.api, { now: () => 0, every: sch.every, maxBuffered: 2 });
    b.pushFrame(mockFrame(0, 0));
    b.start(freeform);
    for (let i = 0; i < 5; i++) b.pushFrame(mockFrame(i, i));
    let batch: StepBatch | undefined;
    b.subscribe((x) => (batch = x));
    b.step();
    expect(f.calls).toContain('observe 2');
    expect(batch?.bufferDropped).toBe(3);
  });

  it('does not pump when start fails, and surfaces the error', () => {
    const f = fakeApi();
    f.api.start = () => JSON.stringify({ apiVersion: 1, events: [], error: 'controls: bad' });
    const sch = fakeScheduler();
    const b = createSessionBridge(f.api, { every: sch.every });
    expect(b.start(freeform).error).toBe('controls: bad');
    expect(sch.s.fn).toBeUndefined();
  });

  it('validates drills and reads presets through the core', () => {
    const { b, calls } = setup();
    expect(b.validateDrill({ schemaVersion: 1, type: 'hold', timing: 'timed', controls: ['brake'], phases: [] }).error).toBeUndefined();
    expect(calls[0]).toMatch(/^validateDrill \{"schemaVersion":1/);
    expect(b.presets().apiVersion).toBe(1);
  });
});
