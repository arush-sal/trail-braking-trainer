import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionPanel } from './SessionPanel';
import type { Setup } from './sessionRunner';
import type { SessionResults, Snapshot } from '../../wasm/sessionBridge';
import { fixture } from '../results/fixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakes(validateError?: string, results: SessionResults = fixture()) {
  let snap: Snapshot = { apiVersion: 1, state: 'IDLE', round: 0, rounds: 0, roundsDone: 0 };
  const dispatched: string[] = [];
  const setups: (Setup | null)[] = [];
  let resultsCalls = 0;
  const runner = {
    dispatcher: { dispatch: (c: string, s: string) => (dispatched.push(`${c}:${s}`), { ok: true as const }) },
    configure: (s: Setup | null) => void setups.push(s),
    getSnapshot: () => snap,
    lastError: '',
  };
  const bridge = {
    presets: () => ({ apiVersion: 1, difficulties: {}, session: { rounds: 8, restMs: 5000, countdownMs: 3000, roundDurationMs: 10000 } }),
    validateDrill: () => ({ apiVersion: 1, events: [], error: validateError }),
    results: () => (resultsCalls++, results),
  };
  return { runner, bridge, dispatched, setups, resultsCalls: () => resultsCalls, setSnap: (s: Partial<Snapshot>) => (snap = { ...snap, ...s }) };
}

describe('SessionPanel', () => {
  it('offers only legal control selections (never B+T) and configures freeform from preset defaults', () => {
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    const options = screen.getAllByRole('radio', { name: /^(B|S|T)(\+(B|S|T))*$/ }).map((r) => r.getAttribute('aria-label'));
    expect(options).toEqual(['B', 'S', 'T', 'B+S', 'S+T', 'B+S+T']);
    expect(f.setups.at(-1)).toMatchObject({ config: { controls: ['brake'], fluctuationAlerts: false, session: { rounds: 8, restMs: 5000, countdownMs: 3000 } } });
  });

  it('guided: picks a preset with rounds/rest/countdown overrides and audio mode (validated after the debounce)', () => {
    vi.useFakeTimers();
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'stage-direct' } });
    fireEvent.change(screen.getByLabelText('Rounds', { exact: true }), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Deviation' }));
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true); // edit not validated yet
    act(() => void vi.advanceTimersByTime(200));
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(false);
    expect(f.setups.at(-1)).toMatchObject({ name: 'Full trail brake', audioMode: 'deviation', config: { drill: { rounds: 2, restMs: 5000, controls: ['brake', 'steering', 'throttle'] } } });
  });

  it('lists every preset as "name (timing, controls)" in the Drill select', () => {
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    const labels = Array.from(screen.getByLabelText('Drill').querySelectorAll('option')).map((o) => o.textContent);
    expect(labels).toEqual(expect.arrayContaining(['Full trail brake (timed, B+S+T)', 'Self-paced 40% brake hold (self-paced, B)', '40% brake hold (timed, B)']));
  });

  it('self-paced guided drill carries the completion mode and the honest audio note', () => {
    vi.useFakeTimers();
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: 'hold-brake-40-sp' } });
    act(() => void vi.advanceTimersByTime(200));
    expect(f.setups.at(-1)).toMatchObject({ config: { completion: 'either', drill: { timing: 'selfPaced' } } });
    expect(screen.getByText(/No live desired-vs-actual tone/)).toBeTruthy();
  });

  it('shows a drill validation error from the core and disables Start', () => {
    const f = fakes('bad drill');
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    expect(screen.getByRole('alert').textContent).toMatch(/bad drill/);
    expect(screen.getByRole('button', { name: 'Start' }).hasAttribute('disabled')).toBe(true);
  });

  it('an invalid drill clears the runner setup (configure(null)) so no input source can start a stale one', () => {
    const f = fakes('bad drill');
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    expect(f.setups.at(-1)).toBeNull();
  });

  it('shows results when the session ends (and between rounds), fetching once per change, not per refresh', () => {
    vi.useFakeTimers();
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    f.setSnap({ state: 'ACTIVE', round: 1, rounds: 2 });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.queryByRole('region', { name: 'Session results' })).toBeNull();
    f.setSnap({ state: 'REST', roundsDone: 1 });
    act(() => void vi.advanceTimersByTime(600));
    expect(screen.getByRole('region', { name: 'Session results' })).toBeTruthy();
    f.setSnap({ state: 'COMPLETE', roundsDone: 2 });
    act(() => void vi.advanceTimersByTime(1000));
    expect(f.resultsCalls()).toBe(2);
  });

  it('a confirmed recommendation changes the setup for the next session only', () => {
    vi.useFakeTimers();
    const r = fixture();
    r.recommendations = [{ id: 'difficulty.harder', text: 'Consider intermediate.', change: { path: 'difficulty', from: 'beginner', to: 'intermediate' } }];
    const f = fakes(undefined, r);
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    act(() => void vi.advanceTimersByTime(200));
    f.setSnap({ state: 'COMPLETE', roundsDone: 2 });
    act(() => void vi.advanceTimersByTime(300));
    fireEvent.click(screen.getByRole('button', { name: 'Apply to next session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm apply' }));
    act(() => void vi.advanceTimersByTime(300));
    expect(f.setups.at(-1)).toMatchObject({ config: { drill: { difficulty: 'intermediate' } } });
  });

  it('buttons go through the same dispatcher; status renders the snapshot', () => {
    vi.useFakeTimers();
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    for (const n of ['Start', 'Pause', 'Resume', 'Complete round', 'Skip round', 'Stop']) fireEvent.click(screen.getByRole('button', { name: n }));
    expect(f.dispatched).toEqual(['start:ui', 'pause:ui', 'resume:ui', 'complete:ui', 'skip:ui', 'stop:ui']);
    f.setSnap({ state: 'ACTIVE', round: 1, rounds: 2, primary: 'steering' });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('session-state').textContent).toBe('ACTIVE');
    expect(screen.getByTestId('session-status').textContent).toMatch(/Round 1 of 2.*steering/);
  });
});
