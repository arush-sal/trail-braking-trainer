// Browser WebSocket client for the collector-owned contract gt7.inputs.v1 (gt7-telemetry-collector v0.3.0).
// Read-only: the client never sends a message (the collector closes 1008 read_only_stream if it does).
import type { InputFrame } from '../types';
import {
  CLIENT_MAX_MESSAGE_BYTES,
  PROTOCOL,
  ProtocolError,
  checkToken,
  checkUrl,
  closeToError,
  exceedsBytes,
  lnaPermissionFor,
  mapSample,
  parseServerMessage,
  subprotocols,
  type ClientError,
  type Hello,
  type LnaState,
} from './protocol';

export type { LnaState } from './protocol';
/** waiting: connected, collector has no GT7 source yet. stale: collector reports source_stale. */
export type Gt7Status = 'connecting' | 'waiting' | 'live' | 'stale' | 'reconnecting' | 'closed' | 'error';
export type Gt7Counters = { frames: number; gaps: number; missing: number; sourceGaps: number; duplicates: number; outOfOrder: number; reconnects: number };
export type Gt7Event =
  | { type: 'epoch'; epoch: number }
  | { type: 'status'; status: Gt7Status; epoch: number }
  | { type: 'hello'; hello: Hello; epoch: number }
  | { type: 'frame'; frame: InputFrame; epoch: number }
  | { type: 'source-lost'; reason: string; epoch: number }
  | ({ type: 'error'; epoch: number } & ClientError);

