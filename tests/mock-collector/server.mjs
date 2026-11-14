#!/usr/bin/env node
// *** MOCK GT7 COLLECTOR *** Synthetic brake/throttle only. NOT the real gt7-telemetry-collector
// and NOT evidence of GT7 or collector behavior. Speaks the collector-owned contract gt7.inputs.v1
// (gt7-telemetry-collector v0.3.0, docs/input-protocol.md) closely enough to exercise the trainer client.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { WebSocketServer } from 'ws';

const PROTOCOL = 'gt7.inputs.v1';
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost)$/;
const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];
const CAPS = {
  brake: { available: true, unit: 'percent', min: 0, max: 100 },
  throttle: { available: true, unit: 'percent', min: 0, max: 100 },
  steering: { available: false, reason: 'driver_steering_input_unverified' },
};

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

const digest = (s) => createHash('sha256').update(s).digest();

/**
 * Parse Sec-WebSocket-Protocol like the collector (its ADR 0003): exactly one exact `gt7.inputs.v1`,
 * at most one `gt7.token.*`, no empty entries, at most 8 entries. Returns { token } or null (-> 400).
 */
function parseSubprotocols(header) {
  if (typeof header !== 'string') return null;
  const entries = header.split(',').map((e) => e.trim());
  if (entries.length > 8 || entries.some((e) => !e)) return null;
  if (entries.filter((e) => e === PROTOCOL).length !== 1 || entries.some((e) => e !== PROTOCOL && e.toLowerCase() === PROTOCOL)) return null;
  const tokens = entries.filter((e) => e.startsWith('gt7.token.'));
  return tokens.length > 1 ? null : { token: tokens[0]?.slice('gt7.token.'.length) };
}

/**
 * Start the MOCK collector. Resolves once listening.
 * isSlow(ws) decides when a client is "not keeping up" (default: bufferedAmount over highWaterBytes);
 * tests inject it because loopback kernel buffers hide real backpressure for a long time.
 */
