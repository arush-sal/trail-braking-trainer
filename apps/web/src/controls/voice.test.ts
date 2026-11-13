import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createVoice, detectVoice, parseCommand, type RecognitionLike } from './voice';
import { createAnnouncer, type UtteranceLike } from '../audio/speech/announcer';

class FakeRec implements RecognitionLike {
  static instances: FakeRec[] = [];
  continuous = false; interimResults = true; lang = ''; maxAlternatives = 0; declare processLocally?: boolean;
  onstart: (() => void) | null = null; onend: (() => void) | null = null;
  onerror: ((e: { error: string }) => void) | null = null; onresult: ((e: never) => void) | null = null;
  starts = 0; aborts = 0; stops = 0;
  constructor() { FakeRec.instances.push(this); }
  start() { this.starts++; this.onstart?.(); }
  stop() { this.stops++; this.onend?.(); }
  abort() { this.aborts++; this.onend?.(); }
  static availability = 'available';
  static available = vi.fn(async () => FakeRec.availability);
  static install = vi.fn(async () => { FakeRec.availability = 'available'; return true; });
  say(transcript: string, confidence = 0.9, isFinal = true) {
    const alt = { transcript, confidence };
    const res = Object.assign([alt], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [res] } as never);
  }
}
const rec = () => FakeRec.instances[FakeRec.instances.length - 1]!;

let t = 0;
function setup(over: Record<string, unknown> = {}) {
  const dispatch = vi.fn<(c: string, s: string) => { ok: true }>(() => ({ ok: true }));
  const events: unknown[] = [];
  const v = createVoice({
    ctor: FakeRec as never, dispatch, now: () => t, queryMic: async () => 'granted',
    onEvent: (e) => events.push(e), ...over,
  });
  return { v, dispatch, events };
}
const on = async (v: ReturnType<typeof createVoice>) => { await v.enable({ privacyAcknowledged: true }); };

beforeEach(() => { vi.useFakeTimers(); t = 0; FakeRec.instances = []; FakeRec.availability = 'available'; FakeRec.available.mockClear(); FakeRec.install.mockClear(); });
afterEach(() => vi.useRealTimers());

describe('detection and enable flow', () => {
  it('detects unsupported', () => {
    expect(detectVoice({}).supported).toBe(false);
    expect(detectVoice({ webkitSpeechRecognition: FakeRec }).supported).toBe(true);
    expect(detectVoice({ SpeechRecognition: FakeRec }).prefixed).toBe(false);
  });
  it('unsupported status and enable does nothing', async () => {
    const { v } = setup({ ctor: null });
    expect(v.status).toBe('unsupported');
    expect(await v.enable({ privacyAcknowledged: true })).toEqual({ ok: false, reason: 'unsupported' });
  });
  it('refuses to start without privacy acknowledgement', async () => {
    const { v } = setup();
    expect(await v.enable({ privacyAcknowledged: false })).toEqual({ ok: false, reason: 'privacy-not-acknowledged' });
    expect(FakeRec.instances.length).toBe(0);
    expect(v.status).toBe('idle');
  });
  it('denied permission status without starting', async () => {
    const { v } = setup({ queryMic: async () => 'denied' });
    expect(await v.enable({ privacyAcknowledged: true })).toEqual({ ok: false, reason: 'denied' });
    expect(v.status).toBe('denied');
  });
  it('listening after start; configured continuous, final-only grammar', async () => {
    const { v } = setup();
    await on(v);
    expect(v.status).toBe('listening');
    expect(rec().continuous).toBe(true);
    expect(rec().maxAlternatives).toBe(1);
  });
  it('requests on-device only when available() says available', async () => {
    class Local extends FakeRec { processLocally = false; }
    const { v } = setup({ ctor: Local });
    await on(v);
    expect(Local.available).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
    expect(v.onDevice).toBe('available');
    expect((rec() as Local).processLocally).toBe(true);
    expect(v.locality).toBe('on-device-requested');
  });
  it('uses the cloud default when on-device is not available or the API is missing', async () => {
    class Local extends FakeRec { processLocally = false; }
    FakeRec.availability = 'downloadable';
    const a = setup({ ctor: Local });
    await on(a.v);
    expect(a.v.onDevice).toBe('downloadable');
    expect((rec() as Local).processLocally).toBe(false);
    expect(a.v.locality).toBe('browser-default');
    class NoApi extends FakeRec { static override available = undefined as never; static override install = undefined as never; processLocally = false; }
    const b = setup({ ctor: NoApi });
    await on(b.v);
    expect(b.v.onDevice).toBe('unknown');
    expect((rec() as Local).processLocally).toBe(false);
  });
  it('install() runs on the static API from a gesture and re-checks availability', async () => {
    FakeRec.availability = 'downloadable';
    const { v } = setup();
    await v.refreshOnDevice();
    expect(v.onDevice).toBe('downloadable');
    expect(await v.installOnDevice()).toBe(true);
    expect(FakeRec.install).toHaveBeenCalledWith({ langs: ['en-US'], processLocally: true });
    expect(v.onDevice).toBe('available');
  });
  it('falls back to default engine when on-device language is unavailable', async () => {
    class Local extends FakeRec { processLocally = false; }
    const { v } = setup({ ctor: Local });
    await on(v);
    rec().onerror?.({ error: 'language-not-supported' });
    vi.advanceTimersByTime(1000);
    expect(v.locality).toBe('browser-default');
    expect((rec() as Local).processLocally).toBe(false);
    expect(v.status).toBe('listening');
  });
  it('maps recognition errors to statuses and does not restart on fatal ones', async () => {
    for (const [err, status] of [['not-allowed', 'denied'], ['service-not-allowed', 'denied'], ['network', 'network'], ['audio-capture', 'error']] as const) {
      FakeRec.instances = [];
      const { v } = setup();
      await on(v);
      rec().onerror?.({ error: err });
      rec().onend?.();
      vi.advanceTimersByTime(5000);
      expect(v.status).toBe(status);
      expect(rec().starts).toBe(1);
    }
  });
  it('no-speech is benign', async () => {
    const { v } = setup();
    await on(v);
    rec().onerror?.({ error: 'no-speech' });
    expect(v.status).toBe('listening');
  });
  it('restarts after end while enabled, not after disable', async () => {
    const { v } = setup();
    await on(v);
    rec().onend?.();
    vi.advanceTimersByTime(1000);
    expect(rec().starts).toBe(2);
    v.disable();
    rec().onend?.();
    vi.advanceTimersByTime(5000);
    expect(rec().starts).toBe(2);
    expect(v.status).toBe('idle');
  });
  it('backs off exponentially (cap 5 s) on repeated ends and resets after a result', async () => {
    const { v } = setup();
    await on(v);
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const before = rec().starts;
      rec().onend?.();
      let d = 0;
      while (rec().starts === before && d < 6000) { vi.advanceTimersByTime(50); d += 50; }
      delays.push(d);
    }
    expect(delays).toEqual([300, 600, 1200, 2400, 4800, 5000, 5000]);
    rec().say('pause');
    const before = rec().starts;
    rec().onend?.();
    vi.advanceTimersByTime(300);
    expect(rec().starts).toBe(before + 1);
  });
  it('notifies subscribers on status change', async () => {
    const { v } = setup();
    const cb = vi.fn(); v.subscribe(cb);
    await on(v);
    expect(cb).toHaveBeenCalled();
  });
});

