// Phase 3 glue: input frames -> Go session (via sessionBridge) -> audio, speech and commands.
// No session state lives here: every decision reads the bridge snapshot (the Go core is the
// source of truth). The only local memory is the latest frame, a "loss already reported" flag
// and an outcome tally used for the spoken session summary.
import type { Axis, InputFrame } from '../../input/types';
import type { SessionBridge, SessionConfig, SessionEvent, SessionResults, SessionState, Snapshot, Command as CoreCommand, Outcome } from '../../wasm/sessionBridge';
import { summaryText } from '../results/summaryText';
import type { AudioAlert, AudioScene } from '../../audio/sonify/types';
import type { Announcer } from '../../audio/speech/announcer';
import * as say from '../../audio/speech/phrases';
import { createDispatcher, type Command } from '../../controls/dispatcher';
import { commandFailed } from '../../app/recovery';

/** results is optional: without it spoken feedback falls back to the short outcome cues. */
export type RunnerBridge = Pick<SessionBridge, 'pushFrame' | 'command' | 'start' | 'getSnapshot' | 'subscribe'> & { results?: () => SessionResults };
export type RunnerSonify = { update(s: AudioScene): void; alert(a: AudioAlert): void; duck(on: boolean): void; silence(): void };
export type RunnerAnnouncer = Pick<Announcer, 'say' | 'onStart' | 'onEnd'>;
export type RunnerVoice = { suppress(): void; release(): void };
export type AudioChoice = 'dual' | 'deviation';
/** What the setup UI hands over. availableAxes is filled in at start from the live source. */
export type Setup = {
  name: string;
  config: SessionConfig extends infer C ? (C extends unknown ? Omit<C, 'availableAxes'> : never) : never;
  audioMode: AudioChoice;
  /** Spoken performance summaries (round + session) from the core metrics; default on. Announcer category toggles still apply. */
  spokenFeedback?: boolean;
};

export type RunnerOptions = {
  bridge: RunnerBridge;
  sonify: RunnerSonify;
  announcer: RunnerAnnouncer;
  voice?: RunnerVoice;
  now?: () => number;
  /** A source silent for longer than this is lost (matches App's display expiry). */
  staleMs?: number;
  /** Test/diagnostic tap: every alert and issued phrase. */
  trace?: (t: { alert: AudioAlert } | { say: string } | { event: SessionEvent }) => void;
};

const AXES: Axis[] = ['brake', 'steering', 'throttle'];
/** Consecutive good frames needed before sourceRestored (debounces a flapping source). */
const RESTORE_FRAMES = 3;
const RUNNING: SessionState[] = ['COUNTDOWN', 'ACTIVE', 'REST', 'PAUSED'];
const SOUNDING: SessionState[] = ['COUNTDOWN', 'ACTIVE', 'REST'];
const CORE: Record<Command, CoreCommand> = { start: 'start', pause: 'pause', resume: 'resume', complete: 'completeRound', skip: 'skipRound', stop: 'stop' };
const ALLOWED: Record<Command, SessionState[]> = {
  start: ['IDLE', 'PREPARE', 'COMPLETE', 'ABORTED'],
  pause: ['COUNTDOWN', 'ACTIVE', 'REST'],
  resume: ['PAUSED'],
  complete: ['ACTIVE'], // the core still rejects it for timed rounds -> spoken feedback
  skip: ['COUNTDOWN', 'ACTIVE'],
  stop: ['PREPARE', 'COUNTDOWN', 'ACTIVE', 'REST', 'PAUSED', 'SOURCE_LOST'],
};
const OUTCOME: Record<Outcome, 'complete' | 'skipped' | 'invalid' | null> = {
  completedTimed: 'complete', completedAuto: 'complete', completedManual: 'complete', skipped: 'skipped', invalidSourceLost: 'invalid', aborted: null,
};

