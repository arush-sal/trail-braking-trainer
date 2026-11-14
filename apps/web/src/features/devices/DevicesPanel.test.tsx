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
  it('no Gamepad API: explains it and offers the other sources', () => {
    render(<DevicesPanel />); // jsdom has no navigator.getGamepads
    const a = screen.getByRole('alert');
    expect(a.textContent).toMatch(/does not provide the Gamepad API/);
    expect(a.textContent).toMatch(/HTTPS or localhost/);
    expect(a.textContent).toMatch(/MOCK or GT7 collector/);
  });

  it('API present but no devices: says how to make the device appear', () => {
    render(<DevicesPanel getGamepads={() => []} />);
    expect(screen.queryByRole('alert')).toBeNull();
    const p = screen.getByText(/No gamepads detected/);
    expect(p.textContent).toMatch(/press a pedal or button/i);
    expect(p.textContent).toMatch(/reconnect/i);
  });

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

  it('feeds every poll button values and current mappings to onPads (command bindings)', () => {
    vi.useFakeTimers();
    const seen: { pads: readonly { key: string; buttons: readonly number[] }[]; mapped: number }[] = [];
    render(<DevicesPanel getGamepads={() => [fake]} onPads={(pads, maps) => seen.push({ pads, mapped: Object.keys(maps).length })} />);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.at(-1)!.pads).toEqual([expect.objectContaining({ key: `${fake.id}#0`, buttons: [0, 0.5] })]);
    expect(seen.at(-1)!.mapped).toBe(0);
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

  it('shows raw id, VID:PID and an opt-in G923 suggestion', () => {
    vi.useFakeTimers();
    const g923 = { ...fake, id: 'G923 (STANDARD GAMEPAD Vendor: 046d Product: c266)' };
    render(<DevicesPanel getGamepads={() => [g923]} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getAllByText(/STANDARD GAMEPAD Vendor: 046d/).length).toBeGreaterThan(0);
    expect(screen.getByText(/046d:c266/)).toBeTruthy();
    expect(screen.getByText(/public info, unverified locally/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Brake device'), { target: { value: `${g923.id}#0` } });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect((screen.getByLabelText('Brake invert') as HTMLInputElement).checked).toBe(false); // never auto-applied
    fireEvent.click(screen.getByRole('button', { name: /Apply suggestion/ }));
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect((screen.getByLabelText('Brake invert') as HTMLInputElement).checked).toBe(true);
  });

  it('Fanatec DD base shows the confirm-manually note', () => {
    vi.useFakeTimers();
    render(<DevicesPanel getGamepads={() => [{ ...fake, id: '0eb7-0020-Fanatec Wheel' }]} />);
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByText(/confirm manually/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Apply suggestion/ })).toBeNull();
  });
});
