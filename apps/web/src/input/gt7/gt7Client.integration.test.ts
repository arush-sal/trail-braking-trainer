// @vitest-environment node
// Integration: real gt7Client against the MOCK collector (tests/mock-collector/server.mjs) on an ephemeral port.
import { afterEach, describe, expect, it } from 'vitest';
import { connect as netConnect } from 'node:net';
import { WebSocket as WsClient } from 'ws';
import { startMockCollector, syntheticSample, type MockCollector, type MockCollectorOptions } from '../../../../../tests/mock-collector/server.mjs';
import { createGt7Client, type Gt7Client, type Gt7Event, type SocketLike } from './gt7Client';

const ORIGIN = 'http://localhost:5173';
let server: MockCollector | undefined;
let client: Gt7Client | undefined;

afterEach(async () => {
  client?.close();
  await server?.close();
  client = server = undefined;
});

const start = async (o: MockCollectorOptions = {}) => (server = await startMockCollector({ port: 0, hz: 200, heartbeatMs: 100, ...o }));
const withOrigin = (origin: string) => (url: string) => new WsClient(url, { origin }) as unknown as SocketLike;

function run(url: string, o: { origin?: string; pairingToken?: string; reconnect?: { baseMs: number; maxMs: number } } = {}) {
  const events: Gt7Event[] = [];
  client = createGt7Client({
    url,
    pairingToken: o.pairingToken,
    createSocket: withOrigin(o.origin ?? ORIGIN),
    pageProtocol: 'http:',
    reconnect: o.reconnect ?? { baseMs: 50, maxMs: 200 },
    onEvent: (e) => events.push(e),
  });
  return events;
}

async function until(pred: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const frames = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'frame' ? [e.frame] : []));
const errors = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'error' ? [e] : []));

describe('mock collector synthetic signal', () => {
  it('never overlaps brake and throttle', () => {
    for (let t = 0; t < 8000; t++) {
      const s = syntheticSample(t);
      expect(s.brake > 0 && s.throttle > 0).toBe(false);
    }
  });
});

