import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Gt7Panel } from './Gt7Panel';
import type { Gt7ClientOptions, Gt7Event } from './gt7Client';
import { mapFrame, parseWelcome } from './protocol';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const counters0 = () => ({ frames: 0, gaps: 0, missing: 0, duplicates: 0, outOfOrder: 0, reconnects: 0 });

const welcome = parseWelcome({ type: 'welcome', version: 1, collectorVersion: 'mock-0.1.0', sourceId: 'gt7-mock-0', capabilities: { brake: { available: true, rawUnit: 'percent' }, throttle: { available: true, rawUnit: 'percent' }, steering: { available: false, reason: 'not verified' } }, heartbeatMs: 1000, maxFrameBytes: 4096 });

describe('Gt7Panel', () => {
  it('connects with token out of the URL, shows capabilities, B/T and counters', async () => {
    vi.useFakeTimers();
    let opts: Gt7ClientOptions | undefined;
    const close = vi.fn();
    const onFrame = vi.fn();
    render(<Gt7Panel onFrame={onFrame} createClient={(o) => ((opts = o), { close, counters: () => ({ frames: 1, gaps: 2, missing: 3, duplicates: 4, outOfOrder: 0, reconnects: 5 }) })} />);
    const url = screen.getByLabelText('Collector URL') as HTMLInputElement;
    expect(url.value).toBe('ws://127.0.0.1:8787/v1/inputs');
    const token = screen.getByLabelText('Pairing token') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.autocomplete).toBe('off');
    expect(screen.getByText('n/a', { selector: '[data-testid=brake]' })).toBeTruthy();
    fireEvent.change(token, { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    expect(opts!.url).toBe('ws://127.0.0.1:8787/v1/inputs');
    expect(opts!.pairingToken).toBe('tok');
    const send = (e: Gt7Event) => act(() => opts!.onEvent(e));
    send({ type: 'status', status: 'live', epoch: 1 });
    send({ type: 'welcome', welcome, epoch: 1 });
    const frame = mapFrame({ seq: 1, ts: 1, brake: 40, throttle: 0 }, welcome, 0, false);
    send({ type: 'frame', frame, epoch: 1 });
    expect(onFrame).toHaveBeenCalledWith(frame, 1);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText(/live/)).toBeTruthy();
    expect(screen.getByText(/not verified/)).toBeTruthy();
    expect(screen.getByTestId('brake').textContent).toBe('40%');
    expect(screen.getByTestId('throttle').textContent).toBe('0%');
    expect(screen.getByTestId('steering').textContent).toBe('n/a');
    expect(screen.getByTestId('counters').textContent).toMatch(/gaps 2/);
    expect(screen.getByTestId('counters').textContent).toMatch(/reconnects 5/);
    send({ type: 'error', epoch: 1, code: 'policy', message: 'Collector refused', fatal: true });
    expect(screen.getByRole('alert').textContent).toMatch(/refused/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('emits an unavailable stale frame when status leaves live, so consumers silence', async () => {
    let opts: Gt7ClientOptions | undefined;
    const onFrame = vi.fn();
    render(<Gt7Panel onFrame={onFrame} createClient={(o) => ((opts = o), { close: vi.fn(), counters: () => ({ frames: 0, gaps: 0, missing: 0, duplicates: 0, outOfOrder: 0, reconnects: 0 }) })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    const send = (e: Gt7Event) => act(() => opts!.onEvent(e));
    send({ type: 'status', status: 'connecting', epoch: 1 });
    expect(onFrame).not.toHaveBeenCalled(); // not live yet: nothing to retract
    send({ type: 'welcome', welcome, epoch: 1 });
    send({ type: 'status', status: 'live', epoch: 1 });
    send({ type: 'status', status: 'stale', epoch: 1 });
    expect(onFrame).toHaveBeenCalledTimes(1);
    const [f, epoch] = onFrame.mock.calls[0];
    expect(epoch).toBe(1);
    expect(f).toMatchObject({ source: 'gt7', sourceId: 'gt7-mock-0', quality: { stale: true } });
    for (const k of ['brake', 'steering', 'throttle'] as const) expect(f[k]).toMatchObject({ available: false, rawValue: null, normalized: null });
    send({ type: 'status', status: 'reconnecting', epoch: 1 });
    expect(onFrame).toHaveBeenCalledTimes(1); // only once per live->not-live transition
  });
});

describe('Gt7Panel local network permission', () => {
  it('shows the permission state and does not connect when denied', async () => {
    const query = vi.fn(async () => ({ state: 'denied' }));
    vi.stubGlobal('navigator', { ...navigator, permissions: { query } });
    const createClient = vi.fn(() => ({ close: vi.fn(), counters: counters0 }));
    render(<Gt7Panel createClient={createClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(screen.getByTestId('lna').textContent).toMatch(/loopback-network: denied/));
    expect(query).toHaveBeenCalledWith({ name: 'loopback-network' });
    expect(screen.getByRole('alert').textContent).toMatch(/site settings/i);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('connects when granted/prompt/unsupported and shows state', async () => {
    vi.stubGlobal('navigator', { ...navigator, permissions: { query: async () => ({ state: 'prompt' }) } });
    const createClient = vi.fn(() => ({ close: vi.fn(), counters: counters0 }));
    render(<Gt7Panel createClient={createClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(createClient).toHaveBeenCalled());
    expect(screen.getByTestId('lna').textContent).toMatch(/loopback-network: prompt/);
  });

  // A permission query that resolves only when the test says so.
  function deferredQuery() {
    const pending: ((v: { state: string }) => void)[] = [];
    vi.stubGlobal('navigator', { ...navigator, permissions: { query: () => new Promise<{ state: string }>((r) => pending.push(r)) } });
    return { resolveAll: async () => { await act(async () => { pending.splice(0).forEach((r) => r({ state: 'granted' })); }); }, count: () => pending.length };
  }

  it('Disconnect during the permission query: no socket is opened', async () => {
    const q = deferredQuery();
    const createClient = vi.fn(() => ({ close: vi.fn(), counters: counters0 }));
    render(<Gt7Panel createClient={createClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await q.resolveAll();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('unmount during the permission query: no socket is opened', async () => {
    const q = deferredQuery();
    const createClient = vi.fn(() => ({ close: vi.fn(), counters: counters0 }));
    const { unmount } = render(<Gt7Panel createClient={createClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    unmount();
    await q.resolveAll();
    expect(createClient).not.toHaveBeenCalled();
  });

  it('double Connect: only the latest click opens a client; a new connect closes the previous client', async () => {
    const q = deferredQuery();
    const clients: { close: ReturnType<typeof vi.fn> }[] = [];
    const createClient = vi.fn(() => { const c = { close: vi.fn(), counters: counters0 }; clients.push(c); return c; });
    render(<Gt7Panel createClient={createClient} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(q.count()).toBe(2);
    await q.resolveAll();
    expect(createClient).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await q.resolveAll();
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(clients[0]!.close).toHaveBeenCalled();
    expect(clients[1]!.close).not.toHaveBeenCalled();
  });
});
