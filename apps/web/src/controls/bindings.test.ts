import { describe, expect, it, vi } from 'vitest';
import { createBindings, DEFAULT_KEYS } from './bindings';

const key = (code: string, extra: Record<string, unknown> = {}) => ({ code, repeat: false, ctrlKey: false, altKey: false, metaKey: false, target: null, preventDefault: vi.fn(), ...extra });
const pad = (k: string, pressed: number[] = [], n = 8) => ({ key: k, buttons: Array.from({ length: n }, (_, i) => (pressed.includes(i) ? 1 : 0)) });

function setup(over: { allowed?: (c: string) => boolean; training?: (d: string, k: string, i: number) => boolean } = {}) {
  const dispatch = vi.fn<(c: string, s: string) => { ok: true }>(() => ({ ok: true }));
  const b = createBindings({
    dispatch, allowed: (over.allowed ?? (() => true)) as never,
    isTrainingInput: over.training ?? (() => false),
  });
  return { b, dispatch };
}

describe('keyboard', () => {
  it('has documented defaults', () => {
    expect(DEFAULT_KEYS).toEqual({ Space: 'togglePause', KeyG: 'start', Enter: 'complete', KeyS: 'skip', Escape: 'stop' });
  });
  it('dispatches mapped keys with source keyboard and prevents default', () => {
    const { b, dispatch } = setup();
    const e = key('Enter');
    expect(b.handleKey(e)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith('complete', 'keyboard');
    expect(e.preventDefault).toHaveBeenCalled();
  });
  it('skip key dispatches skip', () => {
    const { b, dispatch } = setup();
    b.handleKey(key('KeyS'));
    expect(dispatch).toHaveBeenCalledWith('skip', 'keyboard');
  });
  it('togglePause resolves to pause or resume from state', () => {
    let paused = false;
    const { b, dispatch } = setup({ allowed: (c) => (c === 'pause' ? !paused : c === 'resume' ? paused : false) });
    b.handleKey(key('Space'));
    paused = true;
    b.handleKey(key('Space'));
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['pause', 'resume']);
  });
  it('ignores repeats, modifier combos, editable targets and unmapped keys', () => {
    const { b, dispatch } = setup();
    expect(b.handleKey(key('Enter', { repeat: true }))).toBe(false);
    expect(b.handleKey(key('Enter', { ctrlKey: true }))).toBe(false);
    expect(b.handleKey(key('Enter', { target: { tagName: 'INPUT' } }))).toBe(false);
    expect(b.handleKey(key('Enter', { target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
    expect(b.handleKey(key('KeyZ'))).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('refuses duplicate key bindings and reserved keys', () => {
    const { b } = setup();
    expect(b.bindKey('Enter', 'skip')).toEqual({ ok: false, reason: 'conflict', with: 'complete' });
    expect(b.bindKey('Enter', 'complete')).toEqual({ ok: true });
    expect(b.bindKey('F5', 'skip')).toEqual({ ok: false, reason: 'reserved' });
    expect(b.bindKey('Tab', 'skip')).toEqual({ ok: false, reason: 'reserved' });
    expect(b.bindKey('ShiftLeft', 'skip')).toEqual({ ok: false, reason: 'reserved' });
    expect(b.bindKey('Enter', 'skip', { replace: true })).toEqual({ ok: true });
    expect(b.list().keys.find((k) => k.code === 'Enter')?.action).toBe('skip');
  });
  it('learn mode captures the next key, reports conflicts, and does not dispatch', () => {
    const { b, dispatch } = setup();
    b.learn('pause', 'keyboard');
    expect(b.state().learning).toEqual({ action: 'pause', kind: 'keyboard' });
    b.handleKey(key('KeyP'));
    expect(b.state().learning).toBeNull();
    expect(b.list().keys).toContainEqual({ code: 'KeyP', action: 'pause' });
    b.learn('resume', 'keyboard');
    b.handleKey(key('Enter')); // already complete
    expect(b.state().message).toMatch(/already/i);
    expect(b.state().learning).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('attach listens on the injected target and detaches', () => {
    const { b, dispatch } = setup();
    const t = new EventTarget();
    const off = b.attach(t);
    t.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    off();
    t.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter' }));
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('gamepad buttons', () => {
  it('fires once per press (edge), not while held', () => {
    const { b, dispatch } = setup();
    b.bindButton('dev#0', 2, 'skip');
    b.pollButtons([pad('dev#0')]);
    b.pollButtons([pad('dev#0', [2])]);
    b.pollButtons([pad('dev#0', [2])]);
    b.pollButtons([pad('dev#0')]);
    b.pollButtons([pad('dev#0', [2])]);
    expect(dispatch.mock.calls).toEqual([['skip', 'button'], ['skip', 'button']]);
  });
  it('a button already held when first seen does not fire', () => {
    const { b, dispatch } = setup();
    b.bindButton('dev#0', 2, 'skip');
    b.pollButtons([pad('dev#0', [2])]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('analog trigger fires when crossing the press threshold', () => {
    const { b, dispatch } = setup();
    b.bindButton('dev#0', 0, 'stop');
    b.pollButtons([{ key: 'dev#0', buttons: [0.1] }]);
    b.pollButtons([{ key: 'dev#0', buttons: [0.9] }]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('binds per device: same index on another device does not fire', () => {
    const { b, dispatch } = setup();
    b.bindButton('a#0', 1, 'complete');
    b.pollButtons([pad('b#0'), pad('a#0')]);
    b.pollButtons([pad('b#0', [1]), pad('a#0')]);
    expect(dispatch).not.toHaveBeenCalled();
    b.pollButtons([pad('b#0', [1]), pad('a#0', [1])]);
    expect(dispatch).toHaveBeenCalledWith('complete', 'button');
  });
  it('refuses duplicate button bindings', () => {
    const { b } = setup();
    expect(b.bindButton('a#0', 1, 'complete')).toEqual({ ok: true });
    expect(b.bindButton('a#0', 1, 'skip')).toEqual({ ok: false, reason: 'conflict', with: 'complete' });
    expect(b.bindButton('a#0', 1, 'skip', { replace: true })).toEqual({ ok: true });
  });
  it('refuses buttons used as training inputs, at bind time and at fire time', () => {
    let training = true;
    const { b, dispatch } = setup({ training: (d, k, i) => training && d === 'a#0' && k === 'button' && i === 5 });
    expect(b.bindButton('a#0', 5, 'stop')).toEqual({ ok: false, reason: 'training-input' });
    training = false;
    b.bindButton('a#0', 5, 'stop');
    training = true;
    b.pollButtons([pad('a#0')]);
    b.pollButtons([pad('a#0', [5])]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('learn mode binds the first pressed button from any device', () => {
    const { b, dispatch } = setup();
    b.learn('start', 'gamepad');
    b.pollButtons([pad('a#0'), pad('b#0')]);
    expect(b.state().learning).not.toBeNull();
    b.pollButtons([pad('a#0'), pad('b#0', [3])]);
    expect(b.state().learning).toBeNull();
    expect(b.list().buttons).toEqual([{ deviceId: 'b#0', index: 3, action: 'start' }]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('learn mode ignores a button held when learning began', () => {
    const { b } = setup();
    b.pollButtons([pad('a#0', [4])]);
    b.learn('start', 'gamepad');
    b.pollButtons([pad('a#0', [4])]);
    expect(b.state().learning).not.toBeNull();
  });
  it('learn mode refuses training-input buttons and conflicts with a message', () => {
    const { b } = setup({ training: (_d, _k, i) => i === 6 });
    b.pollButtons([pad('a#0')]);
    b.learn('start', 'gamepad');
    b.pollButtons([pad('a#0', [6])]);
    expect(b.state().message).toMatch(/training input/i);
    expect(b.state().learning).toBeNull();
    expect(b.list().buttons).toEqual([]);
  });
  it('axis motion never fires anything (only buttons are read)', () => {
    const { b, dispatch } = setup();
    b.bindButton('a#0', 0, 'stop');
    b.pollButtons([{ key: 'a#0', buttons: [0], axes: [0] } as never]);
    b.pollButtons([{ key: 'a#0', buttons: [0], axes: [1] } as never]);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('cancelLearn and subscribe', () => {
    const { b } = setup();
    const cb = vi.fn();
    const off = b.subscribe(cb);
    b.learn('stop', 'gamepad');
    b.cancelLearn();
    expect(b.state().learning).toBeNull();
    expect(cb).toHaveBeenCalled();
    off();
  });
});
