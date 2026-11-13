import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DevicesPanel } from './DevicesPanel';
import type { InputFrame } from '../../input/types';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const fake = {
  id: 'Fake Wheel (Vendor: 1 Product: 2)', index: 0, connected: true, mapping: '', timestamp: 5,
  axes: [0.25, -1], buttons: [{ value: 0 }, { value: 0.5 }],
};

describe('DevicesPanel', () => {
  it('renders devices, raw values, n/a for unmapped channels and capabilities', () => {
    vi.useFakeTimers();
    render(<DevicesPanel getGamepads={() => [fake]} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByText(/Fake Wheel/).length).toBeGreaterThan(0);
    expect(screen.getByText(/2 axes, 2 buttons/)).toBeTruthy();
    expect(screen.getByTestId('raw-axis-0').textContent).toBe('0.250');
    expect(screen.getByTestId('raw-button-1').textContent).toBe('0.500');
    expect(screen.getByTestId('norm-brake').textContent).toBe('n/a');
    expect(screen.getByTestId('norm-steering').textContent).toBe('n/a');
    expect(screen.getByText(/Gamepad API/)).toBeTruthy();
  });

  it('mapping a control yields a normalized readout and routes frames to onFrame', () => {
    vi.useFakeTimers();
    const frames: InputFrame[] = [];
    render(<DevicesPanel getGamepads={() => [fake]} onFrame={(f) => frames.push(f)} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    fireEvent.change(screen.getByLabelText('Steering device'), { target: { value: `${fake.id}#0` } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('norm-steering').textContent).toBe('+25%');
    expect(frames.at(-1)!.steering.normalized).toBeCloseTo(0.25);
    fireEvent.click(screen.getByLabelText('Steering invert'));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByTestId('norm-steering').textContent).toBe('-25%');
  });

  it('shows a copyable diagnostics report', () => {
    vi.useFakeTimers();
    render(<DevicesPanel getGamepads={() => [fake]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics report' }));
    const report = JSON.parse(screen.getByTestId('report').textContent!);
    expect(report).toHaveProperty('userAgent');
    expect(report).toHaveProperty('capabilities');
    expect(report).toHaveProperty('visibilityLog');
  });
});
