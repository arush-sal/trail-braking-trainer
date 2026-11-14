// Pure parsing/mapping for the collector-owned contract gt7.inputs.v1 (gt7-telemetry-collector v0.3.0,
// docs/content/docs/browser-streaming.md + ADR 0002 there; our ADR 0011, docs/input-protocol.md).
import type { InputFrame, Measurement } from '../types';

export const PROTOCOL = 'gt7.inputs.v1';
export const DEFAULT_URL = 'ws://127.0.0.1:8765/v1/stream';
/** Client-side hard cap (DoS guard) before parsing; a v1 sample is ~300 bytes. */
export const CLIENT_MAX_MESSAGE_BYTES = 64 * 1024;

/** UTF-8 size check without encoding in the common (ASCII-sized) case. */
export const exceedsBytes = (s: string, cap: number) => s.length > cap || (s.length * 3 > cap && new TextEncoder().encode(s).length > cap);

export type Gt7ErrorCode =
  | 'bad-url'
  | 'bad-token'
  | 'mixed-content'
  | 'unreachable'
  | 'connection-lost'
  | 'shutdown'
  | 'read-only'
  | 'too-big'
  | 'slow-consumer'
  | 'version-mismatch'
  | 'protocol'
  | 'handshake-timeout';

export class ProtocolError extends Error {
  constructor(
    readonly code: Gt7ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type HelloStatus = 'waiting_for_source' | 'source_live' | 'source_stale';
export type ChannelCap = { available: boolean; unit: string; reason?: string };
export type Hello = {
  sessionId: string;
  collectorVersion: string;
  canonicalSchemaVersion: number;
  status: HelloStatus;
  capabilities: { brake: ChannelCap; throttle: ChannelCap; steering: ChannelCap };
};
export type Sample = {
  sessionId: string;
  sequence: bigint;
  packageId: number;
  source: 'LIVE' | 'REPLAY' | 'UNSPECIFIED';
  recvTimestamp: string;
  sourceGap: boolean;
  droppedSincePrevious: number;
  brake: number | null;
  throttle: number | null;
};
export type StatusMsg = { sessionId: string; state: string; reason: string };
export type ServerMessage = ({ type: 'hello' } & Hello) | ({ type: 'sample' } & Sample) | ({ type: 'status' } & StatusMsg) | { type: 'ignored'; rawType: unknown };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fail = (msg: string): never => {
  throw new ProtocolError('protocol', msg);
};
const SESSION = /^[0-9a-f]{32}$/;
const SEQUENCE = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 2n ** 64n - 1n;
const RFC3339_UTC = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/;
const HELLO_STATUS: readonly unknown[] = ['waiting_for_source', 'source_live', 'source_stale'];
const SOURCES: readonly unknown[] = ['LIVE', 'REPLAY', 'UNSPECIFIED'];

const str = (o: Obj, k: string): string => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : fail(`${k}: expected non-empty string`));
const int = (o: Obj, k: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fail(`${k}: expected integer in [${min}, ${max}]`);
};
const pctOrNull = (o: Obj, k: string): number | null => {
  const v = o[k];
  if (v === null) return null;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : fail(`inputs.${k}: expected percent 0..100 or null`);
};
const percentCap = (c: Obj, k: string): ChannelCap => {
  const v = c[k];
  // Our percent -> [0,1] mapping depends on exactly this; anything else is not the contract we implement.
  if (!isObj(v) || v.available !== true || v.unit !== 'percent' || v.min !== 0 || v.max !== 100) return fail(`capabilities.${k}: expected {available:true, unit:"percent", min:0, max:100}`);
  return { available: true, unit: 'percent' };
};

/**
 * Parse one server message. Rejects (ProtocolError) any message whose protocol is not gt7.inputs.v1 and
 * any known message (hello/sample/status) that breaks the contract. Unknown types are ignored and
 * unknown fields dropped (collector ADR 0002 rule 6).
 */
export function parseServerMessage(data: string): ServerMessage {
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return fail('message is not JSON');
  }
  if (!isObj(m)) return fail('message is not an object');
  if (m.protocol !== PROTOCOL) return fail(`protocol: expected ${PROTOCOL}, got ${JSON.stringify(m.protocol)}`);
  if (m.type !== 'hello' && m.type !== 'sample' && m.type !== 'status') return { type: 'ignored', rawType: m.type };
  const sessionId = typeof m.sessionId === 'string' && SESSION.test(m.sessionId) ? m.sessionId : fail('sessionId: expected 32 lowercase hex chars');
  if (m.type === 'status') return { type: 'status', sessionId, state: str(m, 'state'), reason: str(m, 'reason') };
  if (m.type === 'hello') {
    const c = isObj(m.capabilities) ? m.capabilities : fail('capabilities: expected object');
    if (!HELLO_STATUS.includes(m.status)) fail(`status: unknown hello status ${JSON.stringify(m.status)}`);
    const steeringReason = isObj(c.steering) && typeof c.steering.reason === 'string' && c.steering.reason ? c.steering.reason : 'driver_steering_input_unverified';
    return {
      type: 'hello',
      sessionId,
      collectorVersion: str(m, 'collectorVersion'),
      canonicalSchemaVersion: int(m, 'canonicalSchemaVersion', 1),
      status: m.status as HelloStatus,
      capabilities: {
        brake: percentCap(c, 'brake'),
        throttle: percentCap(c, 'throttle'),
        // Spec 4.3 steering gate: never trust a collector claim until a real steering-input signal is validated.
        steering: { available: false, unit: 'unavailable', reason: steeringReason },
      },
    };
  }
  const seq = typeof m.sequence === 'string' && SEQUENCE.test(m.sequence) ? BigInt(m.sequence) : fail('sequence: expected decimal string');
  if (seq > UINT64_MAX) fail('sequence: exceeds uint64');
  const ts = typeof m.recvTimestamp === 'string' && RFC3339_UTC.test(m.recvTimestamp) && !Number.isNaN(Date.parse(m.recvTimestamp)) ? m.recvTimestamp : fail('recvTimestamp: expected RFC 3339 UTC (Z)');
  if (!SOURCES.includes(m.source)) fail('source: expected LIVE | REPLAY | UNSPECIFIED');
  if (typeof m.sourceGap !== 'boolean') fail('sourceGap: expected boolean');
  const inputs = isObj(m.inputs) ? m.inputs : fail('inputs: expected object');
  // inputs.steering is ignored (never mapped): v0.3.0 never advertises steering, and spec 4.3 keeps it unavailable regardless.
  return {
    type: 'sample',
    sessionId,
    sequence: seq,
    packageId: int(m, 'packageId', 0, 4294967295),
    source: m.source as Sample['source'],
    recvTimestamp: ts,
    sourceGap: m.sourceGap as boolean,
    droppedSincePrevious: int(m, 'droppedSincePrevious', 0),
    brake: pctOrNull(inputs, 'brake'),
    throttle: pctOrNull(inputs, 'throttle'),
  };
}

