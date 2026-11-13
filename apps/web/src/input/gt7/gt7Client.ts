// Browser WebSocket client for the DRAFT GT7 collector protocol v1 (docs/input-protocol.md).
// Phase 1 prototype, exercised only against the MOCK collector so far.
import type { InputFrame } from '../types';
import { CLIENT_MAX_MESSAGE_BYTES, ProtocolError, SeqTracker, exceedsBytes, buildHello, checkUrl, closeToError, lnaPermissionFor, mapFrame, parseServerMessage, parseWelcome, type ClientError, type Welcome } from './protocol';

export type Gt7Status = 'connecting' | 'live' | 'stale' | 'reconnecting' | 'closed' | 'error';
export type Gt7Counters = { frames: number; gaps: number; missing: number; duplicates: number; outOfOrder: number; reconnects: number };
export type Gt7Event =
  | { type: 'epoch'; epoch: number }
  | { type: 'status'; status: Gt7Status; epoch: number }
  | { type: 'welcome'; welcome: Welcome; epoch: number }
  | { type: 'frame'; frame: InputFrame; epoch: number }
  | { type: 'gap'; fromSeq: number; toSeq: number; reason: string; epoch: number }
  | { type: 'source-lost'; reason: 'heartbeat-timeout'; epoch: number }
  | ({ type: 'error'; epoch: number } & ClientError);

/** Minimal browser-WebSocket surface (also satisfied by the `ws` package client in tests). */
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type Gt7ClientOptions = {
  url: string;
  /** Sent only inside the first (hello) message; never in the URL, never persisted. */
  pairingToken?: string;
  onEvent: (e: Gt7Event) => void;
  createSocket?: (url: string) => SocketLike;
  pageProtocol?: string;
  now?: () => number;
  reconnect?: { baseMs: number; maxMs: number };
  handshakeTimeoutMs?: number;
  /** Stale after heartbeatMs * staleFactor without any message. */
  staleFactor?: number;
};

export type Gt7Client = { close(): void; counters(): Gt7Counters };

export function createGt7Client(o: Gt7ClientOptions): Gt7Client {
  const now = o.now ?? (() => performance.now());
  const createSocket = o.createSocket ?? ((u: string) => new WebSocket(u) as unknown as SocketLike);
  const { baseMs, maxMs } = o.reconnect ?? { baseMs: 500, maxMs: 10_000 };
  const counters: Gt7Counters = { frames: 0, gaps: 0, missing: 0, duplicates: 0, outOfOrder: 0, reconnects: 0 };
  let epoch = 0;
  let attempt = 0;
  let stopped = false;
  let sock: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined; // handshake / heartbeat watchdog / reconnect delay

  const emit = (e: Gt7Event) => o.onEvent(e);
  const status = (s: Gt7Status) => emit({ type: 'status', status: s, epoch });

  const pre = checkUrl(o.url, o.pageProtocol ?? globalThis.location?.protocol ?? 'http:');
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
    const tracker = new SeqTracker(); // per epoch: never merge sequence state across connections
    let welcome: Welcome | null = null;
    let wasOpen = false;
    let serverError = '';
    let pendingGap = 0; // frames the server said it dropped, not yet attributed to an emitted frame
    const watchdog = (ms: number, onFire: () => void) => {
      clearTimeout(timer);
      timer = setTimeout(onFire, ms);
    };
    let s: SocketLike;
    try {
      s = createSocket(o.url);
    } catch (e) {
      return drop({ code: 'unreachable', message: String(e), fatal: false });
    }
    sock = s;
    watchdog(o.handshakeTimeoutMs ?? 5000, () => drop({ code: 'handshake-timeout', message: 'Collector did not complete the handshake in time.', fatal: false }));

    s.onopen = () => {
      wasOpen = true;
      s.send(buildHello(o.pairingToken));
    };
    s.onclose = (ev) => {
      const err = closeToError(ev.code, ev.reason, wasOpen);
      drop(serverError ? { ...err, message: `${err.message} Server said: ${serverError}` } : err);
    };
    s.onmessage = (ev) => {
      try {
        if (typeof ev.data !== 'string') throw new ProtocolError('protocol', 'binary messages are not supported');
        const cap = Math.min(CLIENT_MAX_MESSAGE_BYTES, welcome?.maxFrameBytes ?? Infinity);
        if (exceedsBytes(ev.data, cap)) throw new ProtocolError('protocol', `message exceeds ${cap} bytes`);
        const m = parseServerMessage(ev.data);
        if (m.type === 'error') {
          serverError = `${m.code}${m.message ? ` (${m.message})` : ''}`;
          return;
        }
        if (m.type === 'welcome') {
          welcome = parseWelcome(m);
          attempt = 0;
          emit({ type: 'welcome', welcome, epoch });
          status('live');
        } else if (!welcome) {
          throw new ProtocolError('protocol', `${m.type} before welcome`);
        } else if (m.type === 'gap') {
          pendingGap += Math.max(0, m.toSeq - m.fromSeq + 1);
          emit({ type: 'gap', fromSeq: m.fromSeq, toSeq: m.toSeq, reason: m.reason, epoch });
        } else if (m.type === 'frames') {
          for (const wf of m.frames) {
            const r = tracker.observe(wf.seq);
            if (r.kind === 'duplicate') counters.duplicates++;
            else if (r.kind === 'out-of-order') counters.outOfOrder++;
            if (r.kind === 'duplicate' || r.kind === 'out-of-order') continue; // never replay old samples
            // seq jump and an explicit gap message may describe the same hole: count it once
            const missing = Math.max(r.kind === 'gap' ? r.missing : 0, pendingGap);
            pendingGap = 0;
            if (missing > 0) {
              counters.gaps++;
              counters.missing += missing;
            }
            counters.frames++;
            emit({ type: 'frame', frame: mapFrame(wf, welcome, now(), missing > 0), epoch });
          }
        }
        const hb = welcome.heartbeatMs * (o.staleFactor ?? 3);
        watchdog(hb, () => {
          status('stale');
          emit({ type: 'source-lost', reason: 'heartbeat-timeout', epoch });
          drop(null);
        });
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

export type LnaState = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'not-needed';

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
