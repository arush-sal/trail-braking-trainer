import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SonifyCheck } from './SonifyCheck';
import type { SonifyEngine } from '../../audio/sonify/SonifyEngine';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const fake = () => ({ state: 'running', volume: 0.15, onState: () => () => {}, backgroundRisk: true, onBackgroundRisk: () => () => {}, interrupted: false, audioLatency: () => ({ totalMs: 42 }), unlock: vi.fn(async () => {}), update: vi.fn(), alert: vi.fn(), duck: vi.fn(), silence: vi.fn(), setVolume: vi.fn(), setMuted: vi.fn(), dispose: vi.fn() });

describe('SonifyCheck', () => {
  it('unlocks, fires every alert kind, ducks', () => {
    const e = fake();
    render(<SonifyCheck engine={e as unknown as SonifyEngine} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enable audio' }));
    expect(e.unlock).toHaveBeenCalled();
    for (const k of ['overlap', 'fluctuation', 'source-lost', 'source-invalid', 'round-start', 'round-end', 'session-complete']) {
      fireEvent.click(screen.getByRole('button', { name: k }));
      expect(e.alert).toHaveBeenLastCalledWith(expect.objectContaining({ kind: k }));
    }
    fireEvent.click(screen.getByLabelText(/Duck/));
    expect(e.duck).toHaveBeenLastCalledWith(true);
  });
  it('drives the engine with the selected mode and mock values', () => {
    vi.useFakeTimers();
    const e = fake();
    render(<SonifyCheck engine={e as unknown as SonifyEngine} />);
    fireEvent.change(screen.getByLabelText('Mode'), { target: { value: 'guided-deviation' } });
    vi.advanceTimersByTime(50);
    expect(e.update).toHaveBeenCalledWith(expect.objectContaining({ mode: 'guided-deviation', primary: 'brake' }));
  });
  it('does not dispose an injected engine', () => {
    const e = fake();
    render(<SonifyCheck engine={e as unknown as SonifyEngine} />).unmount();
    expect(e.dispose).not.toHaveBeenCalled();
  });
  it('shows total latency and background warning', () => {
    render(<SonifyCheck engine={fake() as unknown as SonifyEngine} />);
    expect(screen.getByText(/42 ms/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/hidden/);
  });
});