export const sourceIdFor = (sessionId: string) => `gt7:${sessionId}`;
const UNAVAILABLE: Measurement = { available: false, rawValue: null, rawUnit: 'unavailable', normalized: null };
// null = no reading: unavailable for this frame (the core requires values when available), never 0.
const pct = (raw: number | null): Measurement => ({ available: raw !== null, rawValue: raw, rawUnit: 'percent', normalized: raw === null ? null : raw / 100 });

/** sample -> InputFrame. Percent 0..100 -> [0,1]; null -> unavailable channel; steering always unavailable; loss -> quality.gap. */
export function mapSample(s: Sample, receivedMonoMs: number): InputFrame {
  return {
    schemaVersion: 1,
    source: 'gt7',
    sourceId: sourceIdFor(s.sessionId),
    // InputFrame.sequence is informational; omit rather than round a value beyond 2^53.
    ...(s.sequence <= BigInt(Number.MAX_SAFE_INTEGER) ? { sequence: Number(s.sequence) } : {}),
    sourceTimestampMs: Date.parse(s.recvTimestamp),
    receivedMonoMs,
    brake: pct(s.brake),
    steering: UNAVAILABLE,
    throttle: pct(s.throttle),
    quality: { gap: s.sourceGap || s.droppedSincePrevious > 0, stale: false, calibrated: false },
  };
}

