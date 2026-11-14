import { describe, expect, it } from 'vitest';
import * as p from './phrases';

describe('phrases', () => {
  it('exercise announcement', () => {
    expect(p.exercise({ name: 'Brake ramp', rounds: 8, restSec: 5 })).toBe('Brake ramp. 8 rounds. 5 seconds rest.');
    expect(p.exercise({ name: 'Freeform' })).toBe('Freeform.');
    expect(p.exercise({ name: 'X', rounds: 1 })).toBe('X. 1 round.');
  });
  it('countdown', () => {
    expect(p.countdown(3)).toBe('3');
    expect(p.countdown(0)).toBe('Go');
  });
  it('stage', () => expect(p.stage('throttle')).toBe('Next, throttle.'));
  it('rounds', () => {
    expect(p.round({ n: 3, outcome: 'complete' })).toBe('Round 3 complete.');
    expect(p.round({ n: 3, outcome: 'skipped' })).toBe('Round 3 skipped.');
    expect(p.round({ n: 3, outcome: 'invalid', reason: 'source lost' })).toBe('Round 3 invalid. Source lost.');
    expect(p.roundSummary(2, [{ name: 'Accuracy', text: '4 percent error' }])).toBe('Round 2. Accuracy 4 percent error.');
  });
  it('session', () => {
    expect(p.sessionComplete({ total: 8, completed: 6, skipped: 1, invalid: 1 })).toBe('Session complete. 6 of 8 rounds completed. 1 skipped. 1 invalid.');
    expect(p.sessionComplete({ total: 2, completed: 2, skipped: 0, invalid: 0 })).toBe('Session complete. 2 of 2 rounds completed.');
  });
  it('source and mic', () => {
    expect(p.sourceLost('brake')).toBe('Brake input lost.');
    expect(p.sourceLost()).toBe('Input source lost.');
    expect(p.sourceRestored('brake')).toBe('Brake input restored.');
    expect(p.micState('denied')).toMatch(/denied/i);
    expect(p.micState('unsupported')).toMatch(/not supported/i);
    expect(p.micState('listening')).toBe('Voice commands on.');
    expect(p.micState('idle')).toBe('Voice commands off.');
  });
  it('rejections and confirm', () => {
    expect(p.commandRejected('skip')).toBe('Cannot skip now.');
    expect(p.confirmStop()).toBe('Say stop again to confirm.');
  });
  it('has no overlap phrase (audio alert owns it)', () => {
    expect(Object.keys(p).some((k) => /overlap/i.test(k))).toBe(false);
  });
});
