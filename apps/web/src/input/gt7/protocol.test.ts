import { describe, expect, it } from 'vitest';
import {
  DEFAULT_URL,
  PROTOCOL,
  ProtocolError,
  browserWarnings,
  checkToken,
  checkUrl,
  closeToError,
  lnaPermissionFor,
  mapSample,
  parseServerMessage,
  rejectionHint,
  subprotocols,
  type Sample,
} from './protocol';

// Verbatim gt7.inputs.v1 snapshot from gt7-telemetry-collector v0.3.0 (testdata/README.md).
const raw = (g: Record<string, string>) => Object.entries(g).map(([p, s]) => [p.split('/').pop()!, s] as const);
const valid = raw(import.meta.glob('./testdata/v1/valid/*.json', { eager: true, query: '?raw', import: 'default' }));
const invalid = raw(import.meta.glob('./testdata/v1/invalid/*.json', { eager: true, query: '?raw', import: 'default' }));

const SID = '4f9c2e7a1b3d5f60718293a4b5c6d7e8';
const fixture = (name: string) => valid.find(([n]) => n === name)![1];

describe('contract fixtures (gt7-telemetry-collector v0.3.0)', () => {
  it('snapshot is complete: 14 valid, 12 invalid', () => {
    expect(valid).toHaveLength(14);
    expect(invalid).toHaveLength(12);
  });

  it.each(valid)('accepts valid/%s', (name, s) => {
    const m = parseServerMessage(s);
    expect(m.type).toBe(name.split('.')[0]);
  });

  // ADR 0002 rule 6 (collector repo): consumers ignore unknown types and apply the contract rules
  // instead of hard-failing on full schema validation. Everything else invalid is rejected.
  const lenient: Record<string, (m: ReturnType<typeof parseServerMessage>) => void> = {
    'unknown.type.json': (m) => expect(m).toEqual({ type: 'ignored', rawType: 'telemetry_dump' }),
    // A hello claiming steering is accepted, but steering is forced unavailable (spec 4.3).
    'hello.steering-available.json': (m) => expect(m.type === 'hello' && m.capabilities.steering.available).toBe(false),
    // inputs.steering is ignored (collector owner, 2026-11-14): never mapped, the sample is still accepted.
    'sample.steering-zero.json': (m) => {
      expect(m.type).toBe('sample');
      expect(mapSample(m as Sample, 0).steering).toEqual({ available: false, rawValue: null, rawUnit: 'unavailable', normalized: null });
    },
  };
  it.each(invalid)('rejects invalid/%s', (name, s) => {
    if (lenient[name]) return lenient[name](parseServerMessage(s));
    expect(() => parseServerMessage(s)).toThrow(ProtocolError);
  });

  it('parses hello fields', () => {
    const m = parseServerMessage(fixture('hello.waiting.json'));
    expect(m).toEqual({
      type: 'hello',
      sessionId: SID,
      collectorVersion: 'v0.0.0-test',
      canonicalSchemaVersion: 1,
      status: 'waiting_for_source',
      capabilities: {
        brake: { available: true, unit: 'percent' },
        throttle: { available: true, unit: 'percent' },
        steering: { available: false, unit: 'unavailable', reason: 'driver_steering_input_unverified' },
      },
    });
  });

  it('parses the sequence as BigInt without precision loss', () => {
    const m = parseServerMessage(fixture('sample.large-sequence.json'));
    expect(m.type === 'sample' && m.sequence).toBe(18446744073709551615n);
    expect(m.type === 'sample' && m.packageId).toBe(4294967295);
  });

  it('parses a sample and ignores unknown fields', () => {
    expect(parseServerMessage(fixture('sample.unknown-field.json'))).toEqual({
      type: 'sample',
      sessionId: SID,
      sequence: 12345n,
      packageId: 10123,
      source: 'LIVE',
      recvTimestamp: '2026-11-14T12:00:00.123456789Z',
      sourceGap: false,
      droppedSincePrevious: 0,
      brake: 42.352943,
      throttle: 0,
    });
  });

  it('keeps unknown status states (forward compatible)', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'status', protocol: PROTOCOL, sessionId: SID, state: 'source_paused', reason: 'x' }))).toMatchObject({ type: 'status', state: 'source_paused' });
  });

  it('rejects non-JSON, non-objects, other protocols, bad hello status', () => {
    expect(() => parseServerMessage('nope')).toThrow(ProtocolError);
    expect(() => parseServerMessage('[]')).toThrow(ProtocolError);
    expect(() => parseServerMessage(JSON.stringify({ type: 'zzz', protocol: 'gt7.inputs.v2' }))).toThrow(/protocol/);
    const h = JSON.parse(fixture('hello.live.json'));
    expect(() => parseServerMessage(JSON.stringify({ ...h, status: 'paused' }))).toThrow(/status/);
    expect(() => parseServerMessage(JSON.stringify({ ...h, capabilities: { ...h.capabilities, brake: { available: true, unit: 'raw', min: 0, max: 255 } } }))).toThrow(/brake/);
    const s = JSON.parse(fixture('sample.brake-throttle.json'));
    expect(() => parseServerMessage(JSON.stringify({ ...s, recvTimestamp: '2026-13-45T99:00:00Z' }))).toThrow(/recvTimestamp/);
    expect(() => parseServerMessage(JSON.stringify({ ...s, sequence: '184467440737095516150' }))).toThrow(/sequence/);
  });
});

