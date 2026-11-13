import { describe, expect, it, vi } from 'vitest';
import { createDispatcher } from './dispatcher';

const mk = (allowed: (c: string) => boolean = () => true) => {
  let t = 0;
  const sink = vi.fn();
  const onReject = vi.fn();
  const d = createDispatcher({ allowed, sink, onReject, now: () => t });
  return { d, sink, onReject, advance: (ms: number) => { t += ms; } };
};

describe('dispatcher', () => {
  it('forwards allowed commands with source', () => {
    const { d, sink } = mk();
    expect(d.dispatch('start', 'keyboard')).toEqual({ ok: true });
    expect(sink).toHaveBeenCalledWith('start', 'keyboard');
  });
  it('rejects disallowed commands and reports them', () => {
    const { d, sink, onReject } = mk((c) => c !== 'skip');
    expect(d.dispatch('skip', 'voice')).toEqual({ ok: false, reason: 'not-allowed' });
    expect(sink).not.toHaveBeenCalled();
    expect(onReject).toHaveBeenCalledWith('skip', 'voice', 'not-allowed');
  });
  it('debounces the same command within 300 ms across sources', () => {
    const { d, sink, advance } = mk();
    d.dispatch('pause', 'keyboard');
    advance(299);
    expect(d.dispatch('pause', 'button')).toEqual({ ok: false, reason: 'duplicate' });
    advance(2);
    expect(d.dispatch('pause', 'button').ok).toBe(true);
    expect(sink).toHaveBeenCalledTimes(2);
  });
  it('different commands are not debounced; rejected ones do not start a window', () => {
    const { d, sink } = mk((c) => c !== 'stop');
    d.dispatch('stop', 'ui');
    d.dispatch('pause', 'ui');
    d.dispatch('resume', 'ui');
    expect(sink).toHaveBeenCalledTimes(2);
  });
  it('skip is passed as skip, never complete', () => {
    const { d, sink, advance } = mk();
    d.dispatch('skip', 'button');
    advance(1000);
    d.dispatch('complete', 'button');
    expect(sink.mock.calls.map((c) => c[0])).toEqual(['skip', 'complete']);
  });
  it('a throwing sink is reported as rejected, not thrown', () => {
    const d = createDispatcher({ allowed: () => true, sink: () => { throw new Error('x'); }, now: () => 0 });
    expect(d.dispatch('start', 'ui')).toEqual({ ok: false, reason: 'sink-error' });
  });
});