/** Minimal browser-WebSocket surface (also satisfied by the `ws` package client in tests). */
export type SocketLike = {
  /** Negotiated subprotocol (Sec-WebSocket-Protocol response). */
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type Gt7ClientOptions = {
  url: string;
  /** Collector GT7_WS_TOKEN. Offered only as the `gt7.token.<token>` subprotocol; never in the URL, never persisted. */
  token?: string;
  onEvent: (e: Gt7Event) => void;
  createSocket?: (url: string, protocols: string[]) => SocketLike;
  pageProtocol?: string;
  now?: () => number;
  reconnect?: { baseMs: number; maxMs: number };
  /** Time from socket creation to hello. */
  handshakeTimeoutMs?: number;
};

export type Gt7Client = { close(): void; counters(): Gt7Counters };

const STATUS_OF = { waiting_for_source: 'waiting', source_live: 'live', source_stale: 'stale' } as const;

export function createGt7Client(o: Gt7ClientOptions): Gt7Client {
  const now = o.now ?? (() => performance.now());
  const createSocket = o.createSocket ?? ((u: string, p: string[]) => new WebSocket(u, p) as unknown as SocketLike);
  const { baseMs, maxMs } = o.reconnect ?? { baseMs: 500, maxMs: 30_000 };
  const counters: Gt7Counters = { frames: 0, gaps: 0, missing: 0, sourceGaps: 0, duplicates: 0, outOfOrder: 0, reconnects: 0 };
  let epoch = 0;
  let attempt = 0;
  let stopped = false;
  let sock: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined; // handshake watchdog / reconnect delay

  // Every string the panel renders can be server-controlled (close reason, hello, status reason): never let the token reach the UI.
  const r = (m: string) => (o.token ? m.replaceAll(o.token, '<token>') : m);
  const redact = (e: Gt7Event): Gt7Event => {
    if (e.type === 'error') return { ...e, message: r(e.message) };
    if (e.type === 'source-lost') return { ...e, reason: r(e.reason) };
    if (e.type !== 'hello') return e;
    const { capabilities: c, collectorVersion } = e.hello;
    return { ...e, hello: { ...e.hello, collectorVersion: r(collectorVersion), capabilities: { ...c, steering: { ...c.steering, reason: r(c.steering.reason ?? '') } } } };
  };
  const emit = (e: Gt7Event) => o.onEvent(redact(e));
  const status = (s: Gt7Status) => emit({ type: 'status', status: s, epoch });

  const tokenErr = checkToken(o.token ?? '');
  const pre = checkUrl(o.url, o.pageProtocol ?? globalThis.location?.protocol ?? 'http:') ?? (tokenErr ? { code: 'bad-token' as const, message: tokenErr, fatal: true } : null);
  if (pre) {
    emit({ type: 'error', epoch, ...pre });
    status('error');
    return { close() {}, counters: () => ({ ...counters }) };
  }

  /** Tear down the current socket and either stop (fatal) or reconnect in a fresh epoch. */
  function drop(err: ClientError | null) {
    clearTimeout(timer);
    if (sock) {
      sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
      try {
        sock.close(1000);
      } catch {
        /* already closed */
      }
      sock = null;
    }
    if (stopped) return;
    if (err) emit({ type: 'error', epoch, ...err });
    if (err?.fatal) {
      stopped = true;
      status('error');
      return;
    }
    status('reconnecting');
    // ponytail: no jitter; add it if many browsers reconnect to one collector at once.
    timer = setTimeout(connect, Math.min(maxMs, baseMs * 2 ** attempt++));
  }

  function connect() {
    if (stopped) return;
    if (++epoch > 1) counters.reconnects++;
    emit({ type: 'epoch', epoch });
    status('connecting');
    // Per epoch: a reconnect yields a new hello (sessionId may change); never stitch across connections.
    let hello: Hello | null = null;
    let lastSeq: bigint | null = null;
    let wasOpen = false;
    let s: SocketLike;
    try {
      s = createSocket(o.url, subprotocols(o.token));
    } catch (e) {
      return drop({ code: 'unreachable', message: String(e), fatal: false });
    }
    sock = s;
    timer = setTimeout(() => drop({ code: 'handshake-timeout', message: 'Collector did not send hello in time.', fatal: false }), o.handshakeTimeoutMs ?? 5000);

    s.onopen = () => {
      wasOpen = true;
      if (s.protocol !== PROTOCOL)
        // Fixed text: a hostile server could select the offered gt7.token.<token> entry.
        drop({ code: 'version-mismatch', message: `Collector did not negotiate ${PROTOCOL}. Is this gt7-collector v0.3.0 or later with --ws-listen?`, fatal: true });
    };
    s.onclose = (ev) => drop(closeToError(ev.code, ev.reason, wasOpen));
    s.onmessage = (ev) => {
      try {
        if (typeof ev.data !== 'string') throw new ProtocolError('protocol', 'binary messages are not supported');
        if (exceedsBytes(ev.data, CLIENT_MAX_MESSAGE_BYTES)) throw new ProtocolError('protocol', `message exceeds ${CLIENT_MAX_MESSAGE_BYTES} bytes`);
        const m = parseServerMessage(ev.data);
        if (m.type === 'ignored') return; // unknown future message type
        if (m.type === 'hello') {
          if (hello) throw new ProtocolError('protocol', 'second hello on one connection');
          clearTimeout(timer);
          hello = m;
          attempt = 0;
          emit({ type: 'hello', hello, epoch });
          status(STATUS_OF[hello.status]);
          return;
        }
        if (!hello) throw new ProtocolError('protocol', `${m.type} before hello`);
        if (m.sessionId !== hello.sessionId) throw new ProtocolError('protocol', `sessionId ${m.sessionId} does not match hello ${hello.sessionId}`);
        if (m.type === 'status') {
          if (m.state === 'source_stale') {
            // Segment break regardless of duration (contract ordering guarantees).
            status('stale');
            emit({ type: 'source-lost', reason: m.reason, epoch });
          } else if (m.state === 'source_live') status('live');
          return; // unknown states are ignored
        }
        if (lastSeq !== null && m.sequence <= lastSeq) {
          if (m.sequence === lastSeq) counters.duplicates++;
          else counters.outOfOrder++;
          return; // never replay old samples
        }
        lastSeq = m.sequence;
        counters.frames++;
        if (m.sourceGap) counters.sourceGaps++;
        if (m.droppedSincePrevious > 0) {
          counters.gaps++;
          counters.missing += m.droppedSincePrevious;
        }
        emit({ type: 'frame', frame: mapSample(m, now()), epoch });
      } catch (e) {
        const pe = e instanceof ProtocolError ? e : new ProtocolError('protocol', String(e));
        drop({ code: pe.code, message: pe.message, fatal: true });
      }
    };
    s.onerror = () => {}; // onclose follows with the code
  }

  connect();
  return {
    close() {
      stopped = true;
      drop(null);
      status('closed');
    },
    counters: () => ({ ...counters }),
  };
}

/** Best-effort Chrome Local Network Access permission check (spec: Chrome 147+ gates local WebSockets). Never throws. */
export async function queryLnaPermission(url: string, permissions: Permissions | undefined = globalThis.navigator?.permissions): Promise<LnaState> {
  const name = lnaPermissionFor(url);
  if (!name) return 'not-needed';
  try {
    const { state } = await permissions!.query({ name } as unknown as PermissionDescriptor);
    return state === 'granted' || state === 'prompt' || state === 'denied' ? state : 'unsupported';
  } catch {
    return 'unsupported';
  }
}
