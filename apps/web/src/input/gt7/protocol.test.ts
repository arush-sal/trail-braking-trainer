import { describe, expect, it } from 'vitest';
import {
  ProtocolError,
  SeqTracker,
  browserWarnings,
  buildHello,
  checkUrl,
  closeToError,
  lnaPermissionFor,
  mapFrame,
  parseServerMessage,
  parseWelcome,
  type Welcome,
} from './protocol';

const welcomeMsg = {
  type: 'welcome',
  version: 1,
  collectorVersion: 'mock-0.1.0',
  sourceId: 'gt7-mock-0',
  capabilities: {
    brake: { available: true, rawUnit: 'percent' },
    throttle: { available: true, rawUnit: 'percent' },
    steering: { available: false, reason: 'no verified driver steering input' },
  },
  heartbeatMs: 1000,
  maxFrameBytes: 4096,
};
const welcome = parseWelcome(welcomeMsg);

describe('buildHello', () => {
  it('puts the token only in the hello body', () => {
    expect(JSON.parse(buildHello('s3cret'))).toEqual({ type: 'hello', protocol: 'tbt-inputs', versions: [1], pairingToken: 's3cret' });
    expect(JSON.parse(buildHello())).toEqual({ type: 'hello', protocol: 'tbt-inputs', versions: [1] });
    expect(JSON.parse(buildHello(''))).not.toHaveProperty('pairingToken');
  });
});

describe('parseServerMessage', () => {
  it('rejects non-JSON, non-objects and unknown types', () => {
    expect(() => parseServerMessage('nope')).toThrow(ProtocolError);
    expect(() => parseServerMessage('[]')).toThrow(ProtocolError);
    expect(() => parseServerMessage('{"type":"bogus"}')).toThrow(/unknown message type/);
  });
  it('parses frames, gap, heartbeat, error', () => {
    expect(parseServerMessage('{"type":"heartbeat","seq":3}')).toEqual({ type: 'heartbeat', seq: 3 });
    expect(parseServerMessage('{"type":"gap","fromSeq":4,"toSeq":9,"reason":"slow-consumer"}')).toEqual({ type: 'gap', fromSeq: 4, toSeq: 9, reason: 'slow-consumer' });
    expect(parseServerMessage('{"type":"error","code":"unauthorized","message":"bad token"}')).toEqual({ type: 'error', code: 'unauthorized', message: 'bad token' });
    const f = parseServerMessage('{"type":"frames","frames":[{"seq":1,"ts":10,"brake":40,"throttle":0}]}');
    expect(f).toEqual({ type: 'frames', frames: [{ seq: 1, ts: 10, brake: 40, throttle: 0 }] });
  });
  it('validates frame fields: integer seq, finite numbers, nullable channels', () => {
    expect(() => parseServerMessage('{"type":"frames","frames":[{"seq":1.5,"ts":1,"brake":0,"throttle":0}]}')).toThrow(/seq/);
    expect(() => parseServerMessage('{"type":"frames","frames":[{"seq":1,"ts":"x","brake":0,"throttle":0}]}')).toThrow(/ts/);
    expect(() => parseServerMessage('{"type":"frames","frames":[{"seq":1,"ts":1,"throttle":0}]}')).toThrow(/brake/);
    expect(() => parseServerMessage('{"type":"frames","frames":{}}')).toThrow(/frames/);
    const ok = parseServerMessage('{"type":"frames","frames":[{"seq":1,"ts":1,"brake":null,"throttle":null}]}');
    expect(ok).toEqual({ type: 'frames', frames: [{ seq: 1, ts: 1, brake: null, throttle: null }] });
  });
});