export async function startMockCollector({
  host = '127.0.0.1',
  port = 8765,
  origins = DEFAULT_ORIGINS,
  token,
  maxClients = 4,
  hz = 60,
  queueMax = 64,
  highWaterBytes = 64 * 1024,
  sourceTimeoutMs = 2000,
  startPaused = false,
  isSlow = (ws) => ws.bufferedAmount > highWaterBytes,
  log = () => {},
} = {}) {
  if (!LOOPBACK.test(host) && !token) throw new Error('Refusing to bind a non-loopback host without a token (GT7_WS_TOKEN).');
  const sessionId = randomBytes(16).toString('hex');
  const send = (ws, m) => ws.send(JSON.stringify({ type: m.type, protocol: PROTOCOL, sessionId, ...m }));
  const http = createServer((req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"status":"ok"}');
    res.writeHead(req.url === '/v1/stream' ? 426 : 404).end('MOCK collector\n');
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false, handleProtocols: () => PROTOCOL });
  const clients = new Set(); // { ws, queue, lastSent }
  const t0 = performance.now();
  let seq = 0n;
  let paused = startPaused;
  let state = 'waiting_for_source';
  let lastFrameAt = 0;
  let received = 0;

  http.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      log(`reject ${status} ${text}`); // never log Sec-WebSocket-Protocol: it carries the token
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    socket.on('error', () => {});
    let pathname;
    try {
      pathname = new URL(req.url, 'http://x').pathname; // untrusted request target
    } catch {
      return reject(400, 'Bad Request');
    }
    if (pathname !== '/v1/stream') return reject(404, 'Not Found');
    // Same order as the collector: Origin, subprotocol, token, capacity.
    if (!origins.includes(req.headers.origin)) return reject(403, 'Forbidden');
    const sp = parseSubprotocols(req.headers['sec-websocket-protocol']);
    if (!sp) return reject(400, 'Bad Request');
    if (token && !(sp.token !== undefined && timingSafeEqual(digest(token), digest(sp.token)))) return reject(401, 'Unauthorized');
    if (wss.clients.size >= maxClients) return reject(503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => {
      const c = { ws, queue: [], lastSent: null };
      clients.add(c);
      send(ws, { type: 'hello', collectorVersion: 'mock-0.3.0 (MOCK)', canonicalSchemaVersion: 1, capabilities: CAPS, status: state });
      ws.on('message', () => {
        received++;
        ws.close(1008, 'read_only_stream');
      });
      ws.on('close', () => clients.delete(c));
      ws.on('error', () => {});
    });
  });

  const tick = setInterval(() => {
    const t = performance.now();
    if (paused) {
      if (state === 'source_live' && t - lastFrameAt >= sourceTimeoutMs) {
        state = 'source_stale';
        for (const c of clients) {
          c.queue = []; // queued samples at or below the stale point are discarded
          send(c.ws, { type: 'status', state, reason: 'no_accepted_frames_within_timeout' });
        }
      }
      return;
    }
    lastFrameAt = t;
    if (state !== 'source_live') {
      const reason = state === 'waiting_for_source' ? 'first_frame' : 'source_resumed';
      state = 'source_live';
      for (const c of clients) send(c.ws, { type: 'status', state, reason });
    }
    const ms = Math.round(t - t0);
    const frame = { seq: ++seq, ...syntheticSample(ms) };
    for (const c of clients) {
      c.queue.push(frame);
      if (c.queue.length > queueMax) c.queue.shift(); // drop-oldest; reported via droppedSincePrevious
      if (isSlow(c.ws)) continue;
      for (const f of c.queue) {
        const droppedSincePrevious = c.lastSent === null ? 0 : Number(f.seq - c.lastSent - 1n);
        c.lastSent = f.seq;
        send(c.ws, {
          type: 'sample',
          sequence: String(f.seq),
          packageId: Number(f.seq % 4294967296n),
          source: 'UNSPECIFIED',
          recvTimestamp: new Date().toISOString(),
          sourceGap: false,
          droppedSincePrevious,
          inputs: { brake: f.brake, throttle: f.throttle, steering: null },
        });
      }
      c.queue = [];
    }
  }, 1000 / hz);

  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(port, host, resolve);
  });
  http.on('clientError', (_e, socket) => socket.destroy()); // malformed HTTP must not crash the mock
  const actualPort = http.address().port;
  return {
    port: actualPort,
    sessionId,
    url: `ws://${host.includes(':') ? `[${host}]` : host}:${actualPort}/v1/stream`,
    clientCount: () => clients.size,
    /** Number of data messages clients sent (each one closes that client with 1008). */
    received: () => received,
    /** Stop/resume producing frames (simulates GT7 paused / no packets -> source_stale after sourceTimeoutMs). */
    setPaused: (p) => void (paused = p),
    /** Like the collector on SIGTERM: close every client with 1001 collector_shutdown. */
    close: () =>
      new Promise((resolve) => {
        clearInterval(tick);
        for (const ws of wss.clients) ws.close(1001, 'collector_shutdown');
        setTimeout(() => {
          for (const ws of wss.clients) ws.terminate();
          wss.close();
          http.close(() => resolve());
        }, 50);
      }),
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8765' },
      origin: { type: 'string', multiple: true },
      hz: { type: 'string', default: '60' },
      'max-clients': { type: 'string', default: '4' },
      'source-timeout-ms': { type: 'string', default: '2000' },
    },
  });
  const token = process.env.GT7_WS_TOKEN || undefined; // env only, like the collector
  const s = await startMockCollector({
    host: values.host,
    port: Number(values.port),
    origins: values.origin ?? DEFAULT_ORIGINS,
    token,
    hz: Number(values.hz),
    maxClients: Number(values['max-clients']),
    sourceTimeoutMs: Number(values['source-timeout-ms']),
    log: (m) => console.error(`[mock-collector] ${m}`),
  });
  console.error(`[mock-collector] MOCK gt7.inputs.v1 on ${s.url} origins=${(values.origin ?? DEFAULT_ORIGINS).join(',')} token=${token ? 'required' : 'none'}`);
  const stop = () => s.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
