import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { mockFrame } from '../input/mock/mockSource';

const ctl = vi.hoisted(() => ({ periodMs: 10 }));

vi.mock('../input/mock/mockSource', async (orig) => {
  const mod = await orig<typeof import('../input/mock/mockSource')>();
  return {
    ...mod,
    startMockSource: (onFrame: (f: ReturnType<typeof mod.mockFrame>) => void) => {
      const id = setInterval(() => {
        const f = mod.mockFrame(0, 1000);
        onFrame({ ...f, steering: { available: false, rawValue: null, rawUnit: 'none', normalized: null } });
      }, ctl.periodMs);
      return () => clearInterval(id);
    },
  };
});

afterEach(() => {
  ctl.periodMs = 10;
  cleanup();
  vi.useRealTimers();
});

it('renders an unavailable channel as n/a, never 0%', async () => {
  const { App } = await import('./App');
  vi.useFakeTimers();
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Start mock input' }));
  act(() => {
    vi.advanceTimersByTime(500);
  });
  expect(screen.getByText('Steering').nextElementSibling?.textContent).toBe('n/a');
  expect(mockFrame(0, 1000).steering.available).toBe(true);
});

it('warns visibly when input arrives slowly (10 Hz), not at the normal rate', async () => {
  const { App } = await import('./App');
  vi.useFakeTimers();
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Start mock input' }));
  act(() => {
    vi.advanceTimersByTime(2500);
  });
  expect(screen.queryByText(/arriving slowly/)).toBeNull();
  cleanup();
  ctl.periodMs = 100;
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Start mock input' }));
  act(() => {
    vi.advanceTimersByTime(2500);
  });
  expect(screen.getByText(/arriving slowly \(10 Hz/)).toBeTruthy();
});