describe('parseWelcome', () => {
  it('accepts v1', () => {
    expect(welcome.version).toBe(1);
    expect(welcome.capabilities.steering.available).toBe(false);
    expect(welcome.capabilities.steering.reason).toMatch(/steering/);
  });
  it('rejects an unsupported version with a clear error', () => {
    try {
      parseWelcome({ ...welcomeMsg, version: 2 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolError);
      expect((e as ProtocolError).code).toBe('version-mismatch');
      expect((e as Error).message).toMatch(/version 2.*supports 1/);
    }
  });
  it('rejects missing capabilities / heartbeat', () => {
    expect(() => parseWelcome({ ...welcomeMsg, capabilities: undefined })).toThrow(/capabilities/);
    expect(() => parseWelcome({ ...welcomeMsg, heartbeatMs: 0 })).toThrow(/heartbeatMs/);
    expect(() => parseWelcome({ ...welcomeMsg, sourceId: '' })).toThrow(/sourceId/);
  });
  it('forces steering unavailable even if a collector claims it (not verified)', () => {
    const w = parseWelcome({ ...welcomeMsg, capabilities: { ...welcomeMsg.capabilities, steering: { available: true, rawUnit: 'rad' } } });
    expect(w.capabilities.steering.available).toBe(false);
  });
});

describe('mapFrame', () => {
  it('maps percent brake/throttle to InputFrame with steering unavailable', () => {
    const f = mapFrame({ seq: 7, ts: 1234, brake: 40, throttle: 0 }, welcome, 99.5, true);
    expect(f).toEqual({
      schemaVersion: 1,
      source: 'gt7',
      sourceId: 'gt7-mock-0',
      sequence: 7,
      sourceTimestampMs: 1234,
      receivedMonoMs: 99.5,
      brake: { available: true, rawValue: 40, rawUnit: 'percent', normalized: 0.4 },
      steering: { available: false, rawValue: null, rawUnit: 'unavailable', normalized: null },
      throttle: { available: true, rawValue: 0, rawUnit: 'percent', normalized: 0 },
      quality: { gap: true, stale: false, calibrated: false },
    });
  });
  it('keeps null as null (never zero) and marks unavailable channels', () => {
    const f = mapFrame({ seq: 1, ts: 0, brake: null, throttle: 50 }, welcome, 0, false);
    expect(f.brake).toEqual({ available: true, rawValue: null, rawUnit: 'percent', normalized: null });
    const noThrottle: Welcome = { ...welcome, capabilities: { ...welcome.capabilities, throttle: { available: false, rawUnit: 'percent', reason: 'x' } } };
    expect(mapFrame({ seq: 1, ts: 0, brake: 1, throttle: 50 }, noThrottle, 0, false).throttle).toEqual({ available: false, rawValue: null, rawUnit: 'percent', normalized: null });
  });
  it('clamps only out-of-range normalized, preserving raw', () => {
    expect(mapFrame({ seq: 1, ts: 0, brake: 104, throttle: 0 }, welcome, 0, false).brake).toEqual({ available: true, rawValue: 104, rawUnit: 'percent', normalized: 1 });
  });
});

describe('SeqTracker', () => {
  it('classifies first/ok/gap/duplicate/out-of-order', () => {
    const t = new SeqTracker();
    expect(t.observe(5)).toEqual({ kind: 'ok' });
    expect(t.observe(6)).toEqual({ kind: 'ok' });
    expect(t.observe(9)).toEqual({ kind: 'gap', missing: 2 });
    expect(t.observe(9)).toEqual({ kind: 'duplicate' });
    expect(t.observe(7)).toEqual({ kind: 'out-of-order' });
    expect(t.observe(10)).toEqual({ kind: 'ok' });
  });
});

describe('checkUrl', () => {
  it('requires ws/wss and refuses credentials in the URL', () => {
    expect(checkUrl('http://127.0.0.1:8787', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('ws://u:p@127.0.0.1:8787/v1/inputs', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('ws://127.0.0.1:8787/v1/inputs?token=abc', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('not a url', 'http:')).toMatchObject({ code: 'bad-url' });
    expect(checkUrl('ws://127.0.0.1:8787/v1/inputs', 'http:')).toBeNull();
  });
  it('flags https page -> ws:// public host as mixed content, allows local/loopback', () => {
    expect(checkUrl('ws://collector.example.com/v1/inputs', 'https:')).toMatchObject({ code: 'mixed-content' });
    expect(checkUrl('ws://8.8.8.8/v1/inputs', 'https:')).toMatchObject({ code: 'mixed-content' });
    for (const h of ['127.0.0.1', 'localhost', '[::1]', '192.168.1.20', '10.0.0.2', '172.20.1.1', 'ps-host.local'])
      expect(checkUrl(`ws://${h}:8787/v1/inputs`, 'https:')).toBeNull();
    expect(checkUrl('wss://collector.example.com/v1/inputs', 'https:')).toBeNull();
  });
});

describe('closeToError', () => {
  it('maps close codes to actionable errors', () => {
    expect(closeToError(1008, 'unauthorized', true)).toMatchObject({ code: 'policy', fatal: true });
    expect(closeToError(4000, 'unsupported-version', true)).toMatchObject({ code: 'version-mismatch', fatal: true });
    expect(closeToError(1009, '', true)).toMatchObject({ code: 'too-big', fatal: true });
    expect(closeToError(1013, '', true)).toMatchObject({ code: 'server-full', fatal: false });
    const u = closeToError(1006, '', false);
    expect(u).toMatchObject({ code: 'unreachable', fatal: false });
    expect(u.message).toMatch(/origin/i);
    expect(closeToError(1006, '', true)).toMatchObject({ code: 'connection-lost', fatal: false });
  });
});

describe('lnaPermissionFor', () => {
  it('picks loopback-network / local-network / none by target host', () => {
    expect(lnaPermissionFor('ws://127.0.0.1:8787/v1/inputs')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://localhost:8787')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://[::1]:8787')).toBe('loopback-network');
    expect(lnaPermissionFor('ws://192.168.1.20:8787')).toBe('local-network');
    expect(lnaPermissionFor('ws://ps-host.local:8787')).toBe('local-network');
    expect(lnaPermissionFor('wss://collector.example.com')).toBeNull();
    expect(lnaPermissionFor('garbage')).toBeNull();
  });
});

describe('browserWarnings', () => {
  const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  const chrome = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
  it('warns Safari users on https -> ws:// even to loopback', () => {
    expect(browserWarnings('ws://127.0.0.1:8787', 'https:', safari)[0]).toMatch(/Safari.*wss:\/\//);
    expect(browserWarnings('wss://127.0.0.1:8787', 'https:', safari)).toEqual([]);
    expect(browserWarnings('ws://127.0.0.1:8787', 'http:', safari)).toEqual([]);
    expect(browserWarnings('ws://127.0.0.1:8787', 'https:', chrome)).toEqual([]);
  });
});
