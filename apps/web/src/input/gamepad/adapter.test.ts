import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGamepadAdapter } from './adapter';
import { defaultMapping } from './normalize';
import type { InputFrame } from '../types';

type Pad = { id: string; index: number; connected: boolean; mapping: string; timestamp: number; axes: number[]; buttons: { value: number }[] };
const pad = (id: string, index: number, axes: number[], buttons: number[] = [], timestamp = 1): Pad => ({
  id, index, connected: true, mapping: '', timestamp, axes, buttons: buttons.map((value) => ({ value })),
});

function setup(extra = {}) {
  let t = 0;
  const pads: (Pad | null)[] = [];
  const frames: InputFrame[] = [];
  const events: { type: string; axis?: string }[] = [];
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const target = new EventTarget();
  const a = createGamepadAdapter({
    getGamepads: () => pads, now: () => t, doc, target, raf: null, intervalMs: 20,
    onFrame: (f) => frames.push(f), onEvent: (e) => events.push(e), ...extra,
  });
  return { a, pads, frames, events, doc, target, tick: (ms = 20) => { t += ms; vi.advanceTimersByTime(20); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('adapter', () => {
  it('reads axes and buttons into an InputFrame', () => {
    const s = setup();
    s.pads.push(pad('Wheel', 0, [0.5], []), pad('Pedals', 1, [1, -1], [0, 0.75]));
    s.a.setMapping('steering', defaultMapping('Wheel#0', 'axis', 0));
    s.a.setMapping('brake', defaultMapping('Pedals#0', 'button', 1));
    s.a.setMapping('throttle', { ...defaultMapping('Pedals#0', 'axis', 0), invert: true });
    s.a.start();
    s.tick();
    const f = s.frames.at(-1)!;
    expect(f.source).toBe('gamepad');
    expect(f.steering).toMatchObject({ available: true, rawValue: 0.5, rawUnit: 'gamepad-axis', normalized: 0.5 });
    expect(f.brake).toMatchObject({ rawValue: 0.75, rawUnit: 'gamepad-button', normalized: 0.75 });
    expect(f.throttle.normalized).toBe(0);
    expect(f.quality).toEqual({ gap: false, stale: false, calibrated: false });
    s.a.stop();
  });

  it('unmapped channels are unavailable with null values', () => {
    const s = setup();
    s.a.start();
    s.tick();
    expect(s.frames.at(-1)!.brake).toMatchObject({ available: false, rawValue: null, normalized: null });
  });

  it('disconnect -> unavailable + event; other device never takes over; same id restores', () => {
    const s = setup();
    s.pads.push(pad('Pedals', 0, [1]));
    s.a.setMapping('brake', defaultMapping('Pedals#0', 'axis', 0));
    s.a.start();
    s.tick();
    expect(s.frames.at(-1)!.brake.available).toBe(true);
    s.pads[0] = null;
    s.pads.push(pad('Other', 1, [1]));
    s.target.dispatchEvent(new Event('gamepaddisconnected'));
    s.tick();
    expect(s.frames.at(-1)!.brake).toMatchObject({ available: false, rawValue: null, normalized: null });
    expect(s.events.filter((e) => e.type === 'source-lost')).toHaveLength(1);
    s.pads[0] = pad('Pedals', 2, [0]); // same id reconnects, different index
    s.tick();
    expect(s.frames.at(-1)!.brake).toMatchObject({ available: true, normalized: 0.5 });
    expect(s.events.map((e) => e.type)).toEqual(['source-lost', 'source-restored']);
    s.a.stop();
  });

  it('disambiguates identical ids by ordinal', () => {
    const s = setup();
    s.pads.push(pad('Same', 0, [0.2]), pad('Same', 1, [0.8]));
    s.a.setMapping('steering', defaultMapping('Same#1', 'axis', 0));
    s.a.start();
    s.tick();
    expect(s.frames.at(-1)!.steering.rawValue).toBe(0.8);
    s.a.stop();
  });

  it('flags gaps, counts missed polls, logs visibility and hidden intervals', () => {
    const s = setup();
    s.pads.push(pad('W', 0, [0]));
    s.a.setMapping('steering', defaultMapping('W#0', 'axis', 0));
    s.a.start();
    s.tick();
    s.tick();
    s.doc.visibilityState = 'hidden';
    s.doc.dispatchEvent(new Event('visibilitychange'));
    s.tick(1000); // single long interval while hidden
    expect(s.frames.at(-1)!.quality.gap).toBe(true);
    const st = s.a.stats();
    expect(st.visibilityLog.map((v) => v.state)).toEqual(['visible', 'hidden']);
    expect(st.hiddenIntervals.max).toBe(1000);
    expect(st.gaps.at(-1)).toMatchObject({ hidden: true, intervalMs: 1000 });
    expect(st.missedPolls).toBeGreaterThan(0);
    s.a.stop();
  });

  it('range capture applies calibration; detect finds moved control', () => {
    const s = setup();
    s.pads.push(pad('P', 0, [0, 0], []));
    s.a.setMapping('brake', defaultMapping('P#0', 'axis', 1));
    s.a.start();
    s.a.startRangeCapture('brake');
    s.tick();
    s.pads[0]!.axes[1] = 0.5;
    s.tick();
    s.a.stopRangeCapture('brake');
    expect(s.a.getMappings().brake).toMatchObject({ min: 0, max: 0.5, calibrated: true });
    expect(s.frames.at(-1)!.quality.calibrated).toBe(false); // frame was before stop
    s.tick();
    expect(s.frames.at(-1)!.quality.calibrated).toBe(true);
    let hit: unknown = null;
    s.a.startDetect((d) => (hit = d));
    s.pads[0]!.axes[0] = 1;
    s.tick();
    expect(hit).toMatchObject({ deviceId: 'P#0', kind: 'axis', index: 0 });
    s.a.stop();
  });

  it('identical controllers: surviving one never takes over a mapped channel', () => {
    const s = setup();
    s.pads.push(pad('Same', 0, [0.2]), pad('Same', 1, [0.8]));
    s.a.setMapping('steering', defaultMapping('Same#0', 'axis', 0));
    s.a.start();
    s.tick();
    s.pads[0] = null;
    s.tick();
    expect(s.frames.at(-1)!.steering).toMatchObject({ available: false, rawValue: null });
    expect(s.events.map((e) => e.type)).toEqual(['source-lost']);
    s.pads[0] = pad('Same', 0, [0.4]); // the same one returns: only one free slot -> restored
    s.tick();
    expect(s.frames.at(-1)!.steering).toMatchObject({ available: true, rawValue: 0.4 });
    s.a.stop();
  });

  it('ambiguous reconnect of identical controllers stays unavailable and asks to reselect', () => {
    const s = setup();
    s.pads.push(pad('Same', 0, [0.2]), pad('Same', 1, [0.8]));
    s.a.setMapping('steering', defaultMapping('Same#0', 'axis', 0));
    s.a.start();
    s.tick();
    s.pads[0] = null;
    s.pads[1] = null;
    s.tick();
    s.pads[0] = pad('Same', 0, [0.9]); // two free slots, cannot tell which
    s.tick();
    expect(s.frames.at(-1)!.steering.available).toBe(false);
    expect(s.events.map((e) => e.type)).toContain('source-ambiguous');
    s.a.stop();
  });

  it('getGamepads throwing yields unavailable frames, an error event, and recovery', () => {
    let boom = false;
    const pads = [pad('W', 0, [0.5])];
    const s2 = setup({ getGamepads: () => { if (boom) throw new Error('SecurityError'); return pads; } });
    s2.a.setMapping('steering', defaultMapping('W#0', 'axis', 0));
    s2.a.start();
    s2.tick();
    expect(s2.frames.at(-1)!.steering.available).toBe(true);
    boom = true;
    s2.tick();
    s2.tick();
    expect(s2.frames.at(-1)!.steering).toMatchObject({ available: false, normalized: null });
    expect(s2.events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(s2.a.stats().error).toBe('SecurityError');
    boom = false;
    s2.tick();
    expect(s2.a.stats().error).toBeNull();
    s2.a.stop();
  });
});
