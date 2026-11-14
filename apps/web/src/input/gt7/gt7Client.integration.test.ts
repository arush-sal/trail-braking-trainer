// @vitest-environment node
// Integration: real gt7Client against the MOCK gt7.inputs.v1 collector (tests/mock-collector/server.mjs) on an ephemeral port.
// The MOCK is not the real gt7-telemetry-collector; contract conformance comes from the copied v0.3.0 fixtures.
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { startMockCollector, syntheticSample, type MockCollector, type MockCollectorOptions } from '../../../../../tests/mock-collector/server.mjs';
import { createGt7Client, type Gt7Client, type Gt7Event, type SocketLike } from './gt7Client';
import { parseServerMessage } from './protocol';

const ORIGIN = 'http://localhost:5173';
const TOKEN = '0123456789abcdef'.repeat(4);
let server: MockCollector | undefined;
let client: Gt7Client | undefined;

afterEach(async () => {
  client?.close();
  await server?.close();
  client = server = undefined;
});

const start = async (o: MockCollectorOptions = {}) => (server = await startMockCollector({ port: 0, hz: 200, sourceTimeoutMs: 150, ...o }));
const withOrigin = (origin: string) => (url: string, protocols: string[]) => new WsClient(url, protocols, { origin }) as unknown as SocketLike;

function run(url: string, o: { origin?: string; token?: string } = {}) {
  const events: Gt7Event[] = [];
  client = createGt7Client({ url, token: o.token, createSocket: withOrigin(o.origin ?? ORIGIN), pageProtocol: 'http:', reconnect: { baseMs: 50, maxMs: 200 }, onEvent: (e) => events.push(e) });
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
const statuses = (ev: Gt7Event[]) => ev.flatMap((e) => (e.type === 'status' ? [e.status] : []));
/** Raw `ws` client: resolves the HTTP status of a rejected upgrade, or the close code. */
const rawConnect = (url: string, protocols: string[], origin = ORIGIN) =>
  new Promise<{ status?: number; ws: WsClient; msgs: string[] }>((resolve) => {
    const ws = new WsClient(url, protocols, { origin });
    const msgs: string[] = [];
    ws.on('message', (d) => msgs.push(String(d)));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode, ws, msgs }));
    ws.on('error', () => {});
    ws.on('open', () => resolve({ ws, msgs }));
  });

describe('mock collector synthetic signal', () => {
  it('never overlaps brake and throttle', () => {
    for (let t = 0; t < 8000; t++) {
      const s = syntheticSample(t);
      expect(s.brake > 0 && s.throttle > 0).toBe(false);
    }
  });
});

describe('MOCK collector speaks gt7.inputs.v1', () => {
  it('every message parses with the contract parser; hello first; healthz ok', async () => {
    const s = await start();
    const { ws, msgs } = await rawConnect(s.url, ['gt7.inputs.v1']);
    expect(ws.protocol).toBe('gt7.inputs.v1');
    await until(() => msgs.length > 20);
    ws.close();
    const parsed = msgs.map(parseServerMessage);
    expect(parsed[0].type).toBe('hello');
    expect(new Set(parsed.map((m) => m.type !== 'ignored' && m.sessionId)).size).toBe(1);
    const res = await fetch(`http://127.0.0.1:${s.port}/healthz`);
    expect([res.status, await res.json(), res.headers.get('cache-control')]).toEqual([200, { status: 'ok' }, 'no-store']);
  });

  it.each([
    ['no subprotocol', [], ORIGIN, 400],
    ['case-variant subprotocol', ['GT7.inputs.v1'], ORIGIN, 400],
    ['two token entries', ['gt7.inputs.v1', 'gt7.token.a', 'gt7.token.b'], ORIGIN, 400],
    ['wrong Origin', ['gt7.inputs.v1'], 'https://evil.example', 403],
  ])('rejects %s before upgrade (HTTP %i)', async (_n, protocols, origin, status) => {
    const s = await start();
    expect((await rawConnect(s.url, protocols, origin)).status).toBe(status);
  });

  it('token: missing/wrong -> 401, right -> open; never echoed', async () => {
    const s = await start({ token: TOKEN });
    expect((await rawConnect(s.url, ['gt7.inputs.v1'])).status).toBe(401);
    expect((await rawConnect(s.url, ['gt7.inputs.v1', 'gt7.token.wrong'])).status).toBe(401);
    const ok = await rawConnect(s.url, ['gt7.inputs.v1', `gt7.token.${TOKEN}`]);
    expect(ok.ws.protocol).toBe('gt7.inputs.v1');
    ok.ws.close();
  });

  it('max clients -> 503', async () => {
    const s = await start({ maxClients: 1 });
    const a = await rawConnect(s.url, ['gt7.inputs.v1']);
    expect((await rawConnect(s.url, ['gt7.inputs.v1'])).status).toBe(503);
    a.ws.close();
  });

  it('any client message -> close 1008 read_only_stream; oversized -> 1009', async () => {
    const s = await start();
    for (const [payload, code] of [['hi', 1008], ['x'.repeat(2000), 1009]] as const) {
      const { ws } = await rawConnect(s.url, ['gt7.inputs.v1']);
      const closed = new Promise<[number, string]>((r) => ws.once('close', (c, why) => r([c, String(why)])));
      ws.send(payload);
      const [c, why] = await closed;
      expect(c).toBe(code);
      if (code === 1008) expect(why).toBe('read_only_stream');
    }
  });
});