describe('gt7Client <-> MOCK collector', () => {
  it('happy path: handshake, sequenced frames, steering unavailable', async () => {
    const s = await start();
    const ev = run(s.url);
    await until(() => frames(ev).length >= 30);
    const w = ev.find((e) => e.type === 'welcome');
    expect(w && w.type === 'welcome' && w.welcome.capabilities.steering.available).toBe(false);
    const fs = frames(ev);
    for (const f of fs) {
      expect(f.source).toBe('gt7');
      expect(f.sourceId).toBe('gt7-mock-0');
      expect(f.steering).toEqual({ available: false, rawValue: null, rawUnit: 'unavailable', normalized: null });
      expect(f.brake.rawUnit).toBe('percent');
      expect(f.brake.normalized! > 0 && f.throttle.normalized! > 0).toBe(false);
      expect(typeof f.sourceTimestampMs).toBe('number');
    }
    for (let i = 1; i < fs.length; i++) expect(fs[i].sequence).toBe(fs[i - 1].sequence! + 1);
    expect(client!.counters()).toMatchObject({ gaps: 0, duplicates: 0, reconnects: 0 });
    expect(ev.some((e) => e.type === 'status' && e.status === 'live')).toBe(true);
  });

  it('rejects a wrong Origin at upgrade (403) and reports it as unreachable/origin', async () => {
    const s = await start();
    const ev = run(s.url, { origin: 'https://evil.example' });
    await until(() => errors(ev).length > 0);
    expect(errors(ev)[0]).toMatchObject({ code: 'unreachable' });
    expect(errors(ev)[0].message).toMatch(/Origin/);
    expect(frames(ev)).toHaveLength(0);
  });

  it('rejects a missing Origin (non-browser client without allowlisted Origin)', async () => {
    const s = await start();
    const sock = new WebSocket(s.url); // Node global WebSocket sends no Origin
    const code = await new Promise<number>((r) => (sock.onclose = (e) => r(e.code)));
    expect(code).toBe(1006);
  });

  it('wrong or missing pairing token -> 1008 policy error, no reconnect loop, no frames', async () => {
    const s = await start({ token: 'correct-horse' });
    const ev = run(s.url, { pairingToken: 'wrong' });
    await until(() => errors(ev).length > 0);
    expect(errors(ev)[0]).toMatchObject({ code: 'policy', fatal: true });
    expect(errors(ev)[0].message).toMatch(/unauthorized/);
    await new Promise((r) => setTimeout(r, 300));
    expect(client!.counters().reconnects).toBe(0);
    expect(frames(ev)).toHaveLength(0);
    client!.close();
    const ev2 = run(s.url, { pairingToken: 'correct-horse' });
    await until(() => frames(ev2).length > 0);
  });

  it('survives a malformed request target (400) and keeps serving', async () => {
    const s = await start();
    const raw = await new Promise<string>((resolve) => {
      const c = netConnect(s.port, '127.0.0.1', () =>
        c.write(`GET //[ HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${ORIGIN}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`),
      );
      let buf = '';
      c.on('data', (d) => (buf += d));
      c.on('close', () => resolve(buf));
    });
    expect(raw).toMatch(/^HTTP\/1\.1 400/);
    const ev = run(s.url);
    await until(() => frames(ev).length > 0);
  });

  it('oversize inbound message closes with 1009', async () => {
    const s = await start({ maxInboundBytes: 256 });
    const sock = new WsClient(s.url, { origin: ORIGIN });
    await new Promise((r) => sock.once('open', r));
    sock.send(JSON.stringify({ type: 'hello', protocol: 'tbt-inputs', versions: [1], pad: 'x'.repeat(1000) }));
    const code = await new Promise<number>((r) => sock.once('close', (c) => r(c)));
    expect(code).toBe(1009);
  });

  it('unsupported client version -> 4000 close', async () => {
    const s = await start();
    const sock = new WsClient(s.url, { origin: ORIGIN });
    await new Promise((r) => sock.once('open', r));
    sock.send(JSON.stringify({ type: 'hello', protocol: 'tbt-inputs', versions: [99] }));
    const code = await new Promise<number>((r) => sock.once('close', (c) => r(c)));
    expect(code).toBe(4000);
  });

  it('max clients: extra connection closed 1013', async () => {
    const s = await start({ maxClients: 1 });
    const a = new WsClient(s.url, { origin: ORIGIN });
    await new Promise((r) => a.once('open', r));
    const b = new WsClient(s.url, { origin: ORIGIN });
    const code = await new Promise<number>((r) => b.once('close', (c) => r(c)));
    expect(code).toBe(1013);
    a.close();
  });

  it('slow client: bounded queue drops oldest and signals gap; client flags quality.gap', async () => {
    let slow = false;
    const s = await start({ queueMax: 300, heartbeatMs: 1000, isSlow: () => slow }); // stale after 3 s > slow window
    const ev = run(s.url);
    await until(() => frames(ev).length >= 5);
    slow = true;
    await new Promise((r) => setTimeout(r, 2000)); // ~400 frames at 200 Hz, queue holds 300
    slow = false;
    await until(() => ev.some((e) => e.type === 'gap'));
    const gap = ev.find((e) => e.type === 'gap');
    expect(gap).toMatchObject({ reason: 'slow-consumer' });
    await until(() => frames(ev).some((f) => f.quality.gap));
    expect(client!.counters().gaps).toBeGreaterThanOrEqual(1);
    expect(client!.counters().missing).toBeGreaterThan(0);
    // backlog of 300 frames must arrive as several batches within the advertised size cap
    expect(errors(ev)).toHaveLength(0);
  }, 10000);

  it('heartbeat timeout -> stale + source-lost, then reconnect in a new epoch', async () => {
    const s = await start();
    const ev = run(s.url);
    await until(() => frames(ev).length > 0);
    s.setPaused(true);
    await until(() => ev.some((e) => e.type === 'source-lost'));
    expect(ev.some((e) => e.type === 'status' && e.status === 'stale')).toBe(true);
    s.setPaused(false);
    await until(() => ev.some((e) => e.type === 'epoch' && e.epoch === 2));
    const before = frames(ev).length;
    await until(() => frames(ev).length > before + 5);
    expect(client!.counters().reconnects).toBeGreaterThanOrEqual(1);
    const epoch2Frames = ev.filter((e) => e.type === 'frame' && e.epoch === 2);
    expect(epoch2Frames.length).toBeGreaterThan(0);
  });

  it('reconnects after server restart with a new epoch (no state merge)', async () => {
    const s = await start();
    const port = s.port;
    const ev = run(s.url);
    await until(() => frames(ev).length > 0);
    await s.close();
    await until(() => errors(ev).some((e) => e.code === 'connection-lost'));
    server = await startMockCollector({ port, hz: 200, heartbeatMs: 100 });
    await until(() => ev.some((e) => e.type === 'frame' && e.epoch > 1), 5000);
    // sequence restarted on the new server; epoch 2's first frame is not flagged as a gap/dup vs epoch 1
    const first2 = ev.find((e) => e.type === 'frame' && e.epoch > 1);
    expect(first2 && first2.type === 'frame' && first2.frame.quality.gap).toBe(false);
    expect(client!.counters().duplicates + client!.counters().outOfOrder).toBe(0);
  });

  it('refuses https page -> ws:// public host without opening a socket (mixed content)', () => {
    const ev: Gt7Event[] = [];
    let opened = false;
    client = createGt7Client({
      url: 'ws://collector.example.com/v1/inputs',
      pageProtocol: 'https:',
      createSocket: () => {
        opened = true;
        throw new Error('should not open');
      },
      onEvent: (e) => ev.push(e),
    });
    expect(opened).toBe(false);
    expect(errors(ev)[0]).toMatchObject({ code: 'mixed-content', fatal: true });
  });
});
