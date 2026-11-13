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
    expect(screen.getByText(/MOCK input only/)).toBeTruthy();
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
});