describe('gt7Client <-> MOCK collector', () => {
  it('happy path: subprotocol handshake, sequenced frames, steering unavailable, nothing sent', async () => {
    const s = await start({ token: TOKEN });
    const ev = run(s.url, { token: TOKEN });
    await until(() => frames(ev).length >= 30);
    const h = ev.find((e) => e.type === 'hello');
    expect(h && h.type === 'hello' && h.hello).toMatchObject({ collectorVersion: expect.stringMatching(/MOCK/), capabilities: { steering: { available: false } } });
    const fs = frames(ev);
    for (const f of fs) {
      expect(f.sourceId).toBe(`gt7:${s.sessionId}`);
      expect(f.steering).toEqual({ available: false, rawValue: null, rawUnit: 'unavailable', normalized: null });
      expect(f.brake.normalized! > 0 && f.throttle.normalized! > 0).toBe(false);
    }
    for (let i = 1; i < fs.length; i++) expect(fs[i].sequence).toBe(fs[i - 1].sequence! + 1);
    expect(client!.counters()).toMatchObject({ gaps: 0, duplicates: 0, reconnects: 0 });
    expect(s.received()).toBe(0);
  });

  it('wrong token -> unreachable (browser-like 1006), keeps retrying, no frames', async () => {
    const s = await start({ token: TOKEN });
    const ev = run(s.url, { token: 'f'.repeat(64) });
    await until(() => errors(ev).length >= 2);
    expect(errors(ev)[0]).toMatchObject({ code: 'unreachable', fatal: false });
    expect(errors(ev)[0].message).toMatch(/--ws-origin=/);
    expect(frames(ev)).toHaveLength(0);
  });

  it('waiting_for_source -> source_live/first_frame', async () => {
    const s = await start({ startPaused: true });
    const ev = run(s.url);
    await until(() => statuses(ev).includes('waiting'));
    expect(frames(ev)).toHaveLength(0);
    s.setPaused(false);
    await until(() => frames(ev).length > 0);
    expect(statuses(ev)).toEqual(['connecting', 'waiting', 'live']);
  });

  it('source stale -> stale + source-lost without reconnecting; resume -> live', async () => {
    const s = await start();
    const ev = run(s.url);
    await until(() => frames(ev).length > 5);
    s.setPaused(true);
    await until(() => ev.some((e) => e.type === 'source-lost'));
    expect(ev.find((e) => e.type === 'source-lost')).toMatchObject({ reason: 'no_accepted_frames_within_timeout' });
    const n = frames(ev).length;
    s.setPaused(false);
    await until(() => frames(ev).length > n + 5);
    expect(statuses(ev).slice(-2)).toEqual(['stale', 'live']);
    expect(client!.counters().reconnects).toBe(0);
  });

  it('slow client: bounded queue drops oldest; droppedSincePrevious flags quality.gap', async () => {
    let slow = false;
    const s = await start({ queueMax: 50, isSlow: () => slow, sourceTimeoutMs: 5000 });
    const ev = run(s.url);
    await until(() => frames(ev).length >= 5);
    slow = true;
    await new Promise((r) => setTimeout(r, 600)); // ~120 frames at 200 Hz, queue holds 50
    slow = false;
    await until(() => frames(ev).some((f) => f.quality.gap));
    expect(client!.counters().gaps).toBe(1);
    expect(client!.counters().missing).toBeGreaterThan(30);
    expect(errors(ev)).toHaveLength(0);
  });

  it('collector shutdown (1001) -> reconnect, fresh hello with a new sessionId, no stitching', async () => {
    const s = await start();
    const { port, sessionId } = s;
    const ev = run(s.url);
    await until(() => frames(ev).length > 0);
    await s.close();
    await until(() => errors(ev).some((e) => e.code === 'shutdown'));
    server = await startMockCollector({ port, hz: 200 });
    await until(() => ev.some((e) => e.type === 'frame' && e.epoch > 1), 5000);
    const first2 = ev.find((e) => e.type === 'frame' && e.epoch > 1);
    expect(first2 && first2.type === 'frame' && first2.frame).toMatchObject({ sourceId: `gt7:${server.sessionId}`, quality: { gap: false } });
    expect(server.sessionId).not.toBe(sessionId);
    expect(client!.counters().duplicates + client!.counters().outOfOrder).toBe(0);
  });
});
