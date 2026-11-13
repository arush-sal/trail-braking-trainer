import type { Command, CommandSource, DispatchResult } from './dispatcher';

/** Structural subset of the Web Speech SpeechRecognition so tests can inject fakes. */
export type RecognitionLike = {
  continuous: boolean; interimResults: boolean; lang: string; maxAlternatives: number; processLocally?: boolean;
  onstart: (() => void) | null; onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onresult: ((e: never) => void) | null;
  start(): void; stop(): void; abort(): void;
};
export type OnDevice = 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unknown';
export type RecognitionCtor = {
  new (): RecognitionLike;
  available?: (o: { langs: string[]; processLocally: boolean }) => Promise<string>;
  install?: (o: { langs: string[]; processLocally: boolean }) => Promise<boolean>;
};
type ResultEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }>;
};

export type VoiceStatus = 'idle' | 'listening' | 'denied' | 'unsupported' | 'error' | 'network';
export type Locality = 'on-device-requested' | 'browser-default';
export type VoiceEvent =
  | { type: 'dispatched'; command: Command; transcript: string; result: DispatchResult }
  | { type: 'confirm-needed'; command: 'stop'; transcript: string }
  | { type: 'ignored'; reason: 'low-confidence' | 'unknown' | 'suppressed'; transcript: string };

/** Fixed vocabulary; the whole utterance must match (no command-in-a-sentence). */
export const GRAMMAR: Record<string, Command> = {
  start: 'start', pause: 'pause', resume: 'resume', continue: 'resume',
  done: 'complete', complete: 'complete', 'complete round': 'complete',
  skip: 'skip', 'skip round': 'skip', stop: 'stop', 'stop session': 'stop',
};
const CONFIRM = new Set(['confirm', 'yes']);
export const parseCommand = (s: string): Command | null =>
  GRAMMAR[s.toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim()] ?? null;

export function detectVoice(w: { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown } = globalThis as never) {
  const std = w.SpeechRecognition as RecognitionCtor | undefined;
  const ctor = std ?? (w.webkitSpeechRecognition as RecognitionCtor | undefined) ?? null;
  return { supported: !!ctor, ctor, prefixed: !std && !!ctor };
}

const DEFAULTS = {
  /**
   * Proposed. Applied only when the engine reports confidence > 0: 0/missing means "not reported"
   * (Safari and others), where the strict grammar and stop confirmation are the safety net.
   */
  minConfidence: 0.7,
  /** Ignore results this long after the app stops speaking (TTS echo / recognition latency). */
  tailMs: 1000,
  /** "stop" must be repeated (or followed by "confirm"/"yes") within this window. */
  confirmWindowMs: 8000,
  restartDelayMs: 300,
  /** Cap for exponential restart backoff (Chrome ends sessions on its own). */
  maxRestartDelayMs: 5000,
};

export type VoiceOptions = Partial<typeof DEFAULTS> & {
  /** undefined = detect browser ctor; null = unsupported. */
  ctor?: RecognitionCtor | null;
  dispatch: (cmd: Command, source: CommandSource) => DispatchResult;
  now?: () => number;
  lang?: string;
  /** Microphone permission query; default uses navigator.permissions when available. */
  queryMic?: () => Promise<'granted' | 'denied' | 'prompt' | 'unknown'>;
  onEvent?: (e: VoiceEvent) => void;
};

const defaultQueryMic: NonNullable<VoiceOptions['queryMic']> = async () => {
  try {
    const p = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return p.state;
  } catch {
    return 'unknown';
  }
};

