import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AudioCheck } from './AudioCheck';
import { ToneEngine } from '../../audio/synth/ToneEngine';

afterEach(cleanup);

describe('AudioCheck', () => {
  it('renders and enable button calls unlock', () => {
    const unlock = vi.fn(async () => {});
    const engine = { state: 'locked', volume: 0.15, latency: { summary: () => ({ count: 0, p50: 0, p95: 0, max: 0 }) }, audioLatency: () => ({ baseLatencyMs: null, outputLatencyMs: null }), onState: () => () => {}, unlock, setFrame: vi.fn(), setMuted: vi.fn(), setVolume: vi.fn(), playTestTone: vi.fn(), silence: vi.fn() } as unknown as ToneEngine;
    render(<AudioCheck getLatestFrame={() => null} engine={engine} />);
    expect(screen.getByText(/NOT acoustic end-to-end/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enable audio' }));
    expect(unlock).toHaveBeenCalled();
  });
  it('warns when suspended', () => {
    const engine = { state: 'suspended', volume: 0.15, latency: { summary: () => ({ count: 0, p50: 0, p95: 0, max: 0 }) }, audioLatency: () => ({ baseLatencyMs: null, outputLatencyMs: null }), onState: () => () => {}, unlock: vi.fn(), setFrame: vi.fn(), setMuted: vi.fn(), setVolume: vi.fn(), playTestTone: vi.fn(), silence: vi.fn() } as unknown as ToneEngine;
    render(<AudioCheck getLatestFrame={() => null} engine={engine} />);
    expect(screen.getByRole('alert').textContent).toMatch(/suspended/i);
  });
  it('disposes an owned engine on unmount, not an injected one', () => {
    const d = vi.spyOn(ToneEngine.prototype, 'dispose');
    render(<AudioCheck getLatestFrame={() => null} />).unmount();
    expect(d).toHaveBeenCalledTimes(1);
    const inj = { state: 'locked', volume: 0.15, latency: { summary: () => ({ count: 0, p50: 0, p95: 0, max: 0 }) }, audioLatency: () => ({ baseLatencyMs: null, outputLatencyMs: null }), onState: () => () => {}, dispose: vi.fn(), setFrame: vi.fn(), silence: vi.fn() } as unknown as ToneEngine;
    render(<AudioCheck getLatestFrame={() => null} engine={inj} />).unmount();
    expect(inj.dispose).not.toHaveBeenCalled();
    d.mockRestore();
  });
});