describe('lifecycle', () => {
  it('late results from a disabled or replaced recognizer never dispatch', async () => {
    const { v, dispatch } = setup();
    await on(v);
    const old = rec();
    v.disable();
    old.say('skip');
    expect(dispatch).not.toHaveBeenCalled();
    await on(v);
    expect(FakeRec.instances.length).toBe(2);
    old.say('skip'); // old instance, enabled again
    expect(dispatch).not.toHaveBeenCalled();
    rec().say('skip');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it('recreates the recognizer when on-device becomes available between enables', async () => {
    class Local extends FakeRec { processLocally = false; }
    FakeRec.availability = 'downloadable';
    const { v } = setup({ ctor: Local });
    await on(v);
    const cloud = rec() as Local;
    expect(cloud.processLocally).toBe(false);
    v.disable();
    FakeRec.availability = 'available';
    await on(v);
    expect(rec()).not.toBe(cloud);
    expect((rec() as Local).processLocally).toBe(true);
  });
});

describe('disable during pending enable', () => {
  it('during the permission query', async () => {
    let release!: (s: 'granted') => void;
    const { v } = setup({ queryMic: () => new Promise((r) => { release = r as never; }) });
    const p = v.enable({ privacyAcknowledged: true });
    v.disable();
    release('granted');
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(v.status).toBe('idle');
    expect(FakeRec.instances.length).toBe(0);
  });
  it('during the availability check', async () => {
    let release!: (s: string) => void;
    class Slow extends FakeRec { static override available = (() => new Promise<string>((r) => { release = r; })) as never; }
    const { v } = setup({ ctor: Slow });
    const p = v.enable({ privacyAcknowledged: true });
    await Promise.resolve(); await Promise.resolve();
    v.disable();
    release('available');
    expect(await p).toEqual({ ok: false, reason: 'cancelled' });
    expect(v.status).toBe('idle');
    expect(FakeRec.instances.length).toBe(0);
  });
});

describe('on-device probing', () => {
  it('never calls available()/install() until enable or an explicit refresh', () => {
    setup();
    expect(FakeRec.available).not.toHaveBeenCalled();
    expect(FakeRec.install).not.toHaveBeenCalled();
  });
  it('a throwing available() yields unknown (cloud warning), not a crash', async () => {
    class Boom extends FakeRec { static override available = (() => { throw new Error('x'); }) as never; }
    const { v } = setup({ ctor: Boom });
    expect(await v.refreshOnDevice()).toBe('unknown');
    await on(v);
    expect(v.status).toBe('listening');
  });
});

describe('grammar', () => {
  it('maps the fixed vocabulary', () => {
    expect(parseCommand('Start.')).toBe('start');
    expect(parseCommand(' done ')).toBe('complete');
    expect(parseCommand('skip round')).toBe('skip');
    expect(parseCommand('Resume')).toBe('resume');
    expect(parseCommand('pause')).toBe('pause');
    expect(parseCommand('stop')).toBe('stop');
  });
  it('rejects anything else, including sentences containing a command', () => {
    expect(parseCommand('please do not stop now')).toBeNull();
    expect(parseCommand('stop the music')).toBeNull();
    expect(parseCommand('')).toBeNull();
  });
});

describe('results', () => {
  it('dispatches a confident final command with source voice', async () => {
    const { v, dispatch } = setup();
    await on(v);
    rec().say('skip');
    expect(dispatch).toHaveBeenCalledWith('skip', 'voice');
    rec().say('done');
    expect(dispatch).toHaveBeenCalledWith('complete', 'voice');
  });
  it('skip is never turned into complete', async () => {
    const { v, dispatch } = setup();
    await on(v);
    rec().say('skip');
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['skip']);
  });
  it('ignores low confidence, interim and unknown', async () => {
    const { v, dispatch, events } = setup();
    await on(v);
    rec().say('pause', 0.69);
    rec().say('pause', 0.99, false);
    rec().say('banana', 0.99);
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'ignored', reason: 'low-confidence' }));
  });
  it('threshold applies only when the engine reports confidence > 0', async () => {
    const { v, dispatch } = setup();
    await on(v);
    rec().say('pause', 0);
    rec().onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'resume' }], { isFinal: true })] } as never);
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['pause', 'resume']);
  });
  it('stop still needs confirmation when confidence is missing', async () => {
    const { v, dispatch } = setup();
    await on(v);
    rec().say('stop', 0);
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('stop needs confirmation: second stop or a confirm word within the window', async () => {
    const { v, dispatch, events } = setup();
    await on(v);
    rec().say('stop');
    expect(dispatch).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({ type: 'confirm-needed' }));
    t = 2000;
    rec().say('stop');
    expect(dispatch).toHaveBeenCalledWith('stop', 'voice');
    dispatch.mockClear();
    t = 10000;
    rec().say('stop');
    t = 12000;
    rec().say('confirm');
    expect(dispatch).toHaveBeenCalledWith('stop', 'voice');
  });
  it('stop confirmation expires; confirm word alone does nothing; other command cancels pending', async () => {
    const { v, dispatch } = setup();
    await on(v);
    rec().say('confirm');
    rec().say('stop');
    t = 9000; // > 8 s window
    rec().say('stop');
    expect(dispatch).not.toHaveBeenCalled(); // second one only re-arms
    rec().say('pause');
    rec().say('confirm');
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual(['pause']);
  });
});

