import { describe, expect, it } from 'vitest';
import { createSessionRunner, type RunnerBridge } from './sessionRunner';
import type { Result, SessionConfig, SessionEvent, Snapshot } from '../../wasm/sessionBridge';
import type { AudioAlert, AudioScene } from '../../audio/sonify/types';
import type { SayOptions } from '../../audio/speech/announcer';
import type { InputFrame, Measurement } from '../../input/types';

const m = (v: number | null): Measurement => ({ available: v !== null, rawValue: v, rawUnit: 'mock', normalized: v });
const frame = (t: number, v: { brake?: number | null; steering?: number | null; throttle?: number | null } = {}, stale = false, gap = false): InputFrame => ({
  schemaVersion: 1, source: 'mock', sourceId: 'mock-0', receivedMonoMs: t,
  brake: m(v.brake === undefined ? 0.4 : v.brake), steering: m(v.steering === undefined ? 0 : v.steering), throttle: m(v.throttle === undefined ? 0 : v.throttle),
  quality: { gap, stale, calibrated: false },
});
const base: Snapshot = { apiVersion: 1, state: 'IDLE', round: 0, rounds: 0, roundsDone: 0 };

function setup(opts: { commandError?: string } = {}) {
  let snap = base;
  let now = 1000;
  const subs = new Set<(b: { events: SessionEvent[]; snapshot: Snapshot }) => void>();
  const commands: string[] = [];
  const starts: SessionConfig[] = [];
  const pushed: InputFrame[] = [];
  const ok = (): Result => ({ apiVersion: 1, events: [] });
  const bridge: RunnerBridge = {
    pushFrame: (f) => void pushed.push(f),
    command: (c) => (commands.push(c), opts.commandError ? { ...ok(), error: opts.commandError } : ok()),
    start: (cfg) => (starts.push(cfg), (snap = { ...snap, state: 'PREPARE' }), ok()),
    getSnapshot: () => snap,
    subscribe: (fn) => (subs.add(fn as never), () => void subs.delete(fn as never)),
  };
  const step = (events: SessionEvent[] = [], patch: Partial<Snapshot> = {}) => {
    snap = { ...snap, ...patch };
    subs.forEach((f) => f({ events, snapshot: snap }));
  };
  const alerts: AudioAlert[] = [];
  const scenes: AudioScene[] = [];
  const duck: boolean[] = [];
  let silenced = 0;
  const sonify = { update: (s: AudioScene) => void scenes.push(s), alert: (a: AudioAlert) => void alerts.push(a), duck: (on: boolean) => void duck.push(on), silence: () => void silenced++ };
  const said: { text: string; opt?: SayOptions }[] = [];
  const startCbs: (() => void)[] = [];
  const endCbs: (() => void)[] = [];
  const announcer = {
    say: (text: string, opt?: SayOptions) => (said.push({ text, opt }), true),
    onStart: (cb: () => void) => (startCbs.push(cb), () => true),
    onEnd: (cb: () => void) => (endCbs.push(cb), () => true),
  };
  const voiceLog: string[] = [];
  const voice = { suppress: () => void voiceLog.push('suppress'), release: () => void voiceLog.push('release') };
  const runner = createSessionRunner({ bridge, sonify, announcer, voice, now: () => now });
  return {
    runner, commands, starts, pushed, alerts, scenes, duck, said, voiceLog, step, startCbs, endCbs,
    setNow: (t: number) => (now = t), silenced: () => silenced,
    texts: () => said.map((s) => s.text),
  };
}

const active: Partial<Snapshot> = { state: 'ACTIVE', mode: 'guided', controls: ['brake'], round: 1, rounds: 2, primary: 'brake' };

