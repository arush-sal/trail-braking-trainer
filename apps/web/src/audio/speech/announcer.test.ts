import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAnnouncer, type UtteranceLike } from './announcer';

afterEach(() => vi.useRealTimers());

function setup() {
  const spoken: UtteranceLike[] = [];
  const synth = {
    speaking: false,
    speak: vi.fn((u: UtteranceLike) => { spoken.push(u); synth.speaking = true; }),
    cancel: vi.fn(() => { synth.speaking = false; }),
    getVoices: () => [{ name: 'A', lang: 'en-US' }, { name: 'B', lang: 'de-DE' }],
  };
  const a = createAnnouncer({ synth, createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }) });
  const finish = () => { const u = spoken[spoken.length - 1]!; synth.speaking = false; u.onend?.(); };
  return { a, synth, spoken, finish };
}
const texts = (s: UtteranceLike[]) => s.map((u) => u.text);

describe('announcer', () => {
  it('speaks one at a time, in order', () => {
    const { a, spoken, finish } = setup();
    a.say('one'); a.say('two');
    expect(texts(spoken)).toEqual(['one']);
    finish();
    expect(texts(spoken)).toEqual(['one', 'two']);
  });
  it('critical jumps the queue and interrupts current speech by default', () => {
    const { a, spoken, synth, finish } = setup();
    a.say('one'); a.say('two');
    a.say('lost', { priority: 'critical' });
    expect(synth.cancel).toHaveBeenCalled();
    expect(texts(spoken)).toEqual(['one', 'lost']);
    finish();
    expect(texts(spoken)).toEqual(['one', 'lost', 'two']);
  });
  it('late end event of a cancelled utterance does not advance the queue', () => {
    const { a, spoken } = setup();
    a.say('one'); a.say('lost', { priority: 'critical' });
    spoken[0]!.onerror?.(); // browser reports 'interrupted' for the cancelled one
    expect(texts(spoken)).toEqual(['one', 'lost']);
  });
  it('critical can opt out of interrupting', () => {
    const { a, synth, spoken, finish } = setup();
    a.say('one'); a.say('c', { priority: 'critical', interrupt: false });
    expect(synth.cancel).not.toHaveBeenCalled();
    finish();
    expect(texts(spoken)).toEqual(['one', 'c']);
  });
  it('normal interrupt:true cancels current', () => {
    const { a, spoken } = setup();
    a.say('long'); a.say('3', { interrupt: true, category: 'countdown' });
    expect(texts(spoken)).toEqual(['long', '3']);
  });
  it('speaking state and start/end callbacks fire on transitions only', () => {
    const { a, finish } = setup();
    const s = vi.fn(); const e = vi.fn();
    a.onStart(s); a.onEnd(e);
    a.say('one'); a.say('two');
    expect(a.speaking).toBe(true);
    expect(s).toHaveBeenCalledTimes(1);
    finish();
    expect(e).not.toHaveBeenCalled();
    finish();
    expect(e).toHaveBeenCalledTimes(1);
    expect(a.speaking).toBe(false);
  });
  it('cancel clears queue and ends speaking', () => {
    const { a, synth } = setup();
    const e = vi.fn(); a.onEnd(e);
    a.say('one'); a.say('two');
    a.cancel();
    expect(synth.cancel).toHaveBeenCalled();
    expect(a.speaking).toBe(false);
    expect(e).toHaveBeenCalledTimes(1);
  });
  it('category toggles drop disabled speech; alerts cannot be disabled', () => {
    const { a, spoken } = setup();
    a.setEnabled('roundSummary', false);
    expect(a.say('sum', { category: 'roundSummary' })).toBe(false);
    expect(a.say('ok', { category: 'sessionSummary' })).toBe(true);
    a.setEnabled('sessionSummary', false);
    a.say('crit', { priority: 'critical' });
    expect(texts(spoken)).toEqual(['ok', 'crit']);
    expect(a.isEnabled('roundSummary')).toBe(false);
  });
  it('rate and voice selection apply to utterances', () => {
    const { a, spoken } = setup();
    a.setRate(1.4); a.setVoice('B');
    a.say('x');
    expect(spoken[0]!.rate).toBe(1.4);
    expect((spoken[0]!.voice as { name: string }).name).toBe('B');
    a.setRate(99);
    expect(a.rate).toBe(2);
    expect(a.voices().map((v) => v.name)).toEqual(['A', 'B']);
  });
  it('is a reported no-op when speechSynthesis is missing', () => {
    const a = createAnnouncer({ synth: null });
    expect(a.supported).toBe(false);
    expect(a.say('x')).toBe(false);
    expect(a.voices()).toEqual([]);
    expect(() => { a.cancel(); a.test(); }).not.toThrow();
    expect(a.speaking).toBe(false);
  });
  it('speak() throwing leaves the queue usable', () => {
    const { a, synth, spoken, finish } = setup();
    synth.speak.mockImplementationOnce(() => { throw new Error('boom'); });
    a.say('bad');
    expect(a.speaking).toBe(false);
    a.say('good');
    finish();
    expect(texts(spoken)).toEqual(['good']);
  });
  it('watchdog frees the queue when onend never fires (length-based, scaled by rate)', () => {
    vi.useFakeTimers();
    const { a, spoken, synth } = setup();
    const e = vi.fn(); a.onEnd(e);
    a.say('abcdefghij'); a.say('next');
    vi.advanceTimersByTime(400 + 900 - 1);
    expect(texts(spoken)).toEqual(['abcdefghij']);
    vi.advanceTimersByTime(2);
    expect(synth.cancel).toHaveBeenCalled();
    expect(texts(spoken)).toEqual(['abcdefghij', 'next']);
    vi.advanceTimersByTime(60000);
    expect(a.speaking).toBe(false);
    expect(e).toHaveBeenCalledTimes(1);
  });
  it('watchdog is cleared by a normal end and capped', () => {
    vi.useFakeTimers();
    const { a, spoken, synth, finish } = setup();
    a.say('hi'); finish();
    vi.advanceTimersByTime(60000);
    expect(synth.cancel).not.toHaveBeenCalled();
    a.say('x'.repeat(5000)); a.say('after');
    vi.advanceTimersByTime(30001);
    expect(texts(spoken)).toEqual(['hi', 'x'.repeat(5000), 'after']);
  });
  it('a stale watchdog never cancels newer speech (interrupt, cancel)', () => {
    vi.useFakeTimers();
    const { a, synth } = setup();
    a.say('one'); // watchdog ~490 ms
    vi.advanceTimersByTime(300);
    a.say('crit', { priority: 'critical' }); // replaces 'one'
    synth.cancel.mockClear();
    vi.advanceTimersByTime(250); // old timer would fire here
    expect(synth.cancel).not.toHaveBeenCalled();
    a.cancel();
    synth.cancel.mockClear();
    vi.advanceTimersByTime(60000);
    expect(synth.cancel).not.toHaveBeenCalled();
  });
});