describe('suppression while the app speaks', () => {
  it('ignores results while suppressed and for the tail after release, then resumes', async () => {
    const { v, dispatch } = setup();
    await on(v);
    v.suppress();
    expect(rec().aborts).toBe(1); // in-flight audio is discarded
    rec().say('stop'); rec().say('skip');
    t = 100;
    v.release();
    t = 500;
    rec().say('skip');
    expect(dispatch).not.toHaveBeenCalled();
    t = 1200; // tail 1000 ms after release at t=100
    vi.advanceTimersByTime(1100);
    rec().say('skip');
    expect(dispatch).toHaveBeenCalledWith('skip', 'voice');
  });
  it('does not restart recognition during suppression', async () => {
    const { v } = setup();
    await on(v);
    v.suppress();
    vi.advanceTimersByTime(5000);
    expect(rec().starts).toBe(1);
    v.release();
    vi.advanceTimersByTime(1100);
    expect(rec().starts).toBe(2);
  });
  it('app speech (announcer) never issues commands, even saying a command word', async () => {
    const spoken: UtteranceLike[] = [];
    const synth = { speaking: false, speak: (u: UtteranceLike) => { spoken.push(u); }, cancel: () => {}, getVoices: () => [] };
    const a = createAnnouncer({ synth, createUtterance: (text) => ({ text, rate: 1, voice: null, onstart: null, onend: null, onerror: null }) });
    const { v, dispatch } = setup();
    await on(v);
    a.onStart(() => v.suppress());
    a.onEnd(() => v.release());
    a.say('Say stop again to confirm.');
    rec().say('stop'); // engine heard the TTS
    spoken[0]!.onend?.();
    rec().say('stop');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