describe('mapSample', () => {
  const sample = (o: Partial<Sample> = {}): Sample => ({ sessionId: SID, sequence: 7n, packageId: 1, source: 'LIVE', recvTimestamp: '2026-11-14T12:00:00.5Z', sourceGap: false, droppedSincePrevious: 0, brake: 40, throttle: 0, ...o });
  it('maps percent 0..100 to normalized 0..1, steering always unavailable', () => {
    expect(mapSample(sample(), 99.5)).toEqual({
      schemaVersion: 1,
      source: 'gt7',
      sourceId: `gt7:${SID}`,
      sequence: 7,
      sourceTimestampMs: Date.parse('2026-11-14T12:00:00.5Z'),
      receivedMonoMs: 99.5,
      brake: { available: true, rawValue: 40, rawUnit: 'percent', normalized: 0.4 },
      steering: { available: false, rawValue: null, rawUnit: 'unavailable', normalized: null },
      throttle: { available: true, rawValue: 0, rawUnit: 'percent', normalized: 0 },
      quality: { gap: false, stale: false, calibrated: false },
    });
  });
  it('maps null to an unavailable channel with null values (never zero; core requires values when available)', () => {
    expect(mapSample(sample({ brake: null }), 0).brake).toEqual({ available: false, rawValue: null, rawUnit: 'percent', normalized: null });
    expect(mapSample(sample({ throttle: null, sourceGap: true }), 0)).toMatchObject({ throttle: { available: false, rawValue: null, normalized: null }, quality: { gap: true } });
  });
  it('flags gap on upstream sourceGap or collector drops', () => {
    expect(mapSample(sample({ sourceGap: true }), 0).quality.gap).toBe(true);
    expect(mapSample(sample({ droppedSincePrevious: 3 }), 0).quality.gap).toBe(true);
  });
  it('omits a sequence beyond 2^53 instead of rounding it', () => {
    expect(mapSample(sample({ sequence: 2n ** 64n - 1n }), 0)).not.toHaveProperty('sequence');
  });
});

describe('subprotocols / checkToken', () => {
  it('offers gt7.inputs.v1 and the token only as a subprotocol entry', () => {
    expect(subprotocols()).toEqual(['gt7.inputs.v1']);
    expect(subprotocols('')).toEqual(['gt7.inputs.v1']);
    expect(subprotocols('a'.repeat(32))).toEqual(['gt7.inputs.v1', `gt7.token.${'a'.repeat(32)}`]);
  });
  it('validates collector token syntax (32..256 of [A-Za-z0-9._~-])', () => {
    expect(checkToken('')).toBeNull();
    expect(checkToken('a'.repeat(32))).toBeNull();
    expect(checkToken('0123456789abcdef'.repeat(4))).toBeNull();
    expect(checkToken('short')).toMatch(/32/);
    expect(checkToken('a'.repeat(31) + ' ')).toMatch(/32/);
    expect(checkToken('a'.repeat(257))).toMatch(/256/);
  });
});

