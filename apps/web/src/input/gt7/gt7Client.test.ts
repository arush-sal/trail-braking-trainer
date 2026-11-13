import { describe, expect, it } from 'vitest';
import { createGt7Client, type Gt7Event, type SocketLike } from './gt7Client';

function fake() {
  const sent: string[] = [];
  const s: SocketLike & { sent: string[]; urls: string[]; closed: boolean } = {
    sent,
    urls: [],
    closed: false,
    send: (d) => void sent.push(d),
    close() {
      this.closed = true;
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  return s;
}

function setup() {
  const s = fake();
  let sockets = 0;
  const ev: Gt7Event[] = [];
  const c = createGt7Client({
    url: 'ws://127.0.0.1:8787/v1/inputs',
    pairingToken: 'tok',
    pageProtocol: 'http:',
    createSocket: (u) => (sockets++, s.urls.push(u), s),
    onEvent: (e) => ev.push(e),
  });
  s.onopen!({});
  return { s, ev, c, sockets: () => sockets };
}

const welcome = (version: number) => JSON.stringify({ type: 'welcome', version, collectorVersion: 'x', sourceId: 'gt7-x', capabilities: { brake: { available: true, rawUnit: 'percent' }, throttle: { available: true, rawUnit: 'percent' }, steering: { available: false, reason: 'r' } }, heartbeatMs: 1000, maxFrameBytes: 4096 });

describe('createGt7Client (fake socket)', () => {
  it('sends hello with token in the body only, not the URL', () => {
    const { s, c } = setup();
    expect(s.urls[0]).not.toMatch(/tok/);
    expect(JSON.parse(s.sent[0])).toMatchObject({ type: 'hello', pairingToken: 'tok' });
    c.close();
  });

  it('rejects an unsupported server version fatally without reconnecting', () => {
    const { s, ev, c, sockets } = setup();
    s.onmessage!({ data: welcome(2) });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'version-mismatch', fatal: true });
    expect(ev.at(-1)).toMatchObject({ type: 'status', status: 'error' });
    expect(s.closed).toBe(true);
    expect(sockets()).toBe(1);
    c.close();
  });

  it('treats frames before welcome as a protocol error', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: '{"type":"frames","frames":[]}' });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'protocol', fatal: true });
    c.close();
  });

  it('drops duplicates and out-of-order frames and counts them', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: welcome(1) });
    const fr = (seqs: number[]) => JSON.stringify({ type: 'frames', frames: seqs.map((seq) => ({ seq, ts: seq, brake: 10, throttle: 0 })) });
    s.onmessage!({ data: fr([1, 2, 2, 1, 5]) });
    expect(ev.filter((e) => e.type === 'frame').map((e) => e.type === 'frame' && e.frame.sequence)).toEqual([1, 2, 5]);
    expect(c.counters()).toMatchObject({ frames: 3, duplicates: 1, outOfOrder: 1, gaps: 1, missing: 2 });
    c.close();
  });
});

describe('createGt7Client hardening', () => {
  const fr = (seqs: number[]) => JSON.stringify({ type: 'frames', frames: seqs.map((seq) => ({ seq, ts: seq, brake: 10, throttle: 0 })) });

  it('explicit gap message marks the next frame gap and counts the range once', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: welcome(1) });
    s.onmessage!({ data: '{"type":"gap","fromSeq":1,"toSeq":9,"reason":"slow-consumer"}' });
    s.onmessage!({ data: fr([10, 11]) });
    const fs = ev.flatMap((e) => (e.type === 'frame' ? [e.frame] : []));
    expect(fs.map((f) => f.quality.gap)).toEqual([true, false]);
    expect(c.counters()).toMatchObject({ gaps: 1, missing: 9 });
    // seq-detected jump covering the same range is not double counted
    s.onmessage!({ data: '{"type":"gap","fromSeq":12,"toSeq":14,"reason":"slow-consumer"}' });
    s.onmessage!({ data: fr([15]) });
    expect(c.counters()).toMatchObject({ gaps: 2, missing: 12 });
    c.close();
  });

  it('rejects a message over min(client cap, welcome.maxFrameBytes) before parsing', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: welcome(1) }); // maxFrameBytes 4096
    s.onmessage!({ data: JSON.stringify({ type: 'heartbeat', seq: 1, pad: 'x'.repeat(5000) }) });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'protocol', fatal: true });
    expect(s.closed).toBe(true);
    c.close();
  });

  it('rejects a pre-welcome message over the client default cap', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: 'x'.repeat(70 * 1024) });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'protocol', fatal: true });
    c.close();
  });

  it('rejects an over-long frames batch', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: welcome(1).replace('4096', '1000000') });
    s.onmessage!({ data: JSON.stringify({ type: 'frames', frames: Array.from({ length: 129 }, (_, i) => ({ seq: i + 1, ts: 0, brake: 0, throttle: 0 })) }) });
    expect(ev.find((e) => e.type === 'error')).toMatchObject({ code: 'protocol', fatal: true });
    expect(ev.some((e) => e.type === 'frame')).toBe(false);
    c.close();
  });

  it('heartbeats never produce frames', () => {
    const { s, ev, c } = setup();
    s.onmessage!({ data: welcome(1) });
    s.onmessage!({ data: '{"type":"heartbeat","seq":5}' });
    expect(ev.some((e) => e.type === 'frame')).toBe(false);
    expect(c.counters().frames).toBe(0);
    c.close();
  });
});
