// Pure parsing/mapping for the DRAFT collector wire protocol v1 (docs/input-protocol.md).
import type { InputFrame, Measurement } from '../types';

export const SUPPORTED_VERSIONS = [1] as const;
/** Client-side hard caps (DoS guard), applied before/while parsing. */
export const CLIENT_MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_BATCH = 128;

/** UTF-8 size check without encoding in the common (ASCII-sized) case. */
export const exceedsBytes = (s: string, cap: number) => s.length > cap || (s.length * 3 > cap && new TextEncoder().encode(s).length > cap);

export type Gt7ErrorCode =
  | 'bad-url'
  | 'mixed-content'
  | 'unreachable'
  | 'connection-lost'
  | 'policy'
  | 'version-mismatch'
  | 'too-big'
  | 'server-full'
  | 'protocol'
  | 'handshake-timeout'
  | 'server-error';

export class ProtocolError extends Error {
  constructor(
    readonly code: Gt7ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ChannelCap = { available: boolean; rawUnit: string; reason?: string };
export type Welcome = {
  version: 1;
  collectorVersion: string;
  sourceId: string;
  capabilities: { brake: ChannelCap; steering: ChannelCap; throttle: ChannelCap };
  heartbeatMs: number;
  maxFrameBytes: number;
};
export type WireFrame = { seq: number; ts: number; brake: number | null; throttle: number | null };
export type ServerMessage =
  | ({ type: 'welcome' } & Record<string, unknown>)
  | { type: 'frames'; frames: WireFrame[] }
  | { type: 'gap'; fromSeq: number; toSeq: number; reason: string }
  | { type: 'heartbeat'; seq: number }
  | { type: 'error'; code: string; message: string };

const STEERING_UNVERIFIED = 'GT7 driver steering input is not verified in the collector; steering is unavailable (vehicle wheel angles are not steering input).';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (msg: string): never => {
  throw new ProtocolError('protocol', msg);
};
const num = (o: Obj, k: string, int = false): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || (int && !Number.isInteger(v))) fail(`${k}: expected ${int ? 'integer' : 'finite number'}`);
  return v as number;
};
const str = (o: Obj, k: string): string => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : fail(`${k}: expected non-empty string`));
const nullableNum = (o: Obj, k: string): number | null => (o[k] === null ? null : k in o ? num(o, k) : fail(`${k}: required (null when unavailable)`));

export function buildHello(pairingToken?: string): string {
  return JSON.stringify({ type: 'hello', protocol: 'tbt-inputs', versions: SUPPORTED_VERSIONS, ...(pairingToken ? { pairingToken } : {}) });
}

export function parseServerMessage(data: string): ServerMessage {
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return fail('message is not JSON');
  }
  if (!isObj(m)) return fail('message is not an object');
  switch (m.type) {
    case 'welcome':
      return m as ServerMessage;
    case 'frames':
      if (!Array.isArray(m.frames)) return fail('frames: expected array');
      if (m.frames.length > MAX_BATCH) return fail(`frames: batch of ${m.frames.length} exceeds ${MAX_BATCH}`);
      return {
        type: 'frames',
        frames: m.frames.map((f) => (isObj(f) ? { seq: num(f, 'seq', true), ts: num(f, 'ts'), brake: nullableNum(f, 'brake'), throttle: nullableNum(f, 'throttle') } : fail('frame: expected object'))),
      };
    case 'gap':
      return { type: 'gap', fromSeq: num(m, 'fromSeq', true), toSeq: num(m, 'toSeq', true), reason: str(m, 'reason') };
    case 'heartbeat':
      return { type: 'heartbeat', seq: num(m, 'seq', true) };
    case 'error':
      return { type: 'error', code: str(m, 'code'), message: typeof m.message === 'string' ? m.message : '' };
    default:
      return fail(`unknown message type ${JSON.stringify(m.type)}`);
  }
}

function cap(o: unknown, name: string): ChannelCap {
  if (!isObj(o) || typeof o.available !== 'boolean') return fail(`capabilities.${name}: expected {available}`);
  return { available: o.available, rawUnit: typeof o.rawUnit === 'string' ? o.rawUnit : 'unknown', ...(typeof o.reason === 'string' ? { reason: o.reason } : {}) };
}

export function parseWelcome(m: Obj): Welcome {
  if (!(SUPPORTED_VERSIONS as readonly unknown[]).includes(m.version))
    throw new ProtocolError('version-mismatch', `Collector speaks protocol version ${String(m.version)}; this trainer supports ${SUPPORTED_VERSIONS.join(', ')}. Update the trainer or collector.`);
  if (!isObj(m.capabilities)) return fail('capabilities: expected object');
  const heartbeatMs = num(m, 'heartbeatMs');
  if (heartbeatMs <= 0) fail('heartbeatMs: must be > 0');
  const c = m.capabilities;
  return {
    version: 1,
    collectorVersion: str(m, 'collectorVersion'),
    sourceId: str(m, 'sourceId'),
    heartbeatMs,
    maxFrameBytes: num(m, 'maxFrameBytes', true),
    capabilities: {
      brake: cap(c.brake, 'brake'),
      throttle: cap(c.throttle, 'throttle'),
      // Spec 4.3 steering gate: never trust a collector claim until a real steering-input signal is validated.
      steering: { available: false, rawUnit: 'unavailable', reason: isObj(c.steering) && typeof c.steering.reason === 'string' && c.steering.available === false ? c.steering.reason : STEERING_UNVERIFIED },
    },
  };
}

