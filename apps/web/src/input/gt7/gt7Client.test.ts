import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGt7Client, queryLnaPermission, type Gt7Event, type SocketLike } from './gt7Client';

const transcripts = Object.fromEntries(
  Object.entries(import.meta.glob('./testdata/v1/transcripts/*.jsonl', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>).map(([p, s]) => [
    p.split('/').pop()!.replace('.jsonl', ''),
    s.split('\n').filter(Boolean),
  ]),
);
const SID = '4f9c2e7a1b3d5f60718293a4b5c6d7e8';
const SID2 = 'ffffffffffffffffffffffffffffffff';

type Fake = Omit<SocketLike, 'protocol'> & { protocol: string; sent: string[]; url: string; protocols: string[]; closed: boolean; recv(m: unknown): void };
function setup(o: { token?: string; negotiated?: string } = {}) {
  const sockets: Fake[] = [];
  const ev: Gt7Event[] = [];
  const c = createGt7Client({
    url: 'ws://127.0.0.1:8765/v1/stream',
    token: o.token,
    pageProtocol: 'http:',
    reconnect: { baseMs: 10, maxMs: 10 },
    createSocket: (url, protocols) => {
      const s: Fake = {
        sent: [],
        url,
        protocols,
        closed: false,
        protocol: '',
        send(d) {
          this.sent.push(d);
        },
        close() {
          this.closed = true;
        },
        recv(m) {
          this.onmessage!({ data: typeof m === 'string' ? m : JSON.stringify(m) });
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      sockets.push(s);
      return s;
    },
    onEvent: (e) => ev.push(e),
  });
  const open = (s = sockets.at(-1)!) => {
    s.protocol = o.negotiated ?? 'gt7.inputs.v1';
    s.onopen!({});
    return s;
  };
  return { sockets, ev, c, open };
}
const frames = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'frame' ? [e.frame] : []));
const statuses = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'status' ? [e.status] : []));
const errors = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'error' ? [e] : []));
const hello = (sessionId = SID, status = 'source_live') => JSON.parse(transcripts['hello-then-samples'][0].replace(SID, sessionId).replace('"source_live"', `"${status}"`));
const sample = (sequence: string, sessionId = SID, extra = {}) => ({ ...JSON.parse(transcripts['hello-then-samples'][1]), sequence, sessionId, ...extra });

afterEach(() => vi.useRealTimers());

describe('transcripts replayed through the client (collector v0.3.0)', () => {
  const replay = (name: string) => {
    const t = setup();
    const s = t.open();
    for (const line of transcripts[name]) s.recv(line);
    return t;
  };

  it('has all 4 transcripts', () => expect(Object.keys(transcripts).sort()).toEqual(['drop-arithmetic', 'hello-then-samples', 'stale-resume', 'waiting-first-frame']));

  it('hello-then-samples: live at connect, first sample is never a gap', () => {
    const { ev, c } = replay('hello-then-samples');
    expect(statuses(ev)).toEqual(['connecting', 'live']);
    expect(frames(ev).map((f) => [f.sequence, f.brake.normalized, f.throttle.normalized, f.quality.gap])).toEqual([
      [2, 0.2, 1, false],
      [3, 0.3, 1, false],
      [4, 0.4, 1, false],
    ]);
    for (const f of frames(ev)) {
      expect(f.steering).toEqual({ available: false, rawValue: null, rawUnit: 'unavailable', normalized: null });
      expect(f.sourceId).toBe(`gt7:${SID}`);
    }
    expect(c.counters()).toMatchObject({ frames: 3, gaps: 0, missing: 0 });
  });

  it('waiting-first-frame: waiting until source_live/first_frame', () => {
    const { ev } = replay('waiting-first-frame');
    expect(statuses(ev)).toEqual(['connecting', 'waiting', 'live']);
    expect(ev.find((e) => e.type === 'hello')).toMatchObject({ hello: { status: 'waiting_for_source', collectorVersion: 'v0.0.0-test' } });
    expect(frames(ev).map((f) => [f.brake.normalized, f.throttle.normalized])).toEqual([
      [0, 1],
      [0.5, 0],
    ]);
  });

  it('drop-arithmetic: droppedSincePrevious marks the frame gap and counts missing', () => {
    const { ev, c } = replay('drop-arithmetic');
    expect(frames(ev).map((f) => [f.sequence, f.quality.gap])).toEqual([
      [1, false],
      [2, false],
      [11, true],
      [12, false],
      [13, false],
      [14, false],
    ]);
    expect(c.counters()).toMatchObject({ frames: 6, gaps: 1, missing: 8 });
  });

  it('stale-resume: source_stale -> stale + source-lost (no reconnect), resume -> live, gap counted', () => {
    const { ev, c, sockets } = replay('stale-resume');
    expect(statuses(ev)).toEqual(['connecting', 'waiting', 'live', 'stale', 'live']);
    expect(ev.filter((e) => e.type === 'source-lost')).toEqual([{ type: 'source-lost', reason: 'no_accepted_frames_within_timeout', epoch: 1 }]);
    expect(frames(ev).map((f) => [f.sequence, f.quality.gap])).toEqual([
      [1, false],
      [2, false],
      [9, true],
    ]);
    expect(c.counters()).toMatchObject({ gaps: 1, missing: 6, reconnects: 0 });
    expect(sockets).toHaveLength(1);
  });
});