describe('sessionRunner events', () => {
  it('overlap -> one overlap alert, never spoken', () => {
    const s = setup();
    s.step([{ kind: 'overlapOnset', atMs: 900, brake: 0.5, throttle: 0.5 }], active);
    expect(s.alerts).toEqual([{ kind: 'overlap', atMs: 900 }]);
    expect(s.said).toEqual([]);
  });

  it('fluctuation -> fluctuation alert', () => {
    const s = setup();
    s.step([{ kind: 'fluctuation', atMs: 5, axis: 'brake' }], active);
    expect(s.alerts).toEqual([{ kind: 'fluctuation', atMs: 5 }]);
  });

  it('countdown, round start/end and session complete are alerted and spoken', () => {
    const s = setup();
    s.step([{ kind: 'countdown', atMs: 1, round: 1, remaining: 3 }], { ...active, state: 'COUNTDOWN' });
    s.step([{ kind: 'roundStarted', atMs: 2, round: 1 }], active);
    s.step([{ kind: 'roundEnded', atMs: 3, round: 1, outcome: 'completedTimed' }], { ...active, state: 'REST' });
    s.step([{ kind: 'roundEnded', atMs: 4, round: 2, outcome: 'skipped' }, { kind: 'sessionComplete', atMs: 4 }], { ...active, state: 'COMPLETE' });
    expect(s.alerts.map((a) => a.kind)).toEqual(['round-start', 'round-end', 'round-end', 'session-complete']);
    expect(s.texts()).toEqual(['3', 'Go', 'Round 1 complete.', 'Round 2 skipped.', 'Session complete. 1 of 2 rounds completed. 1 skipped.']);
    expect(s.said[0]!.opt?.category).toBe('countdown');
  });

  it('ducks tones and suppresses voice recognition while speaking', () => {
    const s = setup();
    s.startCbs.forEach((f) => f());
    expect(s.duck).toEqual([true]);
    expect(s.voiceLog).toEqual(['suppress']);
    s.endCbs.forEach((f) => f());
    expect(s.duck).toEqual([true, false]);
    expect(s.voiceLog).toEqual(['suppress', 'release']);
  });
});

describe('sessionRunner audio scene', () => {
  it('timed guided: primary and desired pass through, mode follows the audio choice, nowMs from the frame', () => {
    const s = setup();
    s.runner.configure({ name: 'x', config: { controls: ['brake'] }, audioMode: 'deviation' });
    s.runner.pushFrame(frame(990, { brake: 0.3 }));
    s.step([], { ...active, controls: ['brake', 'steering'], primary: 'steering', target: { phase: 0, values: { brake: 0.4, steering: 0.2 }, terminal: null, done: false }, tolerance: { brake: 0.1 } });
    const sc = s.scenes.at(-1)!;
    expect(sc).toMatchObject({ mode: 'guided-deviation', primary: 'steering', desired: { brake: 0.4, steering: 0.2 }, tolerance: { brake: 0.1 }, nowMs: 990 });
    expect(sc.actual).toEqual({ brake: 0.3, steering: 0, throttle: null }); // unselected control silent
    s.runner.configure({ name: 'x', config: { controls: ['brake'] }, audioMode: 'dual' });
    s.step();
    expect(s.scenes.at(-1)!.mode).toBe('guided-dual');
  });

  it('self-paced guided has no desired, only terminal targets', () => {
    const s = setup();
    s.runner.pushFrame(frame(990));
    s.step([], { ...active, selfPaced: true, terminalTargets: { brake: 0.4 } });
    const sc = s.scenes.at(-1)!;
    expect(sc.mode).toBe('guided-selfpaced');
    expect(sc.desired).toBeUndefined();
    expect(sc.terminal).toEqual({ brake: 0.4 });
  });

  it('freeform mode; stale input is never sonified', () => {
    const s = setup();
    s.runner.pushFrame(frame(990));
    s.step([], { ...active, mode: 'freeform' });
    expect(s.scenes.at(-1)).toMatchObject({ mode: 'freeform', actual: { brake: 0.4 } });
    s.setNow(1500);
    s.step();
    expect(s.scenes.at(-1)!.actual).toEqual({ brake: null, steering: null, throttle: null });
  });

  it('silences outside a running session', () => {
    const s = setup();
    s.step([], { ...active, state: 'COMPLETE' });
    expect(s.scenes).toEqual([]);
    expect(s.silenced()).toBe(1);
    s.step();
    expect(s.silenced()).toBe(1);
  });
});

