import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ControlsPanel } from './ControlsPanel';
import { createBindings } from '../../controls/bindings';
import { createAnnouncer } from '../../audio/speech/announcer';

afterEach(cleanup);

const mkBindings = () => createBindings({ dispatch: () => ({ ok: true }), allowed: () => true, isTrainingInput: () => false });
const mkVoice = (over: Record<string, unknown> = {}) => ({
  status: 'idle', supported: true, locality: 'browser-default', suppressed: false,
  onDevice: 'unknown', refreshOnDevice: vi.fn(async () => 'unknown'), installOnDevice: vi.fn(async () => true),
  subscribe: () => () => {}, enable: vi.fn(async () => ({ ok: true })), disable: vi.fn(), ...over,
});
const mkAnnouncer = () => createAnnouncer({ synth: null });

describe('ControlsPanel', () => {
  it('shows the privacy notice before voice can be enabled; enable needs acknowledgement', async () => {
    const voice = mkVoice();
    render(<ControlsPanel bindings={mkBindings()} voice={voice as never} announcer={mkAnnouncer()} />);
    expect(screen.getByText(/may be sent to a remote service/i)).toBeTruthy();
    const enable = screen.getByRole('button', { name: /enable voice/i }) as HTMLButtonElement;
    expect(enable.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /i have read/i }));
    expect(enable.disabled).toBe(false);
    fireEvent.click(enable);
    await waitFor(() => expect(voice.enable).toHaveBeenCalledWith({ privacyAcknowledged: true }));
  });
  it('shows unsupported voice and missing speech output', () => {
    render(<ControlsPanel bindings={mkBindings()} voice={mkVoice({ status: 'unsupported', supported: false }) as never} announcer={mkAnnouncer()} />);
    expect(screen.getByText(/not supported in this browser/i)).toBeTruthy();
    expect(screen.getByText(/speech output is not available/i)).toBeTruthy();
  });
  it('shows mic status text for denied', () => {
    render(<ControlsPanel bindings={mkBindings()} voice={mkVoice({ status: 'denied' }) as never} announcer={mkAnnouncer()} />);
    expect(screen.getByRole('status', { name: /microphone status/i }).textContent).toMatch(/denied/i);
  });
  it('lists default keys and learns a new one; conflict is shown', () => {
    const b = mkBindings();
    render(<ControlsPanel bindings={b} voice={mkVoice() as never} announcer={mkAnnouncer()} />);
    expect(screen.getByText('Enter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Learn key for Pause' }));
    expect(screen.getByText(/press a key/i)).toBeTruthy();
    act(() => { b.handleKey({ code: 'Enter', repeat: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} }); });
    expect(screen.getByText(/already bound to Complete round/i)).toBeTruthy();
  });
  it('gamepad learn button enters learn mode; clear removes a key', () => {
    const b = mkBindings();
    render(<ControlsPanel bindings={b} voice={mkVoice() as never} announcer={mkAnnouncer()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Learn button for Skip round' }));
    expect(b.state().learning).toEqual({ action: 'skip', kind: 'gamepad' });
    expect(screen.getByText(/press a gamepad button/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear key S' }));
    expect(b.list().keys.some((k) => k.code === 'KeyS')).toBe(false);
  });
  it('speech toggles and test button drive the announcer', () => {
    const a = createAnnouncer({ synth: { speaking: false, speak() {}, cancel() {}, getVoices: () => [] }, createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }) });
    const setEnabled = vi.spyOn(a, 'setEnabled');
    const test = vi.spyOn(a, 'test');
    render(<ControlsPanel bindings={mkBindings()} voice={mkVoice() as never} announcer={a} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Round summaries' }));
    expect(setEnabled).toHaveBeenCalledWith('roundSummary', false);
    fireEvent.click(screen.getByRole('button', { name: /test speech/i }));
    expect(test).toHaveBeenCalled();
  });
  it('notice follows the active recognizer locality, not mere pack availability', () => {
    const { unmount } = render(<ControlsPanel bindings={mkBindings()} voice={mkVoice({ onDevice: 'available' }) as never} announcer={mkAnnouncer()} />);
    expect(screen.getByText(/may be processed remotely/i)).toBeTruthy();
    expect(screen.queryByText(/on-device recognition is requested/i)).toBeNull();
    unmount();
    render(<ControlsPanel bindings={mkBindings()} voice={mkVoice({ onDevice: 'available', locality: 'on-device-requested' }) as never} announcer={mkAnnouncer()} />);
    expect(screen.queryByText(/may be processed remotely/i)).toBeNull();
    expect(screen.getByText(/on-device recognition is requested/i)).toBeTruthy();
  });
  it('offers on-device install when downloadable, from a click', async () => {
    const voice = mkVoice({ onDevice: 'downloadable' });
    render(<ControlsPanel bindings={mkBindings()} voice={voice as never} announcer={mkAnnouncer()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Install on-device speech' }));
    await waitFor(() => expect(voice.installOnDevice).toHaveBeenCalled());
  });
  it('mount never probes on-device availability; only the Check button does', async () => {
    const voice = mkVoice();
    render(<ControlsPanel bindings={mkBindings()} voice={voice as never} announcer={mkAnnouncer()} />);
    expect(voice.refreshOnDevice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check on-device speech' }));
    await waitFor(() => expect(voice.refreshOnDevice).toHaveBeenCalledTimes(1));
  });
});