const pct = (c: ChannelCap, raw: number | null): Measurement =>
  !c.available || raw === null
    ? { available: c.available, rawValue: null, rawUnit: c.rawUnit, normalized: null }
    : { available: true, rawValue: raw, rawUnit: c.rawUnit, normalized: Math.min(1, Math.max(0, raw / 100)) };

export function mapFrame(f: WireFrame, w: Welcome, receivedMonoMs: number, gap: boolean): InputFrame {
  return {
    schemaVersion: 1,
    source: 'gt7',
    sourceId: w.sourceId,
    sequence: f.seq,
    sourceTimestampMs: f.ts,
    receivedMonoMs,
    brake: pct(w.capabilities.brake, f.brake),
    steering: { available: false, rawValue: null, rawUnit: 'unavailable', normalized: null },
    throttle: pct(w.capabilities.throttle, f.throttle),
    quality: { gap, stale: false, calibrated: false },
  };
}

/** All channels unavailable + stale: tells consumers to stop treating the last sample as live. */
export function unavailableFrame(sourceId: string, receivedMonoMs: number): InputFrame {
  const none: Measurement = { available: false, rawValue: null, rawUnit: 'unavailable', normalized: null };
  return { schemaVersion: 1, source: 'gt7', sourceId, receivedMonoMs, brake: none, steering: none, throttle: none, quality: { gap: false, stale: true, calibrated: false } };
}

export type SeqResult = { kind: 'ok' } | { kind: 'gap'; missing: number } | { kind: 'duplicate' } | { kind: 'out-of-order' };

/** Per-connection-epoch sequence checker. Create a new one per epoch; never reuse across reconnects. */
export class SeqTracker {
  private last: number | null = null;
  observe(seq: number): SeqResult {
    const last = this.last;
    if (last !== null && seq === last) return { kind: 'duplicate' };
    if (last !== null && seq < last) return { kind: 'out-of-order' };
    this.last = seq;
    return last === null || seq === last + 1 ? { kind: 'ok' } : { kind: 'gap', missing: seq - last - 1 };
  }
}

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
const PRIVATE_HOST = /^(.+\.local|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[f[cd][0-9a-f]*:.*\]|\[fe[89ab][0-9a-f]*:.*\])$/i;
const isLocalHost = (h: string) => LOOPBACK_HOST.test(h) || PRIVATE_HOST.test(h);

/** Chrome Local Network Access permission a WebSocket to this URL needs (never the legacy 'local-network-access' name). */
export function lnaPermissionFor(url: string): 'loopback-network' | 'local-network' | null {
  let h: string;
  try {
    h = new URL(url).hostname;
  } catch {
    return null;
  }
  return LOOPBACK_HOST.test(h) ? 'loopback-network' : PRIVATE_HOST.test(h) ? 'local-network' : null;
}

// Public-info only (WebKit bugs 171934, 173161, 279249; docs/research/public-evidence.md s6) - UNVERIFIED locally.
const isSafari = (ua: string) => /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua);

/** Non-blocking, browser-specific warnings to show before connecting. */
export function browserWarnings(url: string, pageProtocol: string, ua: string): string[] {
  return pageProtocol === 'https:' && url.startsWith('ws:') && isSafari(ua)
    ? ['Safari likely blocks ws:// from an HTTPS page, even to 127.0.0.1 (unverified). If it fails, use wss:// with a locally trusted certificate, or open the trainer from http://localhost.']
    : [];
}

export type ClientError = { code: Gt7ErrorCode; message: string; fatal: boolean };

/** Pre-connect URL check. Returns null when OK. pageProtocol is location.protocol. */
export function checkUrl(url: string, pageProtocol: string): ClientError | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { code: 'bad-url', message: 'Not a valid URL.', fatal: true };
  }
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:') return { code: 'bad-url', message: 'URL must start with ws:// or wss://.', fatal: true };
  if (u.username || u.password || /token|secret|key|pass/i.test(u.search))
    return { code: 'bad-url', message: 'Do not put credentials in the URL; use the pairing token field (sent inside the hello message).', fatal: true };
  if (pageProtocol === 'https:' && u.protocol === 'ws:' && !isLocalHost(u.hostname))
    return {
      code: 'mixed-content',
      message: `This HTTPS page cannot open insecure ws:// to the public host ${u.hostname} (mixed content). Use a loopback/private IP or .local name (browser local-network permission may be required), or wss://.`,
      fatal: true,
    };
  return null;
}

/** Map a WebSocket close into an actionable error. wasOpen: the socket reached 'open'. */
export function closeToError(code: number, reason: string, wasOpen: boolean): ClientError {
  switch (code) {
    case 1008:
      return { code: 'policy', message: `Collector refused the connection (${reason || 'policy violation'}). Check the pairing token and that this page's origin is in the collector allowlist.`, fatal: true };
    case 4000:
      return { code: 'version-mismatch', message: `Collector does not support this trainer's protocol version (${reason || 'unsupported-version'}).`, fatal: true };
    case 1009:
      return { code: 'too-big', message: 'Collector closed: message too large.', fatal: true };
    case 1013:
      return { code: 'server-full', message: 'Collector is at its connection limit; will retry.', fatal: false };
    case 1002:
      return { code: 'protocol', message: `Protocol error (${reason || 'unknown'}).`, fatal: true };
  }
  return wasOpen
    ? { code: 'connection-lost', message: `Connection to collector lost (code ${code}${reason ? `: ${reason}` : ''}).`, fatal: false }
    : {
        code: 'unreachable',
        message: 'Could not connect. The collector may not be running/reachable, may have rejected this page\'s Origin (browsers cannot distinguish), or the browser blocked local-network access.',
        fatal: false,
      };
}
