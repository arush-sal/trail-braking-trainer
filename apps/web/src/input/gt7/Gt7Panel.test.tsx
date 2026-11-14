import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Gt7Panel } from './Gt7Panel';
import { createGt7Client, type Gt7ClientOptions, type Gt7Event, type SocketLike } from './gt7Client';
import { mapSample, parseServerMessage, type Hello } from './protocol';
import helloRaw from './testdata/v1/valid/hello.live.json?raw';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const counters0 = () => ({ frames: 0, gaps: 0, missing: 0, sourceGaps: 0, duplicates: 0, outOfOrder: 0, reconnects: 0 });

const hello = parseServerMessage(helloRaw) as Hello;
const SID = hello.sessionId;
const sample = { sessionId: SID, sequence: 1n, packageId: 1, source: 'LIVE' as const, recvTimestamp: '2026-11-14T12:00:00Z', sourceGap: false, droppedSincePrevious: 0, brake: 40, throttle: 0 };

describe('Gt7Panel', () => {
  it('connects with token out of the URL, shows capabilities, B/T and counters', async () => {
    vi.useFakeTimers();
    let opts: Gt7ClientOptions | undefined;
    const close = vi.fn();
    const onFrame = vi.fn();
    render(<Gt7Panel onFrame={onFrame} createClient={(o) => ((opts = o), { close, counters: () => ({ frames: 1, gaps: 2, missing: 3, sourceGaps: 6, duplicates: 4, outOfOrder: 0, reconnects: 5 }) })} />);
    const url = screen.getByLabelText('Collector URL') as HTMLInputElement;
    expect(url.value).toBe('ws://127.0.0.1:8765/v1/stream');
    const token = screen.getByLabelText('Token (optional)') as HTMLInputElement;
    expect(token.type).toBe('password');
    expect(token.autocomplete).toBe('off');
    expect(screen.getByText('n/a', { selector: '[data-testid=brake]' })).toBeTruthy();
    fireEvent.change(token, { target: { value: 'tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    expect(opts!.url).toBe('ws://127.0.0.1:8765/v1/stream');
    expect(opts!.token).toBe('tok');
    const send = (e: Gt7Event) => act(() => opts!.onEvent(e));
    send({ type: 'status', status: 'live', epoch: 1 });
    send({ type: 'hello', hello, epoch: 1 });
    const frame = mapSample(sample, 0);
    send({ type: 'frame', frame, epoch: 1 });
    expect(onFrame).toHaveBeenCalledWith(frame, 1);
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByText('live', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByText(/driver_steering_input_unverified/)).toBeTruthy();
    expect(screen.getByText(/collector v0\.0\.0-test/)).toBeTruthy();
    expect(screen.getByText(/session 4f9c2e7a/)).toBeTruthy();
    expect(screen.getByTestId('brake').textContent).toBe('40%');
    expect(screen.getByTestId('throttle').textContent).toBe('0%');
    expect(screen.getByTestId('steering').textContent).toBe('n/a');
    expect(screen.getByTestId('counters').textContent).toMatch(/gaps 2/);
    expect(screen.getByTestId('counters').textContent).toMatch(/reconnects 5/);
    send({ type: 'error', epoch: 1, code: 'read-only', message: 'Collector closed the read-only stream', fatal: true });
    expect(screen.getByRole('alert').textContent).toMatch(/read-only/);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('emits an unavailable stale frame when status leaves live, so consumers silence', async () => {
    let opts: Gt7ClientOptions | undefined;
    const onFrame = vi.fn();
    render(<Gt7Panel onFrame={onFrame} createClient={(o) => ((opts = o), { close: vi.fn(), counters: counters0 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await act(async () => {});
    const send = (e: Gt7Event) => act(() => opts!.onEvent(e));
    send({ type: 'status', status: 'connecting', epoch: 1 });
    expect(onFrame).not.toHaveBeenCalled(); // not live yet: nothing to retract
    send({ type: 'hello', hello, epoch: 1 });
    send({ type: 'status', status: 'live', epoch: 1 });
    send({ type: 'status', status: 'stale', epoch: 1 });
    send({ type: 'source-lost', reason: 'no_accepted_frames_within_timeout', epoch: 1 });
    expect(screen.getByRole('alert').textContent).toMatch(/stale/);
    expect(onFrame).toHaveBeenCalledTimes(1);
    const [f, epoch] = onFrame.mock.calls[0];
    expect(epoch).toBe(1);
    expect(f).toMatchObject({ source: 'gt7', sourceId: `gt7:${SID}`, quality: { stale: true } });
    for (const k of ['brake', 'steering', 'throttle'] as const) expect(f[k]).toMatchObject({ available: false, rawValue: null, normalized: null });
    send({ type: 'status', status: 'reconnecting', epoch: 1 });
    expect(onFrame).toHaveBeenCalledTimes(1); // only once per live->not-live transition
  });
});

describe('Gt7Panel 1006 hints', () => {
  // Connect with a given LNA state, then report an unreachable (1006 before open) error.
  async function failWith(state: string) {
    vi.stubGlobal('navigator', { ...navigator, permissions: { query: async () => ({ state }) } });
    let opts: Gt7ClientOptions | undefined;
    render(<Gt7Panel createClient={(o) => ((opts = o), { close: vi.fn(), counters: counters0 })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(opts).toBeDefined());
    act(() => opts!.onEvent({ type: 'error', epoch: 1, code: 'unreachable', message: 'generic', fatal: false }));
    return screen.getByRole('alert').textContent!;
  }
  it('prompt is not treated as an LNA block: collector-rejection hint', async () => {
    const h = await failWith('prompt');
    expect(h).toContain(`--ws-origin=${location.origin} `);
    expect(h).not.toMatch(/dismissed/);
  });
  it('granted/unsupported -> collector rejection with the exact --ws-origin of this page', async () => {
    expect(await failWith('granted')).toContain(`--ws-origin=${location.origin} `);
  });
  it('shows the collector run command with this page origin', () => {
    render(<Gt7Panel createClient={() => ({ close: vi.fn(), counters: counters0 })} />);
    expect(screen.getByTestId('run-cmd').textContent).toBe(`gt7-collector --ps5=<ps5-ip> --rtps=none --ws-listen=127.0.0.1:8765 --ws-origin=${location.origin}`);
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

describe('Gt7Panel never renders the token', () => {
  it('a server that selects the gt7.token.<token> subprotocol or echoes it in a close reason does not leak it', async () => {
    const TOKEN = 'abcdef0123456789'.repeat(3);
    const socks: (SocketLike & { protocol: string })[] = [];
    const createSocket = () => {
      const s = { protocol: '', send: vi.fn(), close: vi.fn(), onopen: null, onmessage: null, onclose: null, onerror: null } as unknown as SocketLike & { protocol: string };
      socks.push(s);
      return s;
    };
    render(<Gt7Panel createClient={(o) => createGt7Client({ ...o, pageProtocol: 'http:', createSocket, reconnect: { baseMs: 1, maxMs: 1 } })} />);
    fireEvent.change(screen.getByLabelText('Token (optional)'), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(socks).toHaveLength(1));
    act(() => {
      socks[0].protocol = `gt7.token.${TOKEN}`;
      socks[0].onopen!({});
    });
    expect(screen.getByRole('alert').textContent).toMatch(/did not negotiate gt7\.inputs\.v1/);
    expect(document.body.textContent).not.toContain(TOKEN);
  });
});
