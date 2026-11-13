import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from './App';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('App', () => {
  it('shows the mock-only label and header', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Trail Braking Trainer' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/labelled MOCK/);
  });

  it('toggles start/stop and shows live values', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    render(<App />);
    const btn = screen.getByRole('button', { name: 'Start mock input' });
    fireEvent.click(btn);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByRole('button', { name: 'Stop mock input' })).toBeTruthy();
    expect(screen.getByTestId('rate').textContent).toMatch(/[1-9]\d* Hz/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop mock input' }));
    expect(screen.getByRole('button', { name: 'Start mock input' })).toBeTruthy();
  });

  it('switching to gamepad hides mock control and shows device diagnostics', () => {
    render(<App />);
    expect(screen.queryByRole('heading', { name: /Input devices/ })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Gamepad/ }));
    expect(screen.queryByRole('button', { name: 'Start mock input' })).toBeNull();
    expect(screen.getByRole('heading', { name: /Input devices/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Audio check' })).toBeTruthy();
  });

  it('expires stale input: stopping the source turns the readout to n/a', () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Start mock input' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Brake').nextElementSibling?.textContent).toMatch(/%$/);
    fireEvent.click(screen.getByRole('button', { name: 'Stop mock input' }));
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Brake').nextElementSibling?.textContent).toBe('n/a');
    expect(screen.getByTestId('rate').textContent).toBe('0 Hz');
  });

  it('renders session setup (waiting for the core), controls, audio setup, and the MOCK follow options', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Session' })).toBeTruthy();
    expect(screen.getByText(/Session needs the core/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Controls' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sonification check' })).toBeTruthy();
    expect(screen.getByLabelText(/MOCK: follow the drill target/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'MOCK: inject overlap' })).toBeTruthy();
    expect((window as unknown as { __tbtTest?: unknown }).__tbtTest).toBeUndefined(); // e2e build mode only
  });
});