/** All channels unavailable + stale: tells consumers to stop treating the last sample as live. */
export function unavailableFrame(sourceId: string, receivedMonoMs: number): InputFrame {
  return { schemaVersion: 1, source: 'gt7', sourceId, receivedMonoMs, brake: UNAVAILABLE, steering: UNAVAILABLE, throttle: UNAVAILABLE, quality: { gap: false, stale: true, calibrated: false } };
}

/** Collector token syntax (collector ADR 0003): 32..256 of [A-Za-z0-9._~-]. Returns an error message or null. */
export function checkToken(token: string): string | null {
  if (!token) return null;
  return /^[A-Za-z0-9._~-]{32,256}$/.test(token) ? null : 'Token must be 32 to 256 characters of A-Z a-z 0-9 . _ ~ - (the collector GT7_WS_TOKEN, e.g. from `openssl rand -hex 32`).';
}

/** WebSocket subprotocols to offer. The token travels only here: never in the URL, never in a message. */
export const subprotocols = (token?: string) => (token ? [PROTOCOL, `gt7.token.${token}`] : [PROTOCOL]);

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

export type LnaState = 'granted' | 'prompt' | 'denied' | 'unsupported' | 'not-needed';

/**
 * A 1006 before open is all the page ever sees for an LNA block, a collector HTTP rejection
 * (403 Origin, 401 token, 503 too many clients, 400 subprotocol, 421 Host) or a collector that is not
 * running. Only an LNA state of 'denied' is treated as a block; anything else gets the collector hint. origin is location.origin.
 */
export function rejectionHint(lna: LnaState | '', origin: string): string {
  if (lna === 'denied')
    return "This browser blocked local network access for this site. Allow local network / device access in the browser's site settings (address-bar site info icon), reload, and connect again.";
  const collector =
    'Likely causes: the collector is not running or not listening here (start it with --ws-listen); ' +
    `this page's Origin is not allowed (start the collector with --ws-origin=${origin} exactly, no trailing slash or path); ` +
    'the token is missing or wrong (must match GT7_WS_TOKEN); too many clients are connected (--ws-max-clients). ' +
    'Browsers hide the reason (code 1006): check the collector log with --log-level=debug or devtools Network.';
  // Only 'denied' means blocked: 'prompt' is also reported where no prompt applies (localhost -> 127.0.0.1 is one address space).
  return `Could not connect. ${collector}`;
}

// Public-info only (WebKit bugs 171934, 173161, 279249; docs/research/public-evidence.md s6) - UNVERIFIED locally.
const isSafari = (ua: string) => /Safari\//.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|Android/.test(ua);

/** Non-blocking, browser-specific warnings to show before connecting. */
export function browserWarnings(url: string, pageProtocol: string, ua: string): string[] {
  return pageProtocol === 'https:' && url.startsWith('ws:') && isSafari(ua)
    ? ['Safari likely blocks ws:// from an HTTPS page, even to 127.0.0.1 (unverified). If it fails, use wss:// (collector --ws-tls-cert/--ws-tls-key with a certificate trusted for 127.0.0.1), or open the trainer from http://localhost.']
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
    return { code: 'bad-url', message: 'Do not put credentials in the URL; use the token field (sent only as a WebSocket subprotocol).', fatal: true };
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
    case 1001:
      return { code: 'shutdown', message: 'Collector shut down or restarted (1001 collector_shutdown); reconnecting.', fatal: false };
    case 1008:
      return { code: 'read-only', message: `Collector closed the read-only stream (1008 ${reason || 'policy'}): this trainer sent data. This is a trainer bug; please report it.`, fatal: true };
    case 1009:
      return { code: 'too-big', message: 'Collector closed: message too large (1009).', fatal: true };
    case 4000:
      return { code: 'slow-consumer', message: 'Collector closed: this tab fell behind its write deadline (4000 slow_consumer); reconnecting.', fatal: false };
  }
  return wasOpen
    ? { code: 'connection-lost', message: `Connection to collector lost (code ${code}${reason ? `: ${reason}` : ''}).`, fatal: false }
    : { code: 'unreachable', message: rejectionHint('', globalThis.location?.origin ?? '<this page origin>'), fatal: false };
}