describe('checkUrl', () => {
  it('default URL is the collector stream endpoint', () => {
    expect(DEFAULT_URL).toBe('ws://127.0.0.1:8765/v1/stream');
    expect(checkUrl(DEFAULT_URL, 'http:')).toBeNull();
  });
  it('requires ws/wss and refuses credentials in the URL', () => {
    expect(checkUrl('http://127.0.0.1:8765', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('ws://u:p@127.0.0.1:8765/v1/stream', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('ws://127.0.0.1:8765/v1/stream?token=abc', 'http:')?.message).toMatch(/token field/);
    expect(checkUrl('not a url', 'http:')).toMatchObject({ code: 'bad-url' });
  });
  it('flags https page -> ws:// public host as mixed content, allows local/loopback', () => {
    expect(checkUrl('ws://collector.example.com/v1/stream', 'https:')).toMatchObject({ code: 'mixed-content' });
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '192.168.1.20', '10.0.0.2', '172.20.1.1', 'ps-host.local'])
      expect(checkUrl(`ws://${h}:8765/v1/stream`, 'https:')).toBeNull();
    expect(checkUrl('wss://collector.example.com/v1/stream', 'https:')).toBeNull();
  });
});

describe('closeToError', () => {
  it('maps gt7.inputs.v1 close codes', () => {
    expect(closeToError(1001, 'collector_shutdown', true)).toMatchObject({ code: 'shutdown', fatal: false });
    expect(closeToError(1008, 'read_only_stream', true)).toMatchObject({ code: 'read-only', fatal: true });
    expect(closeToError(1009, '', true)).toMatchObject({ code: 'too-big', fatal: true });
    expect(closeToError(4000, 'slow_consumer', true)).toMatchObject({ code: 'slow-consumer', fatal: false });
    expect(closeToError(1006, '', false)).toMatchObject({ code: 'unreachable', fatal: false });
    expect(closeToError(1006, '', true)).toMatchObject({ code: 'connection-lost', fatal: false });
  });
});

describe('rejectionHint (1006 before open)', () => {
  it('denied LNA permission -> re-allow in site settings', () => {
    const h = rejectionHint('denied', 'https://trail-braking-trainer.aru.sh');
    expect(h).toMatch(/site settings/i);
    expect(h).not.toMatch(/--ws-origin/);
  });
  it('prompt is never treated as blocked: same collector-rejection hint as granted', () => {
    const h = rejectionHint('prompt', 'http://localhost:5173');
    expect(h).toBe(rejectionHint('granted', 'http://localhost:5173'));
    expect(h).not.toMatch(/dismissed|blocked local network/i);
  });
  it.each(['granted', 'unsupported', 'not-needed', ''] as const)('%s -> collector rejection with the exact --ws-origin', (s) => {
    const h = rejectionHint(s, 'http://localhost:5173');
    expect(h).toContain('--ws-origin=http://localhost:5173 ');
    for (const cause of [/Origin/, /token/, /too many clients/i, /not running/i]) expect(h).toMatch(cause);
  });
  it('uses the bare origin: no trailing slash or path', () => {
    expect(rejectionHint('granted', 'https://trail-braking-trainer.aru.sh')).toContain('--ws-origin=https://trail-braking-trainer.aru.sh ');
  });
});

describe('lnaPermissionFor', () => {
  it('picks loopback-network / local-network / none by target host', () => {
    expect(lnaPermissionFor('ws://127.0.0.1:8765/v1/stream')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://localhost:8765')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://[::1]:8765')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://192.168.1.20:8765')).toBe('local-network');
    expect(lnaPermissionFor('ws://ps-host.local:8765')).toBe('local-network');
    expect(lnaPermissionFor('wss://collector.example.com')).toBeNull();
    expect(lnaPermissionFor('garbage')).toBeNull();
  });
});

describe('browserWarnings', () => {
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  it('warns Safari users on https -> ws:// even to loopback, pointing at collector TLS', () => {
    expect(browserWarnings('ws://127.0.0.1:8765', 'https:', safari)[0]).toMatch(/Safari.*wss:\/\/.*--ws-tls-cert/);
    expect(browserWarnings('wss://127.0.0.1:8765', 'https:', safari)).toEqual([]);
    expect(browserWarnings('ws://127.0.0.1:8765', 'http:', safari)).toEqual([]);
    expect(browserWarnings('ws://127.0.0.1:8765', 'https:', chrome)).toEqual([]);
  });
});