describe('createGt7Client (fake socket)', () => {
  it('offers the token only as a subprotocol, never in the URL, and never sends a message', () => {
    const tok = 'a'.repeat(32);
    const { sockets, open, c } = setup({ token: tok });
    const s = open();
    s.recv(hello());
    s.recv(sample('1'));
    expect(s.protocols).toEqual(['gt7.inputs.v1', `gt7.token.${tok}`]);
    expect(s.url).not.toContain(tok);
    expect(sockets.flatMap((x) => x.sent)).toEqual([]);
    c.close();
  });

  it('without a token offers only gt7.inputs.v1', () => {
    const { sockets } = setup();
    expect(sockets[0].protocols).toEqual(['gt7.inputs.v1']);
  });

  it('rejects a malformed token before opening a socket', () => {
    const { sockets, ev } = setup({ token: 'short' });
    expect(sockets).toHaveLength(0);
    expect(errors(ev)[0]).toMatchObject({ code: 'bad-token', fatal: true });
  });

  it('fails fatally when the server does not negotiate gt7.inputs.v1', () => {
    const { ev, sockets, open } = setup({ negotiated: '' });
    const s = open();
    expect(errors(ev)[0]).toMatchObject({ code: 'version-mismatch', fatal: true });
    expect(s.closed).toBe(true);
    expect(sockets).toHaveLength(1);
    expect(statuses(ev).at(-1)).toBe('error');
  });

  it('never puts the token in an error, even if the server selects the token subprotocol or echoes it', () => {
    const tok = 'b'.repeat(40);
    const a = setup({ token: tok, negotiated: `gt7.token.${tok}` });
    a.open();
    expect(errors(a.ev)[0]).toMatchObject({ code: 'version-mismatch', fatal: true, message: 'Collector did not negotiate gt7.inputs.v1. Is this gt7-collector v0.3.0 or later with --ws-listen?' });
    const b = setup({ token: tok });
    b.open().onclose!({ code: 1006, reason: `bad gt7.token.${tok}` });
    b.c.close();
    // A hostile server echoing it in any rendered string field of hello / status.
    const d = setup({ token: tok });
    const s = d.open();
    const h = hello();
    s.recv({ ...h, collectorVersion: `v-${tok}`, capabilities: { ...h.capabilities, steering: { available: false, reason: tok } } });
    s.recv({ type: 'status', protocol: 'gt7.inputs.v1', sessionId: SID, state: 'source_stale', reason: `r-${tok}` });
    d.c.close();
    expect(d.ev.find((e) => e.type === 'hello')).toMatchObject({ hello: { collectorVersion: 'v-<token>' } });
    for (const ev of [a.ev, b.ev, d.ev]) expect(JSON.stringify(ev)).not.toContain(tok);
  });

  it('reconnect backoff doubles from 500 ms and is capped at 30 s by default', () => {
    vi.useFakeTimers();
    const sockets: SocketLike[] = [];
    const c = createGt7Client({
      url: 'ws://127.0.0.1:8765/v1/stream',
      pageProtocol: 'http:',
      onEvent: () => {},
      createSocket: () => {
        const s = { protocol: '', send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null } as SocketLike;
        sockets.push(s);
        return s;
      },
    });
    const delays: number[] = [];
    for (let i = 0; i < 10; i++) {
      sockets.at(-1)!.onclose!({ code: 1006, reason: '' });
      const n = sockets.length;
      let waited = 0;
      while (sockets.length === n) {
        vi.advanceTimersByTime(100);
        waited += 100;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
    c.close();
  });

  it('a sample before hello is a protocol error', () => {
    const { ev, open } = setup();
    open().recv(sample('1'));
    expect(errors(ev)[0]).toMatchObject({ code: 'protocol', fatal: true });
  });

  it('rejects a sample whose sessionId differs from the hello', () => {
    const { ev, open } = setup();
    const s = open();
    s.recv(hello());
    s.recv(sample('1', SID2));
    expect(frames(ev)).toHaveLength(0);
    expect(errors(ev)[0]).toMatchObject({ code: 'protocol', fatal: true });
    expect(errors(ev)[0].message).toMatch(/sessionId/);
  });

  it('a second hello on one connection is a protocol error', () => {
    const { ev, open } = setup();
    const s = open();
    s.recv(hello());
    s.recv(hello());
    expect(errors(ev)[0]).toMatchObject({ code: 'protocol' });
  });

  it('drops duplicate / out-of-order sequences and counts them', () => {
    const { ev, c, open } = setup();
    const s = open();
    s.recv(hello());
    for (const q of ['5', '6', '6', '4', '7']) s.recv(sample(q));
    expect(frames(ev).map((f) => f.sequence)).toEqual([5, 6, 7]);
    expect(c.counters()).toMatchObject({ frames: 3, duplicates: 1, outOfOrder: 1 });
  });

  it('counts upstream sourceGap separately and marks the frame gap', () => {
    const { ev, c, open } = setup();
    const s = open();
    s.recv(hello());
    s.recv(sample('1', SID, { sourceGap: true }));
    expect(frames(ev)[0].quality.gap).toBe(true);
    expect(c.counters()).toMatchObject({ sourceGaps: 1, gaps: 0 });
  });

  it('ignores unknown message types and unknown status states', () => {
    const { ev, open } = setup();
    const s = open();
    s.recv(hello());
    s.recv({ type: 'telemetry_dump', protocol: 'gt7.inputs.v1', sessionId: SID });
    s.recv({ type: 'status', protocol: 'gt7.inputs.v1', sessionId: SID, state: 'source_paused', reason: 'x' });
    expect(errors(ev)).toEqual([]);
    expect(statuses(ev)).toEqual(['connecting', 'live']);
  });

  it('hello while stale reports stale at connect', () => {
    const { ev, open } = setup();
    open().recv(hello(SID, 'source_stale'));
    expect(statuses(ev)).toEqual(['connecting', 'stale']);
  });

  it('rejects an oversized message before parsing', () => {
    const { ev, open } = setup();
    open().recv('x'.repeat(70 * 1024));
    expect(errors(ev)[0]).toMatchObject({ code: 'protocol', fatal: true });
  });

  it('1001 collector_shutdown -> reconnect in a new epoch with a fresh hello (new sessionId accepted, old rejected)', () => {
    vi.useFakeTimers();
    const { ev, sockets, open, c } = setup();
    const a = open();
    a.recv(hello());
    a.recv(sample('10'));
    a.onclose!({ code: 1001, reason: 'collector_shutdown' });
    expect(errors(ev)[0]).toMatchObject({ code: 'shutdown', fatal: false });
    expect(statuses(ev).at(-1)).toBe('reconnecting');
    vi.advanceTimersByTime(20);
    expect(sockets).toHaveLength(2);
    const b = open();
    b.recv(hello(SID2));
    b.recv(sample('1', SID2)); // sequence restarted: not a duplicate/out-of-order vs the old session
    expect(ev.filter((e) => e.type === 'frame').map((e) => e.epoch)).toEqual([1, 2]);
    expect(frames(ev)[1]).toMatchObject({ sourceId: `gt7:${SID2}`, quality: { gap: false } });
    expect(c.counters()).toMatchObject({ reconnects: 1, duplicates: 0, outOfOrder: 0 });
    b.recv(sample('2', SID));
    expect(errors(ev).at(-1)?.message).toMatch(/sessionId/);
    c.close();
  });

  it('1008 read_only_stream is fatal (no reconnect)', () => {
    vi.useFakeTimers();
    const { ev, sockets, open } = setup();
    open().onclose!({ code: 1008, reason: 'read_only_stream' });
    vi.advanceTimersByTime(100);
    expect(errors(ev)[0]).toMatchObject({ code: 'read-only', fatal: true });
    expect(sockets).toHaveLength(1);
  });

  it('1006 before open -> unreachable, retried', () => {
    vi.useFakeTimers();
    const { ev, sockets, c } = setup();
    sockets[0].onclose!({ code: 1006, reason: '' });
    expect(errors(ev)[0]).toMatchObject({ code: 'unreachable', fatal: false });
    vi.advanceTimersByTime(20);
    expect(sockets).toHaveLength(2);
    c.close();
  });

  it('handshake timeout when no hello arrives', () => {
    vi.useFakeTimers();
    const { ev, open, c } = setup();
    open();
    vi.advanceTimersByTime(5001);
    expect(errors(ev)[0]).toMatchObject({ code: 'handshake-timeout', fatal: false });
    c.close();
  });
});

describe('queryLnaPermission', () => {
  const perms = (impl: (name: string) => Promise<{ state: string }>) => ({ query: (d: { name: string }) => impl(d.name) }) as unknown as Permissions;
  it('queries the right name and reports its state; never the legacy name', async () => {
    const asked: string[] = [];
    const p = perms(async (n) => (asked.push(n), { state: 'prompt' }));
    expect(await queryLnaPermission('ws://127.0.0.1:8765', p)).toBe('prompt');
    expect(await queryLnaPermission('ws://192.168.1.2:8765', p)).toBe('prompt');
    expect(asked).toEqual(['loopback-network', 'local-network']);
  });
  it('is best-effort: throws/missing -> unsupported, public host -> not-needed', async () => {
    expect(await queryLnaPermission('ws://127.0.0.1', perms(async () => { throw new TypeError('bad name'); }))).toBe('unsupported');
    expect(await queryLnaPermission('ws://127.0.0.1', undefined)).toBe('unsupported');
    expect(await queryLnaPermission('wss://x.example.com', perms(async () => ({ state: 'granted' })))).toBe('not-needed');
    expect(await queryLnaPermission('ws://127.0.0.1', perms(async () => ({ state: 'denied' })))).toBe('denied');
  });
});