export function createVoice(o: VoiceOptions) {
  const cfg = { ...DEFAULTS, ...o };
  const Ctor = o.ctor !== undefined ? o.ctor : detectVoice().ctor;
  const now = o.now ?? (() => performance.now());
  const queryMic = o.queryMic ?? defaultQueryMic;
  const subs = new Set<() => void>();
  let status: VoiceStatus = Ctor ? 'idle' : 'unsupported';
  let locality: Locality = 'browser-default';
  let wanted = false;
  let suppressed = false;
  let suppressUntil = 0;
  let pendingStopAt: number | null = null;
  let rec: RecognitionLike | null = null;
  let recLocal = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let preferLocal = true;
  let onDevice: OnDevice = 'unknown';
  let backoff = 0;
  let gen = 0; // bumped by disable(); in-flight enable() calls abort when it changes
  const lang = o.lang ?? 'en-US';

  const setStatus = (s: VoiceStatus) => { if (s !== status) { status = s; for (const cb of [...subs]) cb(); } };
  const emit = (e: VoiceEvent) => o.onEvent?.(e);
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  const later = (ms: number) => { clear(); timer = setTimeout(() => { timer = null; begin(); }, ms); };

  function begin() {
    if (!Ctor || !wanted || suppressed) return;
    if (!rec) rec = create(Ctor);
    try { rec.start(); } catch { /* already started (InvalidStateError) */ }
  }

  function fatal(s: VoiceStatus) { wanted = false; clear(); setStatus(s); }

  function create(C: RecognitionCtor): RecognitionLike {
    const r = new C();
    r.continuous = true;
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.lang = lang;
    // On-device only when available() confirmed the pack; otherwise the browser default (possibly cloud) is used.
    if ('processLocally' in r && preferLocal && onDevice === 'available') { r.processLocally = true; locality = 'on-device-requested'; } else locality = 'browser-default';
    recLocal = r.processLocally === true;
    // Handlers of a disabled/replaced recognizer (late events) are ignored: only the current instance acts.
    const live = () => rec === r && wanted;
    r.onstart = () => { if (live()) setStatus('listening'); };
    r.onend = () => {
      if (!live() || suppressed) return;
      const delay = Math.min(cfg.maxRestartDelayMs, cfg.restartDelayMs * 2 ** backoff);
      backoff++;
      later(Math.max(delay, suppressUntil - now()));
    };
    r.onerror = (e) => {
      if (!live()) return;
      switch (e.error) {
        case 'not-allowed': case 'service-not-allowed': fatal('denied'); break;
        case 'network': fatal('network'); break;
        case 'language-not-supported':
          if (preferLocal && 'processLocally' in r) { preferLocal = false; rec = null; later(cfg.restartDelayMs); } else fatal('error');
          break;
        case 'no-speech': case 'aborted': break;
        default: fatal('error');
      }
    };
    r.onresult = (ev) => { if (live()) onResult(ev as unknown as ResultEvent); };
    return r;
  }

  function onResult(ev: ResultEvent) {
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i]!;
      if (!res.isFinal) continue;
      backoff = 0;
      const { transcript, confidence } = res[0];
      const t = now();
      if (suppressed || t < suppressUntil) { emit({ type: 'ignored', reason: 'suppressed', transcript }); continue; }
      if (confidence > 0 && confidence < cfg.minConfidence) { emit({ type: 'ignored', reason: 'low-confidence', transcript }); continue; }
      const words = transcript.toLowerCase().replace(/[^a-z ]/g, ' ').trim();
      const cmd = parseCommand(transcript);
      const armed = pendingStopAt !== null && t - pendingStopAt <= cfg.confirmWindowMs;
      if (CONFIRM.has(words)) {
        pendingStopAt = null;
        if (armed) emit({ type: 'dispatched', command: 'stop', transcript, result: o.dispatch('stop', 'voice') });
        else emit({ type: 'ignored', reason: 'unknown', transcript });
        continue;
      }
      if (!cmd) { emit({ type: 'ignored', reason: 'unknown', transcript }); continue; }
      if (cmd === 'stop') {
        if (armed) { pendingStopAt = null; emit({ type: 'dispatched', command: 'stop', transcript, result: o.dispatch('stop', 'voice') }); } else {
          pendingStopAt = t;
          emit({ type: 'confirm-needed', command: 'stop', transcript });
        }
        continue;
      }
      pendingStopAt = null;
      emit({ type: 'dispatched', command: cmd, transcript, result: o.dispatch(cmd, 'voice') });
    }
  }

  async function refreshOnDevice(): Promise<OnDevice> {
    // Only ever called from a user gesture: available() crashed headless Chromium (see docs/validation-log.md).
    let next: OnDevice = 'unknown';
    try {
      const s = Ctor?.available ? await Ctor.available({ langs: [lang], processLocally: true }) : 'unknown';
      if (['available', 'downloadable', 'downloading', 'unavailable'].includes(s)) next = s as OnDevice;
    } catch { /* stays unknown */ }
    if (next !== onDevice) { onDevice = next; for (const cb of [...subs]) cb(); }
    return onDevice;
  }

  return {
    get onDevice() { return onDevice; },
    refreshOnDevice,
    /** Call from a user gesture (click). Downloads the on-device language pack, then re-checks. */
    async installOnDevice(): Promise<boolean> {
      if (!Ctor?.install) return false;
      const ok = await Ctor.install({ langs: [lang], processLocally: true }).catch(() => false);
      await refreshOnDevice();
      return ok;
    },
    get status() { return status; },
    get locality() { return locality; },
    get supported() { return !!Ctor; },
    get suppressed() { return suppressed; },
    subscribe(cb: () => void) { subs.add(cb); return () => subs.delete(cb); },

    /** Call only after the privacy notice has been shown; the flag records that acknowledgement. */
    async enable(opt: { privacyAcknowledged: boolean }): Promise<{ ok: true } | { ok: false; reason: 'unsupported' | 'privacy-not-acknowledged' | 'denied' | 'cancelled' }> {
      if (!Ctor) return { ok: false, reason: 'unsupported' };
      if (!opt.privacyAcknowledged) return { ok: false, reason: 'privacy-not-acknowledged' };
      const g = gen;
      const perm = await queryMic();
      if (g !== gen) return { ok: false, reason: 'cancelled' };
      if (perm === 'denied') { setStatus('denied'); return { ok: false, reason: 'denied' }; }
      await refreshOnDevice();
      if (g !== gen) return { ok: false, reason: 'cancelled' };
      // Recreate the recognizer if the on-device decision changed since it was built.
      if (rec && recLocal !== (preferLocal && onDevice === 'available' && 'processLocally' in rec)) rec = null;
      wanted = true;
      backoff = 0;
      begin();
      return { ok: true };
    },
    disable() {
      gen++;
      wanted = false;
      pendingStopAt = null;
      clear();
      const old = rec;
      rec = null; // late events from `old` fail the identity check
      try { old?.abort(); } catch { /* ignore */ }
      if (Ctor) setStatus('idle');
    },
    /** App started speaking: drop in-flight audio and ignore results until release() + tail. */
    suppress() {
      suppressed = true;
      suppressUntil = Infinity;
      clear();
      try { rec?.abort(); } catch { /* ignore */ }
    },
    release() {
      if (!suppressed) return;
      suppressed = false;
      suppressUntil = now() + cfg.tailMs;
      if (wanted) later(cfg.tailMs);
    },
  };
}
export type Voice = ReturnType<typeof createVoice>;
