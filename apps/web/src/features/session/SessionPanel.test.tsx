import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionPanel } from './SessionPanel';
import type { Setup } from './sessionRunner';
import type { Snapshot } from '../../wasm/sessionBridge';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function fakes(validateError?: string) {
  let snap: Snapshot = { apiVersion: 1, state: 'IDLE', round: 0, rounds: 0, roundsDone: 0 };
  const dispatched: string[] = [];
  const setups: Setup[] = [];
  const runner = {
    dispatcher: { dispatch: (c: string, s: string) => (dispatched.push(`${c}:${s}`), { ok: true as const }) },
    configure: (s: Setup) => void setups.push(s),
    getSnapshot: () => snap,
    lastError: '',
  };
  const bridge = {
    presets: () => ({ apiVersion: 1, difficulties: {}, session: { rounds: 8, restMs: 5000, countdownMs: 3000, roundDurationMs: 10000 } }),
    validateDrill: () => ({ apiVersion: 1, events: [], error: validateError }),
  };
  return { runner, bridge, dispatched, setups, setSnap: (s: Partial<Snapshot>) => (snap = { ...snap, ...s }) };
}

describe('SessionPanel', () => {
  it('offers only legal control selections (never B+T) and configures freeform from preset defaults', () => {
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    const options = screen.getAllByRole('radio', { name: /^(B|S|T)(\+(B|S|T))*$/ }).map((r) => r.getAttribute('aria-label'));
    expect(options).toEqual(['B', 'S', 'T', 'B+S', 'S+T', 'B+S+T']);
    expect(f.setups.at(-1)).toMatchObject({ config: { controls: ['brake'], fluctuationAlerts: false, session: { rounds: 8, restMs: 5000, countdownMs: 3000 } } });
  });

  it('guided: picks an example drill with rounds/rest/countdown overrides and audio mode', () => {
    const f = fakes();
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    fireEvent.change(screen.getByLabelText('Drill'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Rounds'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Deviation' }));
    expect(f.setups.at(-1)).toMatchObject({ name: 'Full trail brake', audioMode: 'deviation', config: { drill: { rounds: 2, restMs: 5000, controls: ['brake', 'steering', 'throttle'] } } });
  });

  it('shows a drill validation error from the core', () => {
    const f = fakes('bad drill');
    render(<SessionPanel runner={f.runner} bridge={f.bridge} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Guided' }));
    expect(screen.getByRole('alert').textContent).toMatch(/bad drill/);
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