describe('sessionRunner source loss', () => {
  it('required channel unavailable -> sourceLost once, alert + speech on SOURCE_LOST, restored on good input', () => {
    const s = setup();
    s.runner.pushFrame(frame(1000, { brake: null }));
    s.step([], active);
    s.step([], active);
    expect(s.commands.filter((c) => c === 'sourceLost')).toHaveLength(1);
    s.step([{ kind: 'stateChanged', atMs: 1000, from: 'ACTIVE', to: 'SOURCE_LOST' }], { state: 'SOURCE_LOST' });
    s.step([], { state: 'SOURCE_LOST' });
    expect(s.alerts).toEqual([{ kind: 'source-lost', atMs: 1000 }]);
    expect(s.texts()).toEqual(['Input source lost.']);
    expect(s.said[0]!.opt?.priority).toBe('critical');
    // Restore needs RESTORE_FRAMES consecutive good frames; a gap frame resets the streak.
    s.runner.pushFrame(frame(1004));
    s.runner.pushFrame(frame(1005));
    s.runner.pushFrame(frame(1006, {}, false, true));
    s.runner.pushFrame(frame(1007));
    s.runner.pushFrame(frame(1008));
    s.step([], { state: 'SOURCE_LOST' });
    expect(s.commands).toEqual(['sourceLost']);
    s.runner.pushFrame(frame(1010));
    s.step([], { state: 'SOURCE_LOST' });
    expect(s.commands).toEqual(['sourceLost', 'sourceRestored']);
    s.step([{ kind: 'stateChanged', atMs: 1010, from: 'SOURCE_LOST', to: 'COUNTDOWN' }], { state: 'COUNTDOWN' });
    expect(s.texts()).toContain('Input source restored.');
  });

  it('no frames for longer than the stale threshold -> sourceLost; stale-flagged frames too', () => {
    const s = setup();
    s.runner.pushFrame(frame(1000));
    s.step([], { ...active, state: 'REST' });
    expect(s.commands).toEqual([]);
    s.setNow(1300);
    s.step([], { ...active, state: 'REST' });
    expect(s.commands).toEqual(['sourceLost']);

    const t = setup();
    t.runner.pushFrame(frame(1000, {}, true));
    t.step([], active);
    expect(t.commands).toEqual(['sourceLost']);
  });

  it('core-detected loss: good frames from before the loss never count toward restore', () => {
    const s = setup();
    for (const t of [990, 992, 994, 996]) s.runner.pushFrame(frame(t));
    s.step([], active);
    s.step([{ kind: 'stateChanged', atMs: 998, from: 'ACTIVE', to: 'SOURCE_LOST' }], { state: 'SOURCE_LOST' });
    s.step([], { state: 'SOURCE_LOST' });
    expect(s.commands).toEqual([]); // latest frame is still fresh, but it predates the loss
    for (const t of [1001, 1002, 1003]) s.runner.pushFrame(frame(t));
    s.step([], { state: 'SOURCE_LOST' });
    expect(s.commands).toEqual(['sourceRestored']);
  });

  it('a gap frame is not live input: no sonified values, and it reports loss', () => {
    const s = setup();
    s.runner.pushFrame(frame(1000, {}, false, true));
    s.step([], active);
    expect(s.scenes.at(-1)!.actual).toEqual({ brake: null, steering: null, throttle: null });
    expect(s.commands).toEqual(['sourceLost']);
  });

  it('frames are forwarded to the bridge as-is, including unavailable ones', () => {
    const s = setup();
    const f = frame(1, { brake: null });
    s.runner.pushFrame(f);
    expect(s.pushed).toEqual([f]);
  });
});

describe('sessionRunner commands', () => {
  it('start from IDLE prepares from the setup with axes the source provides, then starts', () => {
    const s = setup();
    s.runner.configure({ name: 'Brake hold', config: { drill: { schemaVersion: 1, type: 'hold', timing: 'timed', controls: ['brake'], phases: [], rounds: 2, restMs: 3000 } }, audioMode: 'dual' });
    s.runner.pushFrame(frame(1000, { steering: null }));
    expect(s.runner.dispatcher.dispatch('start', 'keyboard')).toEqual({ ok: true });
    expect(s.starts[0]!.availableAxes).toEqual(['brake', 'throttle']);
    expect(s.commands).toEqual(['start']);
    expect(s.texts()).toEqual(['Brake hold. 2 rounds. 3 seconds rest.']);
  });

  it('maps complete/skip to the core command names', () => {
    const s = setup();
    s.runner.pushFrame(frame(1000));
    s.step([], active);
    s.runner.dispatcher.dispatch('skip', 'voice');
    s.runner.dispatcher.dispatch('complete', 'button');
    expect(s.commands).toEqual(['skipRound', 'completeRound']);
  });

  it('rejected commands get short spoken feedback (state check and core error)', () => {
    const s = setup();
    s.step([], active);
    expect(s.runner.dispatcher.dispatch('resume', 'keyboard')).toEqual({ ok: false, reason: 'not-allowed' });
    expect(s.texts()).toEqual(['Cannot resume now.']);
    const t = setup({ commandError: 'nope' });
    t.step([], active);
    expect(t.runner.dispatcher.dispatch('complete', 'voice')).toEqual({ ok: false, reason: 'sink-error' });
    expect(t.texts()).toEqual(['Cannot complete now.']);
    // start without a usable source is rejected, not silently ignored
    const u = setup();
    u.runner.configure({ name: 'x', config: { controls: ['brake'] }, audioMode: 'dual' });
    expect(u.runner.dispatcher.dispatch('start', 'keyboard')).toEqual({ ok: false, reason: 'sink-error' });
    expect(u.starts).toEqual([]);
  });
});
