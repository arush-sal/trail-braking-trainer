#!/usr/bin/env node
// *** MOCK GT7 COLLECTOR *** Synthetic brake/throttle only. NOT the real gt7-telemetry-collector
// and NOT evidence of GT7 behavior. Implements the DRAFT wire protocol v1 in docs/input-protocol.md.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

const PROTOCOL = 'tbt-inputs';
const VERSION = 1;
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
const MAX_BATCH = 128; // must match the client's cap (docs/input-protocol.md)
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

const smooth = (x) => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};
/** Synthetic percent values over a 4 s cycle; brake and throttle never overlap. */
export function syntheticSample(ms) {
  const p = (ms % 4000) / 4000;
  const brake = p < 0.5 ? 100 * smooth(p / 0.15) * (1 - smooth((p - 0.25) / 0.25)) : 0;
  const throttle = p >= 0.55 ? 100 * smooth((p - 0.55) / 0.2) * (1 - smooth((p - 0.9) / 0.1)) : 0;
  return { brake: Math.round(brake * 10) / 10, throttle: Math.round(throttle * 10) / 10 };
}

const tokenOk = (expected, got) => {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Start the MOCK collector. Resolves once listening.
 * isSlow(ws) decides when a client is "not keeping up" (default: bufferedAmount over highWaterBytes);
 * tests may inject it because loopback kernel buffers hide real backpressure for a long time.
 */
export async function startMockCollector({
  host = '127.0.0.1',
  port = 8787,
  path = '/v1/inputs',
  origins = DEFAULT_ORIGINS,
  token,
  maxClients = 4,
  maxInboundBytes = 4096,
  maxFrameBytes = 16 * 1024,
  hz = 60,
  heartbeatMs = 1000,
  queueMax = 256,
  highWaterBytes = 64 * 1024,
  helloTimeoutMs = 5000,
  rateLimitPerSec = 5,
  isSlow = (ws) => ws.bufferedAmount > highWaterBytes,
  log = () => {},
} = {}) {
  if (!LOOPBACK.test(host) && !token) throw new Error('Refusing to bind a non-loopback host without --token (LAN use requires pairing).');
  // ponytail: batch size bounds message size only because frames are tiny; size-aware split if frames grow.
  if (MAX_BATCH * 80 > maxFrameBytes) throw new Error('maxFrameBytes too small for MAX_BATCH frames');
  const http = createServer((_req, res) => res.writeHead(426).end('MOCK collector: WebSocket only\n'));
  const wss = new WebSocketServer({ noServer: true, maxPayload: maxInboundBytes });
  const clients = new Set(); // handshaken clients: { ws, queue, dropFrom, dropTo }
  const t0 = performance.now();
  let seq = 0;
  let paused = false;

  http.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      log(`reject ${status} ${text}`);
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
    };
    socket.on('error', () => {});
    // CSWSH defence first: browsers always send Origin; CORS does not protect WebSockets.
    if (!origins.includes(req.headers.origin)) return reject(403, 'Forbidden');
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname; // untrusted request target
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== path) return reject(404, 'Not Found');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws) {
    if (wss.clients.size > maxClients) return ws.close(1013, 'server-full');
    const fail = (code, errCode, message) => {
      ws.send(JSON.stringify({ type: 'error', code: errCode, message }));
      ws.close(code, errCode);
    };
    const helloTimer = setTimeout(() => fail(1002, 'hello-timeout', 'no hello received'), helloTimeoutMs);
    let client = null;
    let windowStart = Date.now();
    let count = 0;
    ws.on('message', (data, isBinary) => {
      if (Date.now() - windowStart >= 1000) (windowStart = Date.now()), (count = 0);
      if (++count > rateLimitPerSec) return fail(1008, 'rate-limit', 'too many messages');
      if (client) return; // read-only stream: post-hello messages are ignored (but rate limited)
      clearTimeout(helloTimer);
      let m;
      try {
        m = isBinary ? null : JSON.parse(String(data));
      } catch {
        m = null;
      }
      if (!m || m.type !== 'hello' || m.protocol !== PROTOCOL || !Array.isArray(m.versions)) return fail(1002, 'bad-hello', 'expected hello');
      if (!m.versions.includes(VERSION)) return fail(4000, 'unsupported-version', `server supports version ${VERSION}`);
      if (token && !tokenOk(token, m.pairingToken)) return fail(1008, 'unauthorized', 'pairing token missing or wrong'); // never log the token
      ws.send(
        JSON.stringify({
          type: 'welcome',
          version: VERSION,
          collectorVersion: 'mock-0.1.0',
          sourceId: 'gt7-mock-0',
          capabilities: {
            brake: { available: true, rawUnit: 'percent' },
            throttle: { available: true, rawUnit: 'percent' },
            steering: { available: false, reason: 'MOCK: GT7 driver steering input is not verified; not provided.' },
          },
          heartbeatMs,
          maxFrameBytes, // largest message the server will SEND; batches are split to fit
        }),
      );
      client = { ws, queue: [], dropFrom: null, dropTo: null };
      clients.add(client);
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client) clients.delete(client);
    });
    ws.on('error', () => {});
  }

  const tick = setInterval(() => {
    if (paused) return;
    const ts = Math.round(performance.now() - t0);
    const frame = { seq: ++seq, ts, ...syntheticSample(ts) };
    for (const c of clients) {
      c.queue.push(frame);
      if (c.queue.length > queueMax) {
        const dropped = c.queue.shift(); // drop-oldest; never unbounded
        c.dropFrom ??= dropped.seq;
        c.dropTo = dropped.seq;
      }
      if (isSlow(c.ws)) continue;
      if (c.dropFrom !== null) {
        c.ws.send(JSON.stringify({ type: 'gap', fromSeq: c.dropFrom, toSeq: c.dropTo, reason: 'slow-consumer' }));
        c.dropFrom = c.dropTo = null;
      }
      for (let i = 0; i < c.queue.length; i += MAX_BATCH) c.ws.send(JSON.stringify({ type: 'frames', frames: c.queue.slice(i, i + MAX_BATCH) }));
      c.queue = [];
    }
  }, 1000 / hz);

  const hb = setInterval(() => {
    if (paused) return;
    for (const c of clients) if (!isSlow(c.ws)) c.ws.send(JSON.stringify({ type: 'heartbeat', seq }));
  }, heartbeatMs);

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  http.on('clientError', (_e, socket) => socket.destroy()); // malformed HTTP must not crash the mock
  const actualPort = http.address().port;
  return {
    port: actualPort,
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${actualPort}${path}`,
    clientCount: () => clients.size,
    /** Stop all frames and heartbeats (simulates a hung collector). */
    setPaused: (p) => void (paused = p),
    close: () =>
      new Promise((resolve) => {
        clearInterval(tick);
        clearInterval(hb);
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        http.close(() => resolve());
      }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
      origin: { type: 'string', multiple: true },
      token: { type: 'string' },
      hz: { type: 'string', default: '60' },
      'max-clients': { type: 'string', default: '4' },
    },
  });
  const token = values.token ?? process.env.TBT_MOCK_TOKEN;
  const s = await startMockCollector({
    host: values.host,
    port: Number(values.port),
    origins: values.origin ?? DEFAULT_ORIGINS,
    token,
    hz: Number(values.hz),
    maxClients: Number(values['max-clients']),
    log: (m) => console.error(`[mock-collector] ${m}`),
  });
  console.error(`[mock-collector] MOCK listening on ${s.url} origins=${(values.origin ?? DEFAULT_ORIGINS).join(',')} token=${token ? 'required' : 'none'}`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