export function createSessionRunner(o: RunnerOptions) {
  const { bridge, sonify, announcer, voice } = o;
  const now = o.now ?? (() => performance.now());
  const staleMs = o.staleMs ?? 250;
  let setup: Setup | null = null;
  let latest: InputFrame | null = null;
  let lossSent = false;
  let goodStreak = 0;
  let sounding = true;
  let tally = { completed: 0, skipped: 0, invalid: 0 };

  const speak = (text: string, opt?: Parameters<RunnerAnnouncer['say']>[1]) => {
    if (announcer.say(text, opt)) o.trace?.({ say: text });
  };
  const alert = (a: AudioAlert) => {
    sonify.alert(a);
    o.trace?.({ alert: a });
  };

  const offs: (() => unknown)[] = [
    announcer.onStart(() => { sonify.duck(true); voice?.suppress(); }),
    announcer.onEnd(() => { sonify.duck(false); voice?.release(); }),
  ];

  const value = (f: InputFrame | null, a: Axis) => (f && f[a].available ? f[a].normalized : null);
  // A gap or stale frame is never live input (the core invalidates the attempt on it).
  const usable = (f: InputFrame) => !f.quality.stale && !f.quality.gap;
  const fresh = () => (latest && now() - latest.receivedMonoMs <= staleMs && usable(latest) ? latest : null);
  const complete = (f: InputFrame | null) => !!f && (bridge.getSnapshot().controls ?? []).every((a) => value(f, a) !== null);

  function onEvent(e: SessionEvent, s: Snapshot) {
    o.trace?.({ event: e });
    switch (e.kind) {
      case 'overlapOnset': return alert({ kind: 'overlap', atMs: e.atMs }); // audio only, never spoken
      case 'fluctuation': return alert({ kind: 'fluctuation', atMs: e.atMs });
      case 'countdown': return speak(say.countdown(e.remaining), { category: 'countdown', interrupt: true });
      case 'roundStarted':
        alert({ kind: 'round-start', atMs: e.atMs });
        return speak(say.countdown(0), { category: 'countdown', interrupt: true });
      case 'roundEnded': {
        const out = OUTCOME[e.outcome];
        if (!out) return;
        tally[out === 'complete' ? 'completed' : out]++;
        alert({ kind: 'round-end', atMs: e.atMs });
        const res = feedback();
        return speak(res ? summaryText(res, e.round) : say.round({ n: e.round, outcome: out, reason: out === 'invalid' ? 'source lost' : undefined }), { category: 'roundSummary' });
      }
      case 'sessionComplete': {
        alert({ kind: 'session-complete', atMs: e.atMs });
        const res = feedback();
        return speak(res ? summaryText(res) : say.sessionComplete({ total: s.rounds, ...tally }), { category: 'sessionSummary' });
      }
      case 'stateChanged':
        if (e.to === 'SOURCE_LOST') {
          goodStreak = 0; // only frames arriving after the loss may restore it
          alert({ kind: 'source-lost', atMs: e.atMs });
          speak(say.sourceLost(), { priority: 'critical' });
        } else if (e.from === 'SOURCE_LOST' && e.to !== 'ABORTED') speak(say.sourceRestored(), { priority: 'critical' });
        else if (e.to === 'ABORTED') speak('Session stopped.', { priority: 'critical' });
        return;
      default: return; // primaryChanged: the planner follows snapshot.primary
    }
  }

  /** Core results for spoken performance feedback, or null when it is off/unavailable. */
  function feedback(): SessionResults | null {
    if (setup?.spokenFeedback === false || !bridge.results) return null;
    try {
      const r = bridge.results();
      return r.error ? null : r;
    } catch {
      return null;
    }
  }

  function scene(s: Snapshot, f: InputFrame | null): AudioScene {
    const sel = s.controls ?? [];
    const actual = Object.fromEntries(AXES.map((a) => [a, sel.includes(a) ? value(f, a) : null])) as AudioScene['actual'];
    const base = { primary: s.primary ?? null, actual, nowMs: f?.receivedMonoMs ?? now() };
    if (s.mode !== 'guided') return { ...base, mode: 'freeform' };
    if (s.selfPaced) return { ...base, mode: 'guided-selfpaced', terminal: s.terminalTargets };
    return { ...base, mode: setup?.audioMode === 'deviation' ? 'guided-deviation' : 'guided-dual', desired: s.target?.values, tolerance: s.tolerance };
  }

  function onStep({ events, snapshot: s }: { events: SessionEvent[]; snapshot: Snapshot }) {
    for (const e of events) onEvent(e, s);
    const f = fresh();
    if (SOUNDING.includes(s.state)) {
      sounding = true;
      sonify.update(scene(s, f));
    } else if (sounding) {
      sounding = false;
      sonify.silence();
    }
    // Source safety (spec 4.4): the core invalidates an ACTIVE attempt on bad frames by itself;
    // here we also cover silence (no frames) and non-ACTIVE states, and report recovery.
    const ok = complete(f);
    if (!ok && RUNNING.includes(s.state) && !lossSent) {
      lossSent = true;
      bridge.command('sourceLost');
    } else if (ok) {
      lossSent = false;
      if (s.state === 'SOURCE_LOST' && goodStreak >= RESTORE_FRAMES) bridge.command('sourceRestored');
    }
  }
  offs.push(bridge.subscribe(onStep));

  function prepare() {
    if (!setup) throw new Error('no session set up');
    const f = fresh();
    if (!f) throw new Error('no live input source');
    const availableAxes = AXES.filter((a) => value(f, a) !== null);
    const r = bridge.start({ ...setup.config, availableAxes } as SessionConfig);
    if (r.error) throw new Error(r.error);
    tally = { completed: 0, skipped: 0, invalid: 0 };
    lossSent = false;
    const c = setup.config;
    const rounds = 'drill' in c ? c.drill.rounds : c.session?.rounds;
    const restMs = 'drill' in c ? c.drill.restMs : c.session?.restMs;
    speak(say.exercise({ name: setup.name, rounds, restSec: restMs === undefined ? undefined : Math.round(restMs / 1000) }), { category: 'instructions' });
  }

  // Start needs a valid, settled setup (configure(null) while the drill is invalid or validation is pending).
  const allowed = (cmd: Command) => ALLOWED[cmd].includes(bridge.getSnapshot().state) && (cmd !== 'start' || setup !== null);
  let lastError = '';
  const dispatcher = createDispatcher({
    allowed,
    now,
    sink: (cmd) => {
      lastError = '';
      try {
        if (cmd === 'start' && bridge.getSnapshot().state !== 'PREPARE') prepare();
        const r = bridge.command(CORE[cmd]);
        if (r.error) throw new Error(r.error);
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
        throw e;
      }
    },
    onReject: (cmd, _src, reason) => speak(reason === 'sink-error' ? commandFailed(cmd, lastError) : say.commandRejected(cmd), { category: 'alerts' }),
  });

  return {
    dispatcher,
    allowed,
    get lastError() { return lastError; },
    /** null = no valid setup right now (invalid or still validating): start is refused aloud. */
    configure(s: Setup | null) { setup = s; },
    /** Every frame from the active source, unfiltered (unavailable/stale included). */
    pushFrame(f: InputFrame) {
      latest = f;
      goodStreak = usable(f) && complete(f) ? goodStreak + 1 : 0;
      bridge.pushFrame(f);
    },
    getSnapshot: () => bridge.getSnapshot(),
    dispose() { offs.forEach((f) => f()); },
  };
}
export type SessionRunner = ReturnType<typeof createSessionRunner>;
